// The town: agents (1,000 personas + optional player) and the venues they move between.
import personasJson from "../../data/town.json" with { type: "json" };
import traitsJson from "../../data/traits.json" with { type: "json" };
import attractionJson from "../../data/attraction.json" with { type: "json" };
import schedulesJson from "../../data/schedules.json" with { type: "json" };

export const MIN_AGE = 21;
export const WORLD_SEED = 1; // the town itself never changes between runs
export const PLACES = schedulesJson.places as Place[];
export type Place = "home" | "work" | "friends_home" | "restaurant_bar" | "gym" | "store" | "outdoors" | "worship"
  | "school" | "transit" | "other";
export type Sex = "male" | "female";
export type Orientation = "straight" | "gay" | "bisexual";
export type Status = "single" | "partnered" | "married";
export const DAYTYPES = ["weekday", "fri", "sat", "sun"] as const;
export const INTERESTS = [
  "fitness", "running", "outdoors", "cooking", "eating out", "wine and cocktails", "craft beer", "live music",
  "dancing", "art and museums", "reading", "video games", "movies and tv", "watching sports", "travel",
  "gardening", "diy and crafts", "religion", "volunteering", "tech", "pets", "fashion", "yoga and wellness",
  "board games"];

export interface PlayerSpec {
  name: string; sex: Sex; age: number; orientation: Orientation; employed: boolean;
  nightlife: number; gym: number; apps: boolean; // nights out / gym visits per week, on dating apps
  attr: number; sinc: number; intel: number; fun: number; amb: number; // 1-10, speed-dating scale
  interests: string[];
  casual: boolean; // keeping it casual: never becomes a couple (body count) vs looking for love
}

export interface Agent {
  id: number; name: string; sex: Sex; age: number; orientation: Orientation; status: Status;
  employed: boolean; nightlife: number; gym: number; apps: boolean; gossip: number;
  attr: number; sinc: number; intel: number; fun: number; amb: number; interests: number; // bitmask
  home: number; work: number; circle: number; favorites: Partial<Record<Place, number[]>>;
  probs: Float32Array; // [daytype][slot][place], schedule shaped by this agent's habits
  occupation: string; persona: number; // row in personas.json / traits.json, -1 for the player
  isPlayer: boolean;
  casual?: boolean; // player only
  visitor?: boolean; // out of town: only on the apps, only for a gay player (see VISITORS)
}

export interface Venue { id: number; kind: Place; name: string }
export interface World { agents: Agent[]; venues: Venue[]; circles: number[][]; hangouts: number[] }

// Public venues by kind. ponytail: placeholder names, the 3D town in phase 3 will own the real list.
const PUBLIC: [Place, string[]][] = [
  ["restaurant_bar", ["The Tipsy Moose", "Club Neon", "Bean There Cafe", "Olive Garden-ish", "Rusty Nail Dive Bar", "Uncorked Wine Bar"]],
  ["gym", ["Iron Temple", "Planet Fine-ness"]],
  ["store", ["MegaMart", "Corner Grocery", "The Mall"]],
  ["outdoors", ["Central Park", "River Trail"]],
  ["worship", ["First Church", "Community Temple"]],
  ["school", ["Community College"]],
  ["transit", ["Main Street"]],
  ["other", ["Public Library", "Town Hall", "Laundromat"]],
];
// Workplaces by industry, matched on Nemotron occupation codes; anything unmatched is office work.
const SECTORS: [string, RegExp][] = [
  ["Mercy General Hospital", /nurs|physician|health|medical|dental|pharmac|therap|surg|clinical|paramedic/],
  ["Lincoln High School", /teach|educ|librar|professor|instructor|tutor/],
  ["Little Sprouts Care Home", /child|personal_care|home_health|caregiv|social|counselor/],
  ["TechHub", /software|computer|developer|programm|data|network|web|information/],
  ["Golden Spoon Kitchens", /cook|food|waiter|waitress|bartender|dishwash|chef|host|baker|butcher/],
  ["Ace Construction Yard", /construct|carpent|electric|plumb|painter|roof|mechanic|maintenance|repair|install|laborer|hvac|iron|sheet_metal/],
  ["Big Box Warehouse", /stocker|material|driver|truck|transport|freight|warehouse|packer|deliver|courier|shipping|logistic/],
  ["Downtown Retail Row", /retail|cashier|sales|merchandis|customer_service|counter|jewel|shoe/],
  ["Sparkle Cleaning Co.", /maid|housekeep|janitor|clean|groundskeep|landscap/],
  ["City Services", /police|fire|government|postal|guard|security|correction|bailiff|military|clergy/],
  ["Steelworks Plant", /production|assembl|machin|operator|manufactur|weld|inspector|fabricat|metal|leather/],
  ["Happy Paws Vet & Feed", /veterinar|animal|agricultur|farm/],
];
const OFFICES = ["Initech Offices", "Vandelay Industries", "Synergy Partners LLC"];
const CIRCLE_SIZE = 12;
// The town's gay singles are too few for a gay player to compete (17 men, 19 women vs ~150 for straight players), so a
// gay player's apps also reach this many gay singles of their sex from the wider region. Tuned with `npm run balance`.
export const VISITORS = 120;

