// Deterministic town simulation. Everyone, player included, follows the same rules:
// move by real schedules → chat when co-located → both judge (speed-dating model) → date → maybe hook up.
import attractionJson from "../../data/attraction.json" with { type: "json" };
import breakupsJson from "../../data/breakups.json" with { type: "json" };
import { type Agent, type Place, type Rng, type Sex, type Status, type World, DAYTYPES, PLACES, gauss, rng } from "./world.ts";

export interface Tuning {
  chat: number;          // multiplier on per-venue chat rates
  hookupNight: number;   // same-night hookup after a late spark at a bar/party, × mutual desire
  hookupDate: number;    // hookup after a date, × mutual desire
  appSwipes: number;     // profiles an app user judges per day
  couple: number;        // chance two singles become a couple after hooking up
  openPartnered: number; // how available someone in a relationship is (multiplies their yes)
  openMarried: number;
  agePenalty: number;    // extra logit penalty per (age gap / 10)^2; speed dating only saw ages 18-55
  declineFemale: number; // interest in dating falls by exp(-decline) per decade past 30 (GSS: most single 65+ have no partner)
  declineMale: number;
}

export type EventType = "spark" | "rejected" | "match" | "date" | "stood_up" | "hookup" | "couple" | "breakup" | "gossip";
export interface SimEvent { tick: number; type: EventType; a: number; b: number; venue: number; about?: number }
export const eventKey = (e: SimEvent) => `${e.tick}:${e.type}:${e.a}:${e.b}`;

export interface SimOptions {
  days: number; seed: number;
  startWeekday?: number; // 0 = Monday
  focus?: number;        // record events involving this agent (the player); omit for none
  recordAll?: boolean;   // record every event (debugging)
  trackLocations?: boolean;
  affinity?: Affinity;   // persona-specific nudges for judgments involving the player (from Jev)
}

// Logit offsets, zero-mean across the town so calibrated rates hold; only judgments involving `agent` use them.
export interface Affinity { agent: number; toward: number[]; from: number[] } // toward[i]: i judging agent; from[i]: agent judging i

export interface SimResult {
  partners: number[][]; // distinct partners per agent during the run (in town; a starting partner lives elsewhere)
  status: Status[];     // relationship status when the run ends
  events: SimEvent[];
  locations?: Uint16Array; // [tick * agents + agent] = venue id
}

export const SLOTS = 48; // 30-minute slots starting 04:00
const DATE_SLOT = 30, DATE_LEN = 4, LATE_SLOT = 36, APP_SLOT = 36, MORNING_SLOT = 10; // 19:00, 2h, 22:00, 22:00, 09:00
const PERCEPTION_SD = 1; // strangers misjudge you by about a point
const ANOTHER_DATE = 0.6;
// HCMST: dating couples split fast at first, slower after six months; couples already together when the run starts
// (partner out of town, unknown duration) at the all-durations rate. Married couples don't split (1.5%/yr; ponytail).
const SPLIT_EARLY = breakupsJson.new_couple_first_6_months.per_year / 365, SPLIT_LATER = breakupsJson.new_couple_6_to_24_months.per_year / 365;
const SPLIT_ESTABLISHED = breakupsJson.unmarried_any_duration.per_year / 365, EARLY_DAYS = 182;
const GOSSIP_PENALTY = 0.7; // logit hit for someone who just slept with your friend
// ponytail: relative chat rates per 30 min are a judgment call; tuning.chat scales them all to fit GSS.
const CHAT_RATE: Partial<Record<Place, number>> = {
  restaurant_bar: 0.5, friends_home: 0.5, gym: 0.1, work: 0.08, school: 0.15, store: 0.02, outdoors: 0.05,
  worship: 0.05, other: 0.03,
};
const NIGHT_HOOKUP_PLACES = new Set<Place>(["restaurant_bar", "friends_home"]);

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const popcount = (n: number) => { let c = 0; while (n) { n &= n - 1; c++; } return c; };
export const attracted = (a: Agent, sex: Sex) => a.orientation === "bisexual" || (a.orientation === "gay") === (a.sex === sex);
export const compatible = (a: Agent, b: Agent) => attracted(a, b.sex) && attracted(b, a.sex);

