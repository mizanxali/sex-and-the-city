// Compare a simulated year against GSS: partners last year for people single at the end of it,
// and "2+ partners" rates for people married / partnered at the end.
import calibrationJson from "../../data/calibration.json" with { type: "json" };
import { type SimResult, type Tuning, simulate } from "./engine.ts";
import { type World, ageBand } from "./world.ts";

export const YEAR = 364;
export const BUCKETS = ["0", "1", "2", "3+"] as const;
const bucket = (n: number) => Math.min(n, 3);

type Dist = { n: number; p: number[] };
export const gssSingles: Record<string, Dist> = Object.fromEntries(
  Object.entries(calibrationJson.partners_last_year_single).map(([g, d]) => {
    const v = d as Record<string, number>;
    return [g, { n: v.n, p: [v["0"], v["1"], v["2"], v["3"] + v["4"] + v["5-10"] + v["11+"]] }];
  }));
export const gssExtra = calibrationJson.extra_partner_rate as Record<string, { n: number; rate: number }>;

export function summarize(world: World, results: SimResult[]) {
  // Grouped like GSS: by status at the end of the year (the interview), counting a starting partner who lives
  // out of town (everyone not single at the start has one), so a breakup leaves a "single with 1 partner".
  const singles: Record<string, Dist> = {}, extra: Record<string, { n: number; rate: number }> = {};
  for (const res of results) {
    for (const a of world.agents) {
      if (a.isPlayer) continue;
      const n = res.partners[a.id].length + (a.status === "single" ? 0 : 1), now = res.status[a.id];
      if (now === "single") {
        const d = singles[`${a.sex}|${ageBand(a.age)}`] ??= { n: 0, p: [0, 0, 0, 0] };
        d.n++; d.p[bucket(n)]++;
      } else {
        const e = extra[`${a.sex}|${now}`] ??= { n: 0, rate: 0 };
        e.n++; e.rate += n > 1 ? 1 : 0;
      }
    }
  }
  for (const d of Object.values(singles)) d.p = d.p.map(c => c / d.n);
  for (const e of Object.values(extra)) e.rate /= e.n;
  return { singles, extra };
}

export function loss(s: ReturnType<typeof summarize>) {
  let total = 0, w = 0;
  for (const [g, target] of Object.entries(gssSingles)) {
    const sim = s.singles[g];
    if (!sim) continue;
    total += target.n * target.p.reduce((acc, t, b) => acc + (sim.p[b] - t) ** 2, 0);
    w += target.n;
  }
  let extraErr = 0;
  for (const [g, t] of Object.entries(gssExtra)) extraErr += ((s.extra[g]?.rate ?? 0) - t.rate) ** 2;
  return total / w + 50 * extraErr; // affairs are rare (2%), so weight them up or the fit ignores them
}

export function runYear(world: World, tuning: Tuning, seeds: number[]) {
  return summarize(world, seeds.map(seed => simulate(world, tuning, { days: YEAR, seed })));
}

export function report(s: ReturnType<typeof summarize>) {
  const pct = (v: number) => (100 * v).toFixed(0).padStart(3) + "%";
  const lines = [`group            ${BUCKETS.map(b => `sim/gss ${b.padEnd(2)}`).join("  ")}   n(sim/gss)`];
  for (const [g, t] of Object.entries(gssSingles)) {
    const sim = s.singles[g] ?? { n: 0, p: [0, 0, 0, 0] };
    lines.push(`single ${g.padEnd(10)} ${t.p.map((v, b) => `${pct(sim.p[b])}/${pct(v)}  `).join("   ")} ${sim.n}/${t.n}`);
  }
  for (const [g, t] of Object.entries(gssExtra))
    lines.push(`side   ${g.padEnd(17)} ${pct(s.extra[g]?.rate ?? 0)}/${pct(t.rate)}`);
  return lines.join("\n");
}