export function rng(seed: number) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = ReturnType<typeof rng>;
export const gauss = (r: Rng) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const ageBand = (age: number) => age <= 29 ? "21-29" : age <= 44 ? "30-44" : age <= 64 ? "45-64" : "65+";

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const interestMask = (list: string[]) =>
  list.reduce((m, s) => INTERESTS.includes(s) ? m | (1 << INTERESTS.indexOf(s)) : m, 0);

// Schedules are population averages; scale bar/party and gym time by this agent's habits relative to the town.
function shapeSchedule(employed: boolean, age: number, nightlife: number, gym: number, avgNight: number, avgGym: number) {
  const out = new Float32Array(DAYTYPES.length * 48 * PLACES.length);
  const night = (nightlife + 0.25) / (avgNight + 0.25), gymMult = (gym + 0.25) / (avgGym + 0.25);
  const iBar = PLACES.indexOf("restaurant_bar"), iFriends = PLACES.indexOf("friends_home"), iGym = PLACES.indexOf("gym");
  DAYTYPES.forEach((day, d) => {
    const group = (schedulesJson.groups as Record<string, { p: number[][] }>)[
      `${employed ? "employed" : "not_employed"}|${ageBand(age)}|${day}`];
    group.p.forEach((row, slot) => {
      const p = row.slice();
      p[iBar] *= night; p[iFriends] *= night; p[iGym] *= gymMult;
      const sum = p.reduce((a, b) => a + b, 0);
      p.forEach((v, k) => out[(d * 48 + slot) * PLACES.length + k] = v / sum);
    });
  });
  return out;
}

