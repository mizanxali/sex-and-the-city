// Game balance for the player's month (npm run balance): score spread across random builds, what pays off, and
// whether every identity, age and play style can reach the top. Knobs: MAIN_CHARACTER in engine.ts, VISITORS in world.ts.
// Targets: strong builds about 15 a month for every sex × orientation and ages 21-55, apps, bars and a mix all
// competitive, and a description Jev likes worth about a third more.
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Affinity, type Tuning, simulate } from "./engine.ts";
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

function score(spec: PlayerSpec, seeds = SEEDS, appeal = 0) { // appeal: Jev's verdict on the description, as in ai.ts
  const world = buildWorld(spec), me = world.agents.length - 1;
  const affinity: Affinity | undefined = appeal ? { agent: me, toward: world.agents.map(() => appeal), from: world.agents.map(() => appeal) } : undefined;
  const runs = seeds.map(seed => simulate(world, tuning, { days: DAYS, seed, focus: me, affinity }).partners[me].length);
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

// Strong builds, one per play style; an identity's best is the best of the three (8 months each).
const MORE = [1, 2, 3, 4, 5, 6, 7, 8];
const styles = {
  apps: { nightlife: 0, apps: true, attr: 10, sinc: 7, intel: 4, fun: 1, amb: 10 },
  mixed: { nightlife: 3, apps: true, attr: 10, sinc: 4, intel: 7, fun: 4, amb: 7 },
  bars: { nightlife: 5, apps: false, attr: 7, sinc: 4, intel: 4, fun: 10, amb: 7 },
};
const strong = (over: Partial<PlayerSpec>) => clampSpec({ name: "Max", sex: "male", age: 28, orientation: "straight", employed: true,
  casual: true, gym: 1, interests: ["live music", "craft beer", "dancing"], ...styles.mixed, ...over });
for (const sex of ["male", "female"] as const) for (const orientation of ["straight", "gay", "bisexual"] as const) {
  const by = Object.entries(styles).map(([k, st]) => `${k} ${score(strong({ sex, orientation, ...st }), MORE).toFixed(1)}`);
  console.log(`${`${sex} ${orientation}`.padEnd(17)} ${by.join("  ")}`);
}
for (const sex of ["male", "female"] as const)
  console.log(`${`${sex} by age`.padEnd(17)} ${[21, 28, 40, 55].map(age => `${age}: ${score(strong({ sex, age }), MORE).toFixed(1)}`).join("  ")}`);
// Jev's verdict on the description: 0.54 ≈ the "specific, charming" sample in npm run jev-check.
for (const [label, spec] of [["typical", clampSpec({ name: "T", sex: "male", age: 28, orientation: "straight", employed: true, casual: true, apps: true, nightlife: 2, gym: 1, attr: 6, sinc: 7, intel: 7, fun: 6, amb: 7, interests: ["live music"] })], ["strong", strong({})]] as const)
  console.log(`description ${label.padEnd(8)} ${[-0.54, 0, 0.54, 0.76].map(a => `${a > 0 ? "+" : ""}${a}: ${score(spec, MORE, a).toFixed(1)}`).join("  ")}`);