interface Pair { met: boolean; m: number; dates: number }
type Action = { kind: "date" | "dateEnd"; a: number; b: number; venue: number };

export function simulate(world: World, tuning: Tuning, opts: SimOptions): SimResult {
  const { agents, venues, circles, hangouts } = world;
  const N = agents.length, P = PLACES.length, r: Rng = rng(opts.seed);
  const startWeekday = opts.startWeekday ?? 0;
  const model = attractionJson.by_chooser;
  const aff = opts.affinity;

  // Shared-interest rating: interest overlap rescaled to the speed-dating "shar" distribution.
  const overlap = (a: Agent, b: Agent) => popcount(a.interests & b.interests) / Math.max(1, Math.min(popcount(a.interests), popcount(b.interests)));
  const samples = Array.from({ length: 2000 }, (_, k) => overlap(agents[(k * 7919) % N], agents[(k * 104729 + 1) % N]));
  const ovMean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const ovSd = Math.sqrt(samples.reduce((s, v) => s + (v - ovMean) ** 2, 0) / samples.length) || 1;

  const status = agents.map(a => a.status);
  const partnerOf = new Int32Array(N).fill(-1), coupledOn = new Int32Array(N); // day the couple formed
  const seeking = agents.map(a => Math.exp(-(a.sex === "female" ? tuning.declineFemale : tuning.declineMale) * Math.max(0, a.age - 30) / 10));
  const openness = (i: number) => seeking[i] * (status[i] === "single" ? 1 : status[i] === "married" ? tuning.openMarried : tuning.openPartnered);
  const heard = agents.map(() => new Set<number>()); // people i heard hooked up with i's friend
  const partners = agents.map(() => new Set<number>());
  const pairs = new Map<number, Pair>();
  const pair = (i: number, j: number) => {
    const k = i < j ? i * N + j : j * N + i;
    let p = pairs.get(k);
    if (!p) pairs.set(k, p = { met: false, m: 0, dates: 0 });
    return p;
  };

  function judge(i: number, j: number, swipe = false) { // P(i wants to see j again)
    const a = agents[i], b = agents[j], m = model[a.sex], c = m.coef, mean = m.feature_mean;
    const see = (v: number) => Math.max(1, Math.min(10, v + PERCEPTION_SD * (swipe ? 1.5 : 1) * gauss(r)));
    const shar = swipe ? mean.shar : Math.max(1, Math.min(10, mean.shar + m.feature_sd.shar * (overlap(a, b) - ovMean) / ovSd));
    const gap = Math.abs(a.age - b.age);
    const z = m.intercept + c.attr * see(b.attr) + c.sinc * see(b.sinc) + c.intel * see(b.intel) + c.fun * see(b.fun)
      + c.amb * see(b.amb) + c.shar * shar + c.int_corr * mean.int_corr + c.samerace * mean.samerace + c.age_gap * gap
      - tuning.agePenalty * (gap / 10) ** 2 - (heard[i].has(j) ? GOSSIP_PENALTY : 0)
      + (aff ? (j === aff.agent ? aff.toward[i] : i === aff.agent ? aff.from[j] : 0) : 0);
    return sigmoid(z) * openness(i);
  }

  const events: SimEvent[] = [];
  const emit = (e: SimEvent) => {
    if (opts.recordAll || (opts.focus !== undefined && (e.a === opts.focus || e.b === opts.focus || e.about === opts.focus))) events.push(e);
  };

  const cat = new Int8Array(N).fill(-1); // current place index, -1 = needs a fresh pick
  const loc = new Int32Array(N);
  const busyUntil = new Int32Array(N), busyVenue = new Int32Array(N);
  const agenda = new Map<number, Action[]>();
  const schedule = (tick: number, act: Action) => (agenda.get(tick) ?? agenda.set(tick, []).get(tick)!).push(act);
  const venueFor = (a: Agent, k: number): number => {
    const kind = PLACES[k];
    if (kind === "home") return a.home;
    if (kind === "work") return a.work;
    if (kind === "friends_home") return hangouts[a.circle];
    const fav = a.favorites[kind]!;
    return r() < 0.75 ? fav[0] : fav[1];
  };
  const pick = (p: Float32Array, off: number) => {
    let x = r();
    for (let k = 0; k < P; k++) if ((x -= p[off + k]) <= 0) return k;
    return 0;
  };

  function hookup(i: number, j: number, tick: number, venue: number) {
    const first = !partners[i].has(j);
    partners[i].add(j); partners[j].add(i);
    emit({ tick, type: "hookup", a: i, b: j, venue });
    const host = status[i] === "single" || status[j] !== "single" ? i : j;
    const until = (Math.floor(tick / SLOTS) + 1) * SLOTS + MORNING_SLOT;
    for (const x of [i, j]) { busyUntil[x] = until; busyVenue[x] = agents[host].home; }
    for (const [teller, about] of first ? [[i, j], [j, i]] : []) { // news only travels the first time
      for (const f of circles[agents[teller].circle]) {
        if (f === i || f === j || r() >= agents[teller].gossip) continue;
        heard[f].add(about);
        emit({ tick, type: "gossip", a: f, b: teller, venue, about });
      }
    }
    if (status[i] === "single" && status[j] === "single" && r() < tuning.couple) {
      status[i] = status[j] = "partnered"; partnerOf[i] = j; partnerOf[j] = i; coupledOn[i] = coupledOn[j] = Math.floor(tick / SLOTS);
      emit({ tick, type: "couple", a: i, b: j, venue });
    }
  }

  function startDate(i: number, j: number, tick: number) {
    const daysAhead = 1 + (r() * 7 | 0);
    const at = (Math.floor(tick / SLOTS) + daysAhead) * SLOTS + DATE_SLOT;
    schedule(at, { kind: "date", a: i, b: j, venue: agents[i].favorites.restaurant_bar![0] });
  }

  function spark(i: number, j: number, pij: number, pji: number, tick: number, venue: number, viaApp: boolean) {
    const p = pair(i, j);
    p.m = pij * pji;
    emit({ tick, type: viaApp ? "match" : "spark", a: i, b: j, venue });
    const slot = tick % SLOTS;
    if (!viaApp && slot >= LATE_SLOT && NIGHT_HOOKUP_PLACES.has(venues[venue].kind) && r() < tuning.hookupNight * p.m) {
      hookup(i, j, tick, venue);
    } else startDate(i, j, tick);
  }

  function meet(i: number, j: number, tick: number, venue: number, viaApp: boolean) {
    const p = pair(i, j);
    if (p.met) return;
    p.met = true;
    const pij = judge(i, j, viaApp), pji = judge(j, i, viaApp);
    const yi = r() < pij, yj = r() < pji;
    if (yi && yj) spark(i, j, pij, pji, tick, venue, viaApp);
    else if (yi !== yj && !viaApp) emit({ tick, type: "rejected", a: yi ? i : j, b: yi ? j : i, venue }); // b turned a down
  }

  const ticks = opts.days * SLOTS;
  const locations = opts.trackLocations ? new Uint16Array(ticks * N) : undefined;
  const present = new Map<number, number[]>();
  const appUsers = agents.filter(a => a.apps).map(a => a.id);

  for (let tick = 0; tick < ticks; tick++) {
    const day = Math.floor(tick / SLOTS), slot = tick % SLOTS, wd = (startWeekday + day) % 7;
    const dt = wd <= 3 ? 0 : wd - 3; // Mon-Thu weekday, then fri, sat, sun (index into DAYTYPES)
    const prevTick = tick - 1, prevWd = (startWeekday + Math.floor(prevTick / SLOTS)) % 7;
    const prevOff = ((prevWd <= 3 ? 0 : prevWd - 3) * SLOTS + ((prevTick % SLOTS) + SLOTS) % SLOTS) * P;
    const off = (dt * SLOTS + slot) * P;

    if (slot === MORNING_SLOT) for (let i = 0; i < N; i++) { // breakups, decided over breakfast
      const j = partnerOf[i];
      if (status[i] !== "partnered" || j < i && j !== -1) continue; // each couple once
      if (r() >= (j === -1 ? SPLIT_ESTABLISHED : day - coupledOn[i] < EARLY_DAYS ? SPLIT_EARLY : SPLIT_LATER)) continue;
      status[i] = "single"; partnerOf[i] = -1;
      if (j !== -1) { status[j] = "single"; partnerOf[j] = -1; emit({ tick, type: "breakup", a: i, b: j, venue: agents[i].home }); }
    }

    for (const act of agenda.get(tick) ?? []) {
      const { a, b, venue } = act, p = pair(a, b);
      if (act.kind === "date") {
        const taken = (x: number, y: number) => partnerOf[x] !== -1 && partnerOf[x] !== y;
        if (busyUntil[a] > tick || busyUntil[b] > tick || taken(a, b) || taken(b, a)) {
          emit({ tick, type: "stood_up", a: busyUntil[a] > tick || taken(a, b) ? b : a, b: busyUntil[a] > tick || taken(a, b) ? a : b, venue });
          continue;
        }
        for (const x of [a, b]) { busyUntil[x] = tick + DATE_LEN; busyVenue[x] = venue; }
        p.dates++;
        emit({ tick, type: "date", a, b, venue });
        schedule(tick + DATE_LEN, { kind: "dateEnd", a, b, venue });
      } else {
        if (r() < Math.min(0.95, tuning.hookupDate * p.m * (1 + 0.5 * (p.dates - 1)))) hookup(a, b, tick, venue);
        if (partnerOf[a] !== b && p.dates < 4 && r() < ANOTHER_DATE) startDate(a, b, tick);
      }
    }

    present.clear();
    for (let i = 0; i < N; i++) {
      if (busyUntil[i] > tick) { loc[i] = busyVenue[i]; cat[i] = -1; }
      else {
        const a = agents[i], c = cat[i];
        let next = c;
        if (c === -1 || tick === 0) next = pick(a.probs, off);
        else {
          const pp = a.probs[prevOff + c], pn = a.probs[off + c];
          if (pp > pn && r() >= pn / pp) { // leave: go where people are arriving (keeps the schedule's marginals)
            let inflow = 0;
            for (let k = 0; k < P; k++) inflow += Math.max(0, a.probs[off + k] - a.probs[prevOff + k]);
            let x = r() * inflow;
            next = -1;
            for (let k = 0; k < P && next === -1; k++) if ((x -= Math.max(0, a.probs[off + k] - a.probs[prevOff + k])) <= 0) next = k;
            if (next === -1) next = pick(a.probs, off);
          }
        }
        if (next !== c) { cat[i] = next; loc[i] = venueFor(a, next); }
      }
      if (locations) locations[tick * N + i] = loc[i];
      if (CHAT_RATE[venues[loc[i]].kind] && busyUntil[i] <= tick) (present.get(loc[i]) ?? present.set(loc[i], []).get(loc[i])!).push(i);
    }

    for (const [venue, here] of present) {
      if (here.length < 2) continue;
      const rate = CHAT_RATE[venues[venue].kind]! * tuning.chat;
      for (const i of here) {
        if (r() >= rate) continue;
        const j = here[r() * here.length | 0];
        if (j !== i && compatible(agents[i], agents[j])) meet(i, j, tick, venue, false);
      }
    }

    if (slot === APP_SLOT) {
      for (const i of appUsers) {
        if (status[i] !== "single") continue;
        for (let s = tuning.appSwipes; s > 0; s--) {
          if (s < 1 && r() >= s) break;
          const j = appUsers[r() * appUsers.length | 0];
          if (j !== i && status[j] === "single" && compatible(agents[i], agents[j])) meet(i, j, tick, agents[i].home, true);
        }
      }
    }
  }

  return { partners: partners.map(s => [...s].sort((x, y) => x - y)), status, events, locations };
}

export const DEFAULT_TUNING: Tuning = {
  chat: 4, hookupNight: 0.6, hookupDate: 2, appSwipes: 12, couple: 0.3, openPartnered: 0.1, openMarried: 0.03,
  agePenalty: 0.5, declineFemale: 0.3, declineMale: 0.2,
};
export { DAYTYPES };
