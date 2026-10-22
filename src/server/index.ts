// API server: node src/server/index.ts. Keys stay here; the browser only ever sees results.
import { randomInt, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
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

// Every run is ranked forever. The server picks the seed and simulates the month itself, so the score can't be
// forged; the browser replays the same month from the same seed and Jev offsets.
const db = new DatabaseSync(process.env.DB_PATH ?? new URL("../../game.db", import.meta.url).pathname);
db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created INTEGER NOT NULL, name TEXT NOT NULL,
  score INTEGER NOT NULL, seed INTEGER NOT NULL, spec TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS runs_rank ON runs (score DESC, created);`);
const insertRun = db.prepare("INSERT INTO runs (id, created, name, score, seed, spec) VALUES (?, ?, ?, ?, ?, ?)");
const rankOf = db.prepare("SELECT 1 + (SELECT COUNT(*) FROM runs WHERE score > r.score) AS rank, name, score FROM runs r WHERE id = ?");
const page = db.prepare("SELECT name, score, 1 + (SELECT COUNT(*) FROM runs x WHERE x.score > r.score) AS rank FROM runs r ORDER BY score DESC, created LIMIT ? OFFSET ?");
const total = db.prepare("SELECT COUNT(*) AS n FROM runs");

// Jev offsets for the story, which the month needs while it plays. ponytail: in memory, newest 10k, lost on restart.
const recent = new Map<string, { spec: PlayerSpec; bio: string; seed: number; affinity: Affinity }>();
const MAX_RECENT = 10_000;

// Per-IP limits on the routes that cost money (Claude, Jev). ponytail: fixed windows in memory, one process.
const LIMITS: Record<string, { per: number; windowMs: number }> = {
  "/api/character": { per: 20, windowMs: 10 * 60_000 }, "/api/run": { per: 20, windowMs: 10 * 60_000 },
  "/api/story": { per: 30, windowMs: 10 * 60_000 }, "/api/leaderboard": { per: 120, windowMs: 10 * 60_000 },
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
function specOf(v: unknown) {
  try { return clampSpec((v ?? {}) as object); } catch (e) { throw new HttpError(400, (e as Error).message); }
}

const routes: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
  // Free text → moderated, clamped character.
  "/api/character": async b => {
    const description = String(b.description ?? "").trim();
    if (description.length < 10 || description.length > MAX_DESCRIPTION) throw new HttpError(400, "Describe them in 10 to 1000 characters.");
    const [blocked, parsed] = await Promise.all([moderate({ description }), parseCharacter(description)]);
    if (blocked) throw new HttpError(422, blocked);
    if (!parsed) throw new HttpError(422, "Couldn't turn that into a character. Try describing them differently.");
    return parsed;
  },
  // Character (+ the player's own description) → moderated, Jev's read of the town, a seed, a ranked score.
  "/api/run": async b => {
    const spec = specOf(b.spec), description = String(b.description ?? "").trim().slice(0, MAX_DESCRIPTION);
    const world = buildWorld(spec), me = world.agents.length - 1;
    const [blocked, jev] = await Promise.all([moderate({ name: spec.name, description }), affinity(spec, description, world)]);
    if (blocked) throw new HttpError(422, blocked);
    const runId = randomUUID(), seed = randomInt(2 ** 31);
    const score = simulate(world, tuning, { days: DAYS, seed, focus: me, affinity: jev.affinity }).partners[me].length;
    insertRun.run(runId, Date.now(), spec.name, score, seed, JSON.stringify(spec));
    recent.set(runId, { spec, bio: bioOf(b.bio), seed, affinity: jev.affinity });
    if (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value!);
    return { runId, seed, spec, affinity: jev.affinity };
  },
  // A recent run, re-simulated here, put into words.
  "/api/story": async b => {
    const run = recent.get(String(b.runId));
    if (!run) throw new HttpError(404, "That run has expired.");
    const world = buildWorld(run.spec), me = world.agents.length - 1;
    const res = simulate(world, tuning, { days: DAYS, seed: run.seed, focus: me, affinity: run.affinity });
    return story(run.spec, run.bio, world, res, me);
  },
  // Everyone's runs, best first: name and body count only. `run` adds that run's own rank.
  "/api/leaderboard": async b => {
    const limit = Math.min(100, Math.max(0, Number(b.limit ?? 50) | 0)), offset = Math.max(0, Number(b.offset ?? 0) | 0);
    return {
      total: (total.get() as { n: number }).n,
      rows: page.all(limit, offset),
      you: b.run ? rankOf.get(String(b.run)) ?? null : null,
    };
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
