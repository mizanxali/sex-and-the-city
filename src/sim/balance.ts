// Game balance for the player's month (npm run balance): score spread across random builds, and what pays off.
// Target: a typical build averages 3-5 partners a month, strong builds 10-15. Knobs: MAIN_CHARACTER in engine.ts.
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Tuning, simulate } from "./engine.ts";
import { INTERESTS, RATINGS, RATING_BUDGET, type PlayerSpec, buildWorld, clampSpec, rng } from "./world.ts";

const BUILDS = 240, SEEDS = [1, 2, 3], DAYS = 30;
const tuning = tuningJson as Tuning;
const r = rng(4242);
const pick = <T>(xs: readonly T[]) => xs[r() * xs.length | 0];

function randomBuild(k: number): PlayerSpec {
  const stats = Object.fromEntries(RATINGS.map(s => [s, 1])) as Record<(typeof RATINGS)[number], number>;
  for (let p = RATING_BUDGET - RATINGS.length; p > 0; p--) { const s = pick(RATINGS); if (stats[s] < 10) stats[s]++; else p++; }
  return clampSpec({
    name: `B${k}`, sex: pick(["male", "female"]), age: 21 + (r() * 35 | 0),
    orientation: r() < 0.8 ? "straight" : pick(["gay", "bisexual"]), employed: r() < 0.8, apps: r() < 0.75, casual: r() < 0.75,
    nightlife: r() * 6 | 0, gym: r() * 7 | 0, ...stats, interests: INTERESTS.filter(() => r() < 0.12),
  });
}

function score(spec: PlayerSpec) {
  const world = buildWorld(spec), me = world.agents.length - 1;
  const runs = SEEDS.map(seed => simulate(world, tuning, { days: DAYS, seed, focus: me }).partners[me].length);
  return runs.reduce((a, b) => a + b, 0) / runs.length;
}

const t0 = Date.now();
const builds = Array.from({ length: BUILDS }, (_, k) => randomBuild(k)).map(spec => ({ spec, score: score(spec) }));
const scores = builds.map(b => b.score).sort((a, b) => a - b);
const q = (p: number) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))].toFixed(1);
console.log(`${BUILDS} random builds × ${SEEDS.length} months (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log(`partners a month: median ${q(0.5)}, p25 ${q(0.25)}, p75 ${q(0.75)}, p90 ${q(0.9)}, best ${q(1)}`);

// What pays off: average score by each choice.
const by = (label: string, f: (s: PlayerSpec) => string) => {
  const g = Object.groupBy(builds, b => f(b.spec));
  console.log(`${label.padEnd(10)} ${Object.entries(g).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([k, v]) => `${k}: ${(v!.reduce((s, b) => s + b.score, 0) / v!.length).toFixed(1)}`).join("  ")}`);
};
by("sex", s => s.sex);
by("into", s => s.orientation);
by("age", s => (s.age < 30 ? "21-29" : s.age < 40 ? "30-39" : "40+"));
by("nights", s => String(s.nightlife));
by("gym", s => (s.gym < 2 ? "0-1" : s.gym < 4 ? "2-3" : "4-6"));
by("apps", s => String(s.apps));
by("casual", s => String(s.casual));
by("looks", s => (s.attr <= 5 ? "1-5" : s.attr <= 7 ? "6-7" : "8-10"));
by("fun", s => (s.fun <= 5 ? "1-5" : s.fun <= 7 ? "6-7" : "8-10"));

// Strong builds: what a player optimising would try.
const strong = (sex: "male" | "female", over: Partial<PlayerSpec> = {}) => clampSpec({
  name: "Max", sex, age: 25, orientation: "straight", employed: true, apps: true, casual: true, nightlife: 5, gym: 3,
  attr: 10, fun: 9, sinc: 5, intel: 5, amb: 4, interests: ["live music", "craft beer", "dancing"].filter(i => INTERESTS.includes(i)), ...over,
});
for (const [label, spec] of [["strong man", strong("male")], ["strong woman", strong("female")],
  ["strong bi man", strong("male", { orientation: "bisexual" })], ["looks-only man", strong("male", { attr: 10, fun: 6, nightlife: 2 })],
  ["no-apps man", strong("male", { apps: false })], ["no-apps woman", strong("female", { apps: false })],
  ["homebody woman", strong("female", { nightlife: 0 })], ["looking for love", strong("female", { casual: false })]] as const)
  console.log(`${label.padEnd(14)} ${score(spec).toFixed(1)}`);
