// The one check for the sim: npm run check. Fails loudly if the town drifts from reality or stops being deterministic.
import assert from "node:assert/strict";
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Tuning, simulate } from "./engine.ts";
import { gssSingles, loss, report, runYear } from "./stats.ts";
import { MIN_AGE, type PlayerSpec, buildWorld } from "./world.ts";

const tuning = tuningJson as Tuning;
const HELD_OUT = [101, 102, 103, 104, 105, 106, 107, 108]; // calibration fits seeds 1-8

// 1. Nobody under 21, and the player can't be either.
const world = buildWorld();
assert(world.agents.every(a => a.age >= MIN_AGE));
const player: PlayerSpec = {
  name: "Test Player", sex: "male", age: 28, orientation: "straight", employed: true, nightlife: 2, gym: 2, apps: true,
  attr: 6, sinc: 7, intel: 7, fun: 6, amb: 7, interests: ["live music", "craft beer", "video games"],
};
assert.throws(() => buildWorld({ ...player, age: 19 }));

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
console.log("ok");
