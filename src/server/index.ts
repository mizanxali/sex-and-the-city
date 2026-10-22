// API server: node src/server/index.ts. Keys stay here; the browser only ever sees results.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Affinity, simulate, type Tuning } from "../sim/engine.ts";
import { type PlayerSpec, buildWorld, clampSpec } from "../sim/world.ts";
import "./env.ts";
import { affinity, moderate, parseCharacter, story } from "./ai.ts";

const DAYS = 30;
const tuning = tuningJson as Tuning;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new HttpError(413, "Too much.");
  }
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "Expected JSON."); }
}
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const send = (res: ServerResponse, status: number, data: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));

const bioOf = (v: unknown) => String(v ?? "").slice(0, 200);
const MAX_DESCRIPTION = 1000;

// Runs live here, not in the browser: the story (and later the leaderboard) uses the server's Jev scores, so a
// client can't send its own. ponytail: in memory, newest 10k; lost on restart. SQLite when the leaderboard lands.
const runs = new Map<string, { spec: PlayerSpec; bio: string; affinity: Affinity }>();
const MAX_RUNS = 10_000;

// Per-IP limits on the routes that cost money (Claude, Jev). ponytail: fixed windows in memory, one process.
const LIMITS: Record<string, { per: number; windowMs: number }> = {
  "/api/character": { per: 20, windowMs: 10 * 60_000 }, "/api/run": { per: 20, windowMs: 10 * 60_000 },
  "/api/story": { per: 30, windowMs: 10 * 60_000 },
};
const hits = new Map<string, { start: number; count: number }>();
function limit(route: string, ip: string) {
  const rule = LIMITS[route], key = `${route}|${ip}`, now = Date.now();
  if (!rule) return;
  const h = hits.get(key);
  if (!h || now - h.start > rule.windowMs) { hits.set(key, { start: now, count: 1 }); return; }
  if (++h.count > rule.per) throw new HttpError(429, "Slow down: the town needs a minute. Try again shortly.");
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.start > 60 * 60_000) hits.delete(k); }, 10 * 60_000).unref();
// Railway sits behind a proxy: the client is the first x-forwarded-for hop.
const ipOf = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";
const seedOf = (v: unknown) => (Number.isInteger(v) ? Number(v) : 0);
function specOf(v: unknown) {
  try { return clampSpec((v ?? {}) as object); } catch (e) { throw new HttpError(400, (e as Error).message); }
}

const routes: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
  // Free text → moderated, clamped character.
  "/api/character": async b => {
    const description = String(b.description ?? "").trim();
    if (description.length < 10 || description.length > MAX_DESCRIPTION) throw new HttpError(400, "Describe them in 10 to 1000 characters.");
    const [blocked, parsed] = await Promise.all([moderate(description), parseCharacter(description)]);
    if (blocked) throw new HttpError(422, blocked);
    if (!parsed) throw new HttpError(422, "Couldn't turn that into a character. Try describing them differently.");
    return parsed;
  },
  // Character (+ the player's own description) → moderated, Jev's read of the town, stored as a run.
  "/api/run": async b => {
    const spec = specOf(b.spec), description = String(b.description ?? "").trim().slice(0, MAX_DESCRIPTION);
    const [blocked, jev] = await Promise.all([description ? moderate(description) : null, affinity(spec, description, buildWorld(spec))]);
    if (blocked) throw new HttpError(422, blocked);
    const runId = randomUUID();
    runs.set(runId, { spec, bio: bioOf(b.bio), affinity: jev.affinity });
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
    return { runId, spec, affinity: jev.affinity, appeal: jev.appeal };
  },
  // A stored run on a given seed, re-simulated here, put into words.
  "/api/story": async b => {
    const run = runs.get(String(b.runId));
    if (!run) throw new HttpError(404, "That run has expired.");
    const world = buildWorld(run.spec), me = world.agents.length - 1;
    const res = simulate(world, tuning, { days: DAYS, seed: seedOf(b.seed), focus: me, affinity: run.affinity });
    return story(run.spec, run.bio, world, res, me);
  },
};

const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const route = req.method === "POST" ? routes[req.url ?? ""] : undefined;
  if (!route) return send(res, 404, { error: "Not found." });
  const started = performance.now();
  try {
    limit(req.url!, ipOf(req));
    send(res, 200, await route(await body(req)));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    if (status === 502) console.error(e);
    send(res, status, { error: status === 502 ? "The city is having a moment. Try again." : (e as Error).message });
  } finally {
    console.log(`${req.url} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
  }
}).listen(port, () => console.log(`api on :${port}`));
