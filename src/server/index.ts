// API server: node src/server/index.ts. Keys stay here; the browser only ever sees results.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Affinity, simulate, type Tuning } from "../sim/engine.ts";
import { buildWorld, clampSpec } from "../sim/world.ts";
import { affinity, moderate, parseCharacter, story } from "./ai.ts";

// .env fills in unset or empty variables (some shells export empty ANTHROPIC_* vars, which break the SDK).
const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
for (const k of Object.keys(process.env)) if (k.startsWith("ANTHROPIC_") && !process.env[k]) delete process.env[k];

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
const seedOf = (v: unknown) => (Number.isInteger(v) ? Number(v) : 0);
function specOf(v: unknown) {
  try { return clampSpec((v ?? {}) as object); } catch (e) { throw new HttpError(400, (e as Error).message); }
}

const routes: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
  // Free text → moderated, clamped character.
  "/api/character": async b => {
    const description = String(b.description ?? "").trim();
    if (description.length < 10 || description.length > 1000) throw new HttpError(400, "Describe them in 10 to 1000 characters.");
    const [blocked, parsed] = await Promise.all([moderate(description), parseCharacter(description)]);
    if (blocked) throw new HttpError(422, blocked);
    if (!parsed) throw new HttpError(422, "Couldn't turn that into a character. Try describing them differently.");
    return parsed;
  },
  // Character → Jev affinity for every compatible persona. The client simulates with it.
  "/api/run": async b => {
    const spec = specOf(b.spec);
    return { spec, affinity: await affinity(spec, bioOf(b.bio), buildWorld(spec)) };
  },
  // Same month, re-simulated here, put into words.
  "/api/story": async b => {
    const spec = specOf(b.spec), world = buildWorld(spec), me = world.agents.length - 1;
    const aff = b.affinity as Affinity | undefined;
    const valid = aff && Array.isArray(aff.toward) && Array.isArray(aff.from) && aff.toward.length === world.agents.length;
    const res = simulate(world, tuning, { days: DAYS, seed: seedOf(b.seed), focus: me,
      affinity: valid ? { agent: me, toward: aff.toward.map(Number), from: aff.from.map(Number) } : undefined });
    return story(spec, bioOf(b.bio), world, res, me);
  },
};

const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const route = req.method === "POST" ? routes[req.url ?? ""] : undefined;
  if (!route) return send(res, 404, { error: "Not found." });
  const started = performance.now();
  try {
    send(res, 200, await route(await body(req)));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    if (status === 502) console.error(e);
    send(res, status, { error: status === 502 ? "The city is having a moment. Try again." : (e as Error).message });
  } finally {
    console.log(`${req.url} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
  }
}).listen(port, () => console.log(`api on :${port}`));
