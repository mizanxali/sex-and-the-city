// Fit the Tuning knobs so a simulated year matches GSS. Writes data/tuning.json.
// Coordinate search in log space: nudge one knob up/down, keep it if the loss drops, shrink steps when stuck.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_TUNING, type Tuning } from "./engine.ts";
import { loss, report, runYear } from "./stats.ts";
import { buildWorld } from "./world.ts";

const SEEDS = Array.from({ length: 16 }, (_, k) => k + 1); // fewer is too noisy: one changed draw reshuffles the whole year
const CAPS: Partial<Record<keyof Tuning, number>> = { openPartnered: 1, openMarried: 1 };

const world = buildWorld();
const OUT = new URL("../../data/tuning.json", import.meta.url);
let best: Tuning = { ...DEFAULT_TUNING, ...(existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {}) }; // resume
let bestLoss = loss(runYear(world, best, SEEDS));
console.log("start loss", bestLoss.toFixed(4));

for (let step = Math.log(1.5); step > Math.log(1.05); step /= 2) {
  let improved = true;
  while (improved) {
    improved = false;
    for (const k of Object.keys(best) as (keyof Tuning)[]) {
      for (const dir of [1, -1]) {
        const v = +Math.min(CAPS[k] ?? Infinity, best[k] * Math.exp(dir * step)).toPrecision(3); // score what we save
        if (v === best[k]) continue;
        const cand = { ...best, [k]: v };
        const l = loss(runYear(world, cand, SEEDS));
        if (l < bestLoss) {
          best = cand; bestLoss = l; improved = true;
          console.log(`${k} → ${v.toPrecision(3)}  loss ${l.toFixed(4)}`);
          break;
        }
      }
    }
  }
}

writeFileSync(OUT, JSON.stringify(best, null, 1) + "\n");
console.log("wrote data/tuning.json", best);
console.log(report(runYear(world, best, SEEDS)));