export function buildWorld(player?: PlayerSpec): World {
  const r = rng(WORLD_SEED);
  const att = Object.values(attractionJson.by_chooser);
  const attrDist = { mean: att.reduce((s, a) => s + a.feature_mean.attr, 0) / 2, sd: att.reduce((s, a) => s + a.feature_sd.attr, 0) / 2 };
  const traits = traitsJson as Record<string, { nightlife: number; gym: number; dating_apps: boolean; gossip: number;
    sincerity: number; intelligence: number; fun: number; ambition: number; interests: string[] }>;
  const tl = Object.values(traits);
  const avgNight = tl.reduce((s, t) => s + t.nightlife, 0) / tl.length, avgGym = tl.reduce((s, t) => s + t.gym, 0) / tl.length;

  const venues: Venue[] = [];
  const addVenue = (kind: Place, name: string) => venues.push({ id: venues.length, kind, name }) - 1;
  const publicIds: Partial<Record<Place, number[]>> = {};
  for (const [kind, names] of PUBLIC) publicIds[kind] = names.map(n => addVenue(kind, n));
  const workplace = new Map([...SECTORS.map(([n]) => n), ...OFFICES].map(n => [n, addVenue("work", n)]));
  const workFor = (occupation: string) => workplace.get(
    SECTORS.find(([, rx]) => rx.test(occupation))?.[0] ?? OFFICES[hash(occupation) % OFFICES.length])!;

  const town = personasJson.filter(p => !("visitor" in p));
  const agents: Agent[] = town.map(p => {
    const t = traits[String(p.id)];
    const employed = !["not_in_workforce", "no_occupation"].includes(p.occupation);
    return {
      id: p.id, name: p.name, sex: p.sex as Sex, age: p.age, orientation: p.orientation as Orientation,
      status: p.status as Status, employed, nightlife: t.nightlife, gym: t.gym, apps: t.dating_apps, gossip: t.gossip,
      attr: clamp(attrDist.mean + attrDist.sd * gauss(r), 1, 10), sinc: t.sincerity, intel: t.intelligence,
      fun: t.fun, amb: t.ambition, interests: interestMask(t.interests),
      home: addVenue("home", `${p.name}'s place`), work: workFor(p.occupation),
      circle: -1, favorites: {}, probs: shapeSchedule(employed, p.age, t.nightlife, t.gym, avgNight, avgGym),
      occupation: p.occupation, persona: p.id, isPlayer: false,
    };
  });
  for (const a of agents) {
    if (a.age < MIN_AGE) throw new Error(`agent ${a.id} is under ${MIN_AGE}`);
    for (const [kind, ids] of Object.entries(publicIds) as [Place, number[]][]) {
      const first = ids[r() * ids.length | 0];
      a.favorites[kind] = [first, ids[r() * ids.length | 0]]; // regular spot + occasional other one
    }
  }

  // Friend circles: people near in age, shuffled a little, chunked; each circle hangs out at one member's place.
  const order = agents.map(a => ({ a, k: a.age + 8 * gauss(r) })).sort((x, y) => x.k - y.k).map(x => x.a);
  const circles: number[][] = [], hangouts: number[] = [];
  for (let i = 0; i < order.length; i += CIRCLE_SIZE) {
    const members = order.slice(i, i + CIRCLE_SIZE);
    members.forEach(m => m.circle = circles.length);
    circles.push(members.map(m => m.id));
    hangouts.push(members[r() * members.length | 0].home);
  }

  // The player joins last, on their own random stream, so the town (and its calibration) is identical with or
  // without them: they move into an existing friend circle of people their age.
  if (player) {
    if (player.age < MIN_AGE) throw new Error(`player must be ${MIN_AGE}+`);
    if (player.orientation === "gay") { // before the player, who stays last; their own stream, so the town is unchanged
      const vr = rng(WORLD_SEED + 2), away = addVenue("home", "out of town");
      for (const p of personasJson.filter(p => "visitor" in p && p.sex === player.sex).slice(0, VISITORS)) {
        const t = traits[String(p.id)];
        if (p.age < MIN_AGE) throw new Error(`visitor ${p.id} is under ${MIN_AGE}`);
        agents.push({
          id: agents.length, name: p.name, sex: p.sex as Sex, age: p.age, orientation: "gay", status: "single",
          employed: true, nightlife: t.nightlife, gym: t.gym, apps: true, gossip: t.gossip,
          attr: clamp(attrDist.mean + attrDist.sd * gauss(vr), 1, 10), sinc: t.sincerity, intel: t.intelligence,
          fun: t.fun, amb: t.ambition, interests: interestMask(t.interests), home: away, work: away, circle: -1,
          favorites: {}, probs: new Float32Array(0), occupation: p.occupation, persona: p.id, isPlayer: false, visitor: true,
        });
      }
    }
    const pr = rng(WORLD_SEED + 1);
    const me: Agent = {
      ...player, id: agents.length, status: "single", gossip: 0.5, interests: interestMask(player.interests), occupation: "", persona: -1,
      home: addVenue("home", `${player.name}'s place`), work: workplace.get(OFFICES[pr() * OFFICES.length | 0])!, circle: 0,
      favorites: {}, probs: shapeSchedule(player.employed, player.age, player.nightlife, player.gym, avgNight, avgGym),
      isPlayer: true,
    };
    for (const [kind, ids] of Object.entries(publicIds) as [Place, number[]][]) me.favorites[kind] = [ids[pr() * ids.length | 0], ids[pr() * ids.length | 0]];
    const ageOf = (c: number[]) => c.reduce((s, id) => s + agents[id].age, 0) / c.length;
    me.circle = circles.reduce((best, c, k) => Math.abs(ageOf(c) - player.age) < Math.abs(ageOf(circles[best]) - player.age) ? k : best, 0);
    circles[me.circle].push(me.id);
    agents.push(me);
  }
  return { agents, venues, circles, hangouts };
}

export const RATING_BUDGET = 33; // five 1-10 ratings averaging 6.6: you can be hot, or nice, not everything
export const MAX_INTERESTS = 5;
export const RATINGS = ["attr", "sinc", "intel", "fun", "amb"] as const;

// Never trust a spec from a client or an LLM: clamp every field to the game's rules.
export function clampSpec(raw: Partial<PlayerSpec>): PlayerSpec {
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    Number.isFinite(Number(v)) ? Math.round(clamp(Number(v), lo, hi)) : dflt;
  const age = num(raw.age, 0, 99, 30);
  if (age < MIN_AGE) throw new Error(`Characters must be ${MIN_AGE} or older.`);
  const spec: PlayerSpec = {
    name: String(raw.name ?? "").replace(/[<>]/g, "").trim().slice(0, 24) || "You",
    sex: raw.sex === "female" ? "female" : "male",
    age,
    orientation: (["straight", "gay", "bisexual"] as const).find(o => o === raw.orientation) ?? "straight",
    employed: raw.employed !== false, apps: raw.apps !== false, casual: raw.casual !== false,
    nightlife: num(raw.nightlife, 0, 5, 1), gym: num(raw.gym, 0, 6, 1),
    attr: num(raw.attr, 1, 10, 6), sinc: num(raw.sinc, 1, 10, 6), intel: num(raw.intel, 1, 10, 6),
    fun: num(raw.fun, 1, 10, 6), amb: num(raw.amb, 1, 10, 6),
    interests: [...new Set((raw.interests ?? []).filter(i => INTERESTS.includes(i)))].slice(0, MAX_INTERESTS),
  };
  while (RATINGS.reduce((s, k) => s + spec[k], 0) > RATING_BUDGET) { // over budget: shave the highest
    const top = RATINGS.reduce((a, b) => (spec[b] > spec[a] ? b : a));
    spec[top]--;
  }
  return spec;
}
