// API worker (wrangler dev / wrangler deploy). Keys stay here; the browser only ever sees results.
// Static files in dist/ are served by Workers assets; only /api/* reaches this code.
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Affinity, simulate, type Tuning } from "../sim/engine.ts";
import { type PlayerSpec, buildWorld, clampSpec } from "../sim/world.ts";
import { affinity, moderate, parseCharacter, story } from "./ai.ts";

const DAYS = 30;
const tuning = tuningJson as Tuning;

// The few D1 and rate-limit shapes this file uses, so the Node-typed project needn't pull in workers-types.
type Stmt = { bind(...v: unknown[]): Stmt; run(): Promise<unknown>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> };
type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };
type Env = { DB: { prepare(sql: string): Stmt }; AI_LIMIT: Limiter; BOARD_LIMIT: Limiter };

class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const json = (status: number, data: unknown) => Response.json(data, { status });

async function body(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > 100_000) throw new HttpError(413, "Too much.");
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "Expected JSON."); }
}

const bioOf = (v: unknown) => String(v ?? "").slice(0, 200);
const MAX_DESCRIPTION = 1000;
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
function specOf(v: unknown) {
  try { return clampSpec((v ?? {}) as object); } catch (e) { throw new HttpError(400, (e as Error).message); }
}

// Every run is ranked forever. The server picks the seed and simulates the month itself, so the score can't be
// forged; the browser replays the same month from the same seed and Jev offsets (kept on the row for /api/story).
type Route = (b: Record<string, unknown>, env: Env) => Promise<unknown>;
// One place per run, no shared ranks: ties go to whoever got there first.
const RANKED = "(SELECT id, name, score, ROW_NUMBER() OVER (ORDER BY score DESC, created, id) AS rank FROM runs)";

const routes: Record<string, Route> = {
  // Free text → moderated, clamped character.
  "/api/character": async b => {
    const description = String(b.description ?? "").trim();
    if (description.length < 10 || description.length > MAX_DESCRIPTION) throw new HttpError(400, "Describe them in 10 to 1000 characters.");
    // Moderation's verdict wins even if parsing failed (the model API can reject the same text moderation catches).
    const [blocked, parsed] = await Promise.all([moderate({ description }), parseCharacter(description).catch((e: Error) => e)]);
    if (blocked) throw new HttpError(422, blocked);
    if (parsed instanceof Error) throw parsed;
    if (!parsed) throw new HttpError(422, "Couldn't turn that into a character. Try describing them differently.");
    return { spec: specOf(parsed.spec), bio: parsed.bio }; // after moderation, so a minor gets its message, not a clamp error
  },
  // Character (+ the player's own description) → moderated, Jev's read of the town, a seed, a ranked score.
  "/api/run": async (b, env) => {
    const spec = specOf(b.spec), description = String(b.description ?? "").trim().slice(0, MAX_DESCRIPTION);
    const world = buildWorld(spec), me = world.agents.length - 1;
    const [blocked, jev] = await Promise.all([moderate({ name: spec.name, description }), affinity(spec, description, world)]);
    if (blocked) throw new HttpError(422, blocked);
    const runId = crypto.randomUUID(), seed = randomSeed();
    const score = simulate(world, tuning, { days: DAYS, seed, focus: me, affinity: jev.affinity }).partners[me].length;
    await env.DB.prepare("INSERT INTO runs (id, created, name, score, seed, spec, bio, affinity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(runId, Date.now(), spec.name, score, seed, JSON.stringify(spec), bioOf(b.bio), JSON.stringify(jev.affinity)).run();
    return { runId, seed, spec, affinity: jev.affinity };
  },
  // A run, re-simulated here, put into words.
  "/api/story": async (b, env) => {
    const run = await env.DB.prepare("SELECT spec, bio, seed, affinity FROM runs WHERE id = ?").bind(String(b.runId))
      .first<{ spec: string; bio: string; seed: number; affinity: string | null }>();
    if (!run?.affinity) throw new HttpError(404, "That run has expired.");
    const spec = JSON.parse(run.spec) as PlayerSpec, aff = JSON.parse(run.affinity) as Affinity;
    const world = buildWorld(spec), me = world.agents.length - 1;
    const res = simulate(world, tuning, { days: DAYS, seed: run.seed, focus: me, affinity: aff });
    return story(spec, run.bio, world, res, me);
  },
  // Everyone's runs, best first: name and body count only. `run` adds that run's own rank.
  "/api/leaderboard": async (b, env) => {
    const limit = Math.min(100, Math.max(0, Number(b.limit ?? 50) | 0)), offset = Math.max(0, Number(b.offset ?? 0) | 0);
    const [total, rows, you] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>(),
      env.DB.prepare(`SELECT name, score, rank FROM ${RANKED} ORDER BY rank LIMIT ? OFFSET ?`)
        .bind(limit, offset).all(),
      b.run ? env.DB.prepare(`SELECT rank, name, score FROM ${RANKED} WHERE id = ?`)
        .bind(String(b.run)).first() : null,
    ]);
    return { total: total!.n, rows: rows.results, you };
  },
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname, route = req.method === "POST" ? routes[path] : undefined;
    if (!route) return json(404, { error: "Not found." });
    try {
      // Per-IP limits; the model routes cost money. Cloudflare's limiter counts per location, so it's approximate.
      const limiter = path === "/api/leaderboard" ? env.BOARD_LIMIT : env.AI_LIMIT;
      const { success } = await limiter.limit({ key: `${path}|${req.headers.get("cf-connecting-ip") ?? "?"}` });
      if (!success) throw new HttpError(429, "Slow down: the town needs a minute. Try again shortly.");
      return json(200, await route(await body(req), env));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      if (status === 502) console.error(e);
      return json(status, { error: status === 502 ? "The city is having a moment. Try again." : (e as Error).message });
    }
  },
};
