// The one check for the sim: npm run check. Fails loudly if the town drifts from reality or stops being deterministic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import breakupsJson from "../../data/breakups.json" with { type: "json" };
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Tuning, simulate } from "./engine.ts";
import { offsets } from "../server/ai.ts";
import { YEAR, gssSingles, loss, report, runYear } from "./stats.ts";
import { INTERESTS, MIN_AGE, type PlayerSpec, buildWorld, gauss, rng } from "./world.ts";

const tuning = tuningJson as Tuning;
const HELD_OUT = [101, 102, 103, 104, 105, 106, 107, 108]; // calibration fits seeds 1-16

// 1. Nobody under 21, and the player can't be either.
const world = buildWorld();
assert(world.agents.every(a => a.age >= MIN_AGE));
const player: PlayerSpec = {
  name: "Test Player", sex: "male", age: 28, orientation: "straight", employed: true, casual: true, nightlife: 2, gym: 2, apps: true,
  attr: 6, sinc: 7, intel: 7, fun: 6, amb: 7, interests: ["live music", "craft beer", "video games"],
};
assert.throws(() => buildWorld({ ...player, age: 19 }));
// The form's interest chips are in the HTML (no layout shift when the script lands): same list, same order.
const chips = [...readFileSync(new URL("../../index.html", import.meta.url), "utf8").matchAll(/name="interest" value="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(chips, INTERESTS, "index.html's interest chips drifted from INTERESTS");

// 2. Same seed, same month.
const withPlayer = buildWorld(player);
const me = withPlayer.agents.length - 1;
const run = () => simulate(withPlayer, tuning, { days: 30, seed: 7, focus: me, trackLocations: true });
const a = run(), b = run();
assert.deepEqual(a.partners, b.partners);
assert.deepEqual(a.events, b.events);
assert(a.events.every(e => e.a === me || e.b === me || e.about === me), "focus filter leaked other events");
console.log(`player month: ${a.partners[me].length} partners, ${a.events.length} events`,
  Object.fromEntries(Object.entries(Object.groupBy(a.events, e => e.type)).map(([k, v]) => [k, v!.length])));

// 2b. Out-of-town visitors (gay players only) never meet anyone but the player.
const gay = buildWorld({ ...player, orientation: "gay" }), gayMe = gay.agents.length - 1;
const visitors = new Set(gay.agents.filter(a => a.visitor).map(a => a.id));
assert(visitors.size > 0 && gay.agents.every(a => a.age >= MIN_AGE));
const gayMonth = simulate(gay, tuning, { days: 30, seed: 7, recordAll: true });
assert(gayMonth.events.every(e => !(visitors.has(e.a) || visitors.has(e.b)) || e.a === gayMe || e.b === gayMe), "a visitor met someone other than the player");
console.log(`gay player month: ${gayMonth.partners[gayMe].length} partners, ${gayMonth.partners[gayMe].filter(i => visitors.has(i)).length} from out of town`);

// 3. A year of the town matches GSS on seeds the calibration never saw.
const s = runYear(world, tuning, HELD_OUT);
console.log(report(s));
const l = loss(s);
const zeroShare = (src: Record<string, { n: number; p: number[] }>) => {
  let z = 0, n = 0;
  for (const [g, t] of Object.entries(gssSingles)) { z += t.n * src[g].p[0]; n += t.n; }
  return z / n;
};
console.log(`loss ${l.toFixed(4)}; singles with no partner: sim ${(100 * zeroShare(s.singles)).toFixed(0)}% vs GSS ${(100 * zeroShare(gssSingles)).toFixed(0)}%`);
assert(l < 0.05, `loss ${l} too high`);
assert(Math.abs(zeroShare(s.singles) - zeroShare(gssSingles)) < 0.08, "share of singles with no partner is off");
for (const sex of ["female", "male"]) {
  const r = s.extra[`${sex}|married`].rate;
  assert(r > 0.005 && r < 0.05, `married ${sex} affair rate ${r} outside 0.5-5%`);
}
// 4. Couples formed in town split at HCMST's rate: within six months, 1 - exp(-rate / 2) of them.
let formed = 0, splitEarly = 0;
for (const seed of HELD_OUT.slice(0, 4)) {
  const ev = simulate(world, tuning, { days: YEAR, seed, recordAll: true }).events;
  const since = new Map<number, number>();
  for (const e of ev) {
    if (e.type === "couple" && e.tick < (YEAR - 182) * 48) { since.set(e.a, e.tick).set(e.b, e.tick); formed++; }
    if (e.type === "breakup" && since.has(e.a) && e.tick - since.get(e.a)! < 182 * 48) splitEarly++;
    if (e.type === "breakup") { since.delete(e.a); since.delete(e.b); }
  }
}
const expected = 1 - Math.exp(-breakupsJson.new_couple_first_6_months.per_year / 2);
console.log(`couples split within six months: ${splitEarly}/${formed} vs HCMST ${(100 * expected).toFixed(0)}%`);
assert(formed >= 10 && Math.abs(splitEarly / formed - expected) < 0.2, "breakup rate off");

// 5. Jev's nudges: differences between people reshuffle who likes the player, not how many (within 20%);
//    the town's overall verdict on the description (appeal, capped at ±1 logit) moves the score on purpose.
const nudge = (k: number) => { const r = rng(9000 + k); return withPlayer.agents.map(() => 0.8 * gauss(r)); };
const ids = withPlayer.agents.slice(0, -1).map(a => a.id);
const meanOf = (xs: number[]) => ids.reduce((s, i) => s + xs[i], 0) / ids.length;
const withAppeal = (xs: number[], appeal: number) => offsets(xs, ids, meanOf(xs) - appeal).offsets;
let plain = 0, nudged = 0, liked = 0;
const MONTHS = 80;
for (let seed = 1; seed <= MONTHS; seed++) {
  const month = (aff?: (xs: number[]) => number[]) => simulate(withPlayer, tuning, { days: 30, seed, focus: me,
    affinity: aff && { agent: me, toward: aff(nudge(seed)), from: aff(nudge(seed + 500)) } }).partners[me].length;
  plain += month(); nudged += month(xs => withAppeal(xs, 0)); liked += month(xs => withAppeal(xs, 1));
}
console.log(`player partners per month: ${(plain / MONTHS).toFixed(2)} plain, ${(nudged / MONTHS).toFixed(2)} with nudges, ${(liked / MONTHS).toFixed(2)} with max appeal`);
assert(Math.abs(nudged - plain) / Math.max(plain, 1) < 0.2, "affinity spread shifts the player's overall rate");
assert(liked > nudged * 1.15, "a well-liked description should pay off");
console.log("ok");
