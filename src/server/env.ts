// .env fills in unset or empty variables (some shells export empty ANTHROPIC_* vars, which break the SDK).
import { existsSync, readFileSync } from "node:fs";

const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
for (const k of Object.keys(process.env)) if (k.startsWith("ANTHROPIC_") && !process.env[k]) delete process.env[k];
