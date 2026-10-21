"""One-time: give each persona the dating-sim traits Nemotron doesn't have, via the Batches API (50% off).

Run: .venv/bin/python -I scripts/enrich.py   (needs ANTHROPIC_API_KEY in .env)
Reads data/personas.json, writes data/traits.json keyed by persona id.
Re-running resumes the saved batch instead of paying for a new one; delete data/raw/enrich_batch.txt to redo.
"""
import json
import os
import time
from statistics import NormalDist
from pathlib import Path

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

ROOT = Path(__file__).resolve().parent.parent
BATCH_FILE = ROOT / "data/raw/enrich_batch.txt"

for line in (ROOT / ".env").read_text().splitlines() if (ROOT / ".env").exists() else []:
    k, _, v = line.partition("=")
    if k.strip() and not k.startswith("#") and not os.environ.get(k.strip()):  # empty shell vars don't count
        os.environ[k.strip()] = v.strip()
for k in [k for k, v in os.environ.items() if k.startswith("ANTHROPIC_") and not v]:
    del os.environ[k]  # an empty ANTHROPIC_BASE_URL / AUTH_TOKEN breaks the SDK

INTERESTS = [
    "fitness", "running", "outdoors", "cooking", "eating out", "wine and cocktails", "craft beer", "live music",
    "dancing", "art and museums", "reading", "video games", "movies and tv", "watching sports", "travel",
    "gardening", "diy and crafts", "religion", "volunteering", "tech", "pets", "fashion", "yoga and wellness",
    "board games"]

SYSTEM = f"""You are casting the residents of a comedic dating simulation game. You'll get one real-seeming \
persona. Fill in the traits the simulation needs, staying true to the persona's age, job, life stage, \
relationship status and personality as written. Most people are ordinary: avoid making everyone \
outgoing, adventurous or charming. A 70-year-old married accountant rarely goes clubbing.

Field guide:
- nightlife: nights per week out at bars, clubs or parties (0-5).
- gym: gym visits per week (0-6).
- dating_apps: true only if single and plausibly using apps right now.
- gossip: 0-1, how likely they are to tell friends about someone they met.
- sincerity, intelligence, fun, ambition: 1-10, how a stranger would rate them on a 4-minute date \
(speed-dating scale; average is about 6-7, use the full range).
- interests: 2-5 tags from exactly this list: {", ".join(INTERESTS)}.
- type: one short sentence on who they go for.
- dealbreaker: one short, specific, funny sentence.
- flirting_style: one short sentence on how they flirt (or fail to).

Keep everything tasteful and non-explicit."""

SCHEMA = {
    "type": "object",
    "properties": {
        "nightlife": {"type": "integer"}, "gym": {"type": "integer"}, "dating_apps": {"type": "boolean"},
        "gossip": {"type": "number"}, "sincerity": {"type": "integer"}, "intelligence": {"type": "integer"},
        "fun": {"type": "integer"}, "ambition": {"type": "integer"},
        "interests": {"type": "array", "items": {"type": "string", "enum": INTERESTS}},
        "type": {"type": "string"}, "dealbreaker": {"type": "string"}, "flirting_style": {"type": "string"},
    },
    "required": ["nightlife", "gym", "dating_apps", "gossip", "sincerity", "intelligence", "fun", "ambition",
                 "interests", "type", "dealbreaker", "flirting_style"],
    "additionalProperties": False,
}


def prompt(p):
    return "\n".join(f"{k}: {p[k]}" for k in ["name", "sex", "age", "orientation", "status", "education",
                                              "occupation", "persona", "professional", "hobbies", "culture"])


def clamp(t):  # schema can't express ranges; enforce them here
    c = lambda v, lo, hi: max(lo, min(hi, v))
    return {**t, "nightlife": c(t["nightlife"], 0, 5), "gym": c(t["gym"], 0, 6), "gossip": c(t["gossip"], 0, 1),
            **{k: c(t[k], 1, 10) for k in ["sincerity", "intelligence", "fun", "ambition"]}}


def rescale(traits):
    """The LLM ranks people sensibly but squeezes ratings (sincerity came back 7-9, mean 8.2).
    Keep its ordering, map ranks onto the speed-dating rating distribution (mean/sd of both chooser sexes)."""
    att = json.loads((ROOT / "data/attraction.json").read_text())["by_chooser"].values()
    for ours, theirs in [("sincerity", "sinc"), ("intelligence", "intel"), ("fun", "fun"), ("ambition", "amb")]:
        dist = NormalDist(sum(a["feature_mean"][theirs] for a in att) / 2, sum(a["feature_sd"][theirs] for a in att) / 2)
        ids = sorted(traits, key=lambda i: traits[i][ours])
        ranks = {}
        for v in {traits[i][ours] for i in ids}:  # ties share their average rank
            pos = [k for k, i in enumerate(ids) if traits[i][ours] == v]
            ranks[v] = (sum(pos) / len(pos) + 0.5) / len(ids)
        for i in ids:
            traits[i][ours] = round(max(1.0, min(10.0, dist.inv_cdf(ranks[traits[i][ours]]))), 2)


def main():
    personas = json.loads((ROOT / "data/personas.json").read_text())
    client = anthropic.Anthropic()
    if BATCH_FILE.exists():
        batch_id = BATCH_FILE.read_text().strip()
    else:
        batch_id = client.messages.batches.create(requests=[
            Request(custom_id=str(p["id"]), params=MessageCreateParamsNonStreaming(
                model="claude-opus-5-5",
                max_tokens=4000,
                system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": prompt(p)}],
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            )) for p in personas]).id
        BATCH_FILE.write_text(batch_id)
    print("batch", batch_id)

    while (b := client.messages.batches.retrieve(batch_id)).processing_status != "ended":
        print(f"  {b.request_counts.processing} processing, {b.request_counts.succeeded} done")
        time.sleep(30)

    traits, failed = {}, []
    for r in client.messages.batches.results(batch_id):
        msg = r.result.message if r.result.type == "succeeded" else None
        if msg is None or msg.stop_reason != "end_turn":
            failed.append((r.custom_id, r.result.type, msg and msg.stop_reason))
            continue
        traits[r.custom_id] = clamp(json.loads(next(b.text for b in msg.content if b.type == "text")))
    rescale(traits)
    (ROOT / "data/traits.json").write_text(json.dumps(traits, indent=1, ensure_ascii=False))
    print(f"wrote data/traits.json: {len(traits)} ok, {len(failed)} failed {failed[:10]}")


if __name__ == "__main__":
    main()
