"""Turn raw public datasets into the small JSON files the sim reads.

Run: .venv/bin/python -I scripts/prep.py
Inputs: data/raw/* (scripts/download.sh). Outputs: data/*.json.
"""
import json
import random
from collections import Counter
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / "data/raw", ROOT / "data"
SEED = 42
MIN_AGE = 21  # US bar age; Nemotron contains minors, so this filter is load-bearing
N_PERSONAS = 1000  # the first 500 are the original town, unchanged
AGE_BANDS = [(21, 29), (30, 44), (45, 64), (65, 120)]
PARTNER_BUCKETS = ["0", "1", "2", "3", "4", "5-10", "11+"]


def band(age):
    return next(f"{lo}-{hi}" if hi < 120 else f"{lo}+" for lo, hi in AGE_BANDS if lo <= age <= hi)


def write(name, obj):
    (OUT / name).write_text(json.dumps(obj, indent=1, ensure_ascii=False))
    print(f"wrote data/{name}")


# ---------------------------------------------------------------- GSS 2024
def gss():
    frames = []
    for year in (2022, 2024):  # pooled: single-year cells are ~30-80 respondents
        path = RAW / f"gss/{year}/GSS{year}.dta"
        f = pd.read_stata(path, columns=["partners", "posslqy", "marital", "sex"]).astype(str)
        num = pd.read_stata(path, columns=["age", "wtssps"], convert_categoricals=False)  # age 89 = "89 or older"
        frames.append(f.assign(age=num.age.astype(float), wtssps=num.wtssps.astype(float)))
    df = pd.concat(frames, ignore_index=True)
    df = df[df.age >= MIN_AGE].copy()
    df["band"] = df.age.astype(int).map(band)
    df["partners"] = df.partners.astype(str).map({
        "no partners": "0", "1 partner": "1", "2 partners": "2", "3 partners": "3",
        "4 partners": "4", "5-10 partners": "5-10", "11+ partners": "11+"})  # drops "1 or more, unspecified"

    def dist(g, col, keys):
        g = g.dropna(subset=[col])
        w = g.groupby(col, observed=True).wtssps.sum().reindex(keys, fill_value=0)
        return {"n": len(g), **{k: round(v, 4) for k, v in (w / w.sum()).items()}}

    status = df.posslqy.astype(str).map({
        "i don't have a steady partner": "single",
        "i have a steady partner, and we live in the same household": "partnered",
        "i have a husband or wife or steady partner, but we don't live in the same household": "partnered"})
    unmarried = df[(df.marital.astype(str) != "married")].assign(status=status)

    out = {"source": "GSS 2022 + 2024 cross-sections (NORC), pooled, weighted by wtssps", "partners_last_year_single": {},
           "steady_partner_rate_unmarried": {}}
    for (sex, b), g in df.assign(status=status).groupby(["sex", "band"], observed=True):
        out["partners_last_year_single"][f"{sex}|{b}"] = dist(g[g.status == "single"], "partners", PARTNER_BUCKETS)
    for (sex, b), g in unmarried.groupby(["sex", "band"], observed=True):
        d = dist(g, "status", ["single", "partnered"])
        out["steady_partner_rate_unmarried"][f"{sex}|{b}"] = {"n": d["n"], "partnered": d["partnered"]}
    # Someone on the side: 2+ partners last year while married / in a steady relationship. By sex, all ages.
    taken = pd.concat([df[df.marital == "married"].assign(status="married"),
                       unmarried[unmarried.status == "partnered"]])
    taken = taken.dropna(subset=["partners"]).assign(extra=lambda d: ~d.partners.isin(["0", "1"]))
    out["extra_partner_rate"] = {
        f"{sex}|{st}": {"n": len(g), "rate": round(float((g.extra * g.wtssps).sum() / g.wtssps.sum()), 4)}
        for (sex, st), g in taken.groupby(["sex", "status"])}
    write("calibration.json", out)
    return out


# ---------------------------------------------------- Speed dating → attraction model
FEATURES = ["attr", "sinc", "intel", "fun", "amb", "shar", "int_corr", "samerace", "age_gap"]


def attraction():
    sd = pd.read_csv(RAW / "speeddating/Speed%20Dating%20Data.csv", encoding="latin-1").copy()
    sd = sd.assign(age_gap=(sd.age - sd.age_o).abs())
    sd = sd.dropna(subset=FEATURES + ["dec"])
    out = {"source": "Fisman & Iyengar speed dating 2002-04 (Columbia); dec ~ chooser's ratings of partner",
           "features": FEATURES, "by_chooser": {}}
    for code, sex in [(0, "female"), (1, "male")]:
        g = sd[sd.gender == code]
        m = LogisticRegression(max_iter=1000).fit(g[FEATURES], g.dec)
        auc = roc_auc_score(g.dec, m.predict_proba(g[FEATURES])[:, 1])
        out["by_chooser"][sex] = {
            "intercept": round(float(m.intercept_[0]), 4),
            "coef": dict(zip(FEATURES, np.round(m.coef_[0], 4).tolist())),
            "yes_rate": round(float(g.dec.mean()), 4), "auc": round(float(auc), 3), "n": len(g),
            "feature_mean": g[FEATURES].mean().round(3).to_dict(), "feature_sd": g[FEATURES].std().round(3).to_dict()}
        print(f"  {sex} choosers: n={len(g)} yes={g.dec.mean():.2f} auc={auc:.3f}")
    write("attraction.json", out)


# ------------------------------------------------------- Nemotron → personas
# Gallup LGBTQ+ share by age, 2025 data (news.gallup.com/poll/702206): <30 23%, 30-49 10%, 50+ "3% or less".
# Bisexual share of LGBTQ+ by generation, 2024 data (news.gallup.com/poll/656708).
# ponytail: non-bisexual LGBTQ+ (incl. trans/other) folded into gay/lesbian; Nemotron sex is binary.
def lgbtq_share(age):
    return 0.23 if age < 30 else 0.10 if age < 50 else 0.03


def bi_share(age):  # generation by age in 2026
    return 0.59 if age <= 29 else 0.52 if age <= 45 else 0.44 if age <= 61 else 0.19 if age <= 80 else 0.11


def nemotron_rows(rng, n_requests=10, per=100, cache_name="rows.json"):
    cache = RAW / "nemotron" / cache_name
    if cache.exists():
        return json.loads(cache.read_text())
    rows = []
    for off in rng.sample(range(1_000_000 - per), n_requests):
        url = (f"https://datasets-server.huggingface.co/rows?dataset=nvidia/Nemotron-Personas-USA"
               f"&config=default&split=train&offset={off}&length={per}")
        for attempt in range(6):  # datasets-server 502s and 429s intermittently
            try:
                rows += [r["row"] for r in json.load(urllib.request.urlopen(url, timeout=30))["rows"]]
                break
            except urllib.error.HTTPError:
                if attempt == 5:
                    raise
                time.sleep(5 * 2 ** attempt)
    cache.write_text(json.dumps(rows))
    return rows


# Nemotron has no name column; the full name is the most repeated "First Last" across the persona texts.
NAME = re.compile(r"\b([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)? (?:Mc|Mac|O')?[A-Z][a-zA-Z'\-]+)\b")


LEAD = re.compile(r"([A-Z][a-z][\w'\-]+(?: [A-Z][\w'\-]+)?),?\s+[a-z]")
NOT_NAMES = {"The", "With", "After", "When", "Born", "Raised", "Growing", "Since", "Despite", "Though", "While", "Retired"}


def guess_name(text):
    if (m := LEAD.match(text)) and m.group(1).split()[0] not in NOT_NAMES:  # usually "Amy Smith is…"
        lead = m.group(1)
        if " " in lead:
            return lead
        if full := [n for n in NAME.findall(text) if n.split()[0] == lead]:  # "Joshua …", later "Joshua Reed"
            return full[0]
        if len(re.findall(rf"\b{lead}\b", text)) > 1:  # a first name repeats; "Practical and methodical, …" doesn't
            return lead
    # Places ("New York", "Puerto Rican") repeat too, but a first name also appears alone ("Faye enjoys…").
    def score(cand):
        first = cand.split()[0]
        return len(re.findall(rf"\b{first}\b(?! {cand.split()[1]})", text)) > 0, counts[cand]
    counts = Counter(NAME.findall(text))
    return max(counts, key=score)


def personas(cal):
    rng = random.Random(SEED)
    rows = rng.sample([r for r in nemotron_rows(rng) if int(r["age"]) >= MIN_AGE], 500)
    # The town doubled later: newcomers come from a second sample on their own stream, so the first 500 don't change.
    rng2, seen = random.Random(SEED + 1), {r["uuid"] for r in rows}
    more = [r for r in nemotron_rows(random.Random(SEED + 2), cache_name="rows2.json") if int(r["age"]) >= MIN_AGE and r["uuid"] not in seen]
    rows += rng2.sample(more, N_PERSONAS - 500)
    out = []
    for i, r in enumerate(rows):
        roll_rng = rng if i < 500 else rng2
        age, sex = int(r["age"]), r["sex"].lower()
        name = guess_name(" ".join(r[k] for k in ["persona", "professional_persona", "hobbies_and_interests",
                                                  "cultural_background"]))
        roll = roll_rng.random()
        orientation = ("straight" if roll >= lgbtq_share(age)
                       else "bisexual" if roll < lgbtq_share(age) * bi_share(age) else "gay")
        if r["marital_status"].startswith("married"):
            status = "married"
        else:
            rate = cal["steady_partner_rate_unmarried"].get(f"{sex}|{band(age)}", {}).get("partnered", 0.3)
            status = "partnered" if roll_rng.random() < rate else "single"
        out.append({
            "id": i, "uuid": r["uuid"], "name": name, "sex": sex, "age": age, "orientation": orientation,
            "status": status, "marital_status": r["marital_status"], "education": r["education_level"],
            "occupation": r["occupation"], "hometown": f"{r['city']}, {r['state']}",
            "persona": r["persona"], "professional": r["professional_persona"],
            "hobbies": r["hobbies_and_interests"], "culture": r["cultural_background"]})
    assert all(p["age"] >= MIN_AGE for p in out), "minor in persona sample"
    write("personas.json", out)
    # Slim copy for the browser bundle: the sim needs no persona prose.
    write("town.json", [{k: p[k] for k in ["id", "name", "sex", "age", "orientation", "status", "occupation"]} for p in out])
    s = pd.DataFrame(out)
    print("  ", s.sex.value_counts().to_dict(), s.orientation.value_counts().to_dict(), s.status.value_counts().to_dict(),
          f"age {s.age.min()}-{s.age.max()} median {s.age.median():.0f}")


# The town has 17 single gay men and 19 single gay women: too few for a gay player to compete on the leaderboard.
# Visitors are gay singles from the wider region, drawn from the persona rows the town didn't use, weighted toward
# the ages Gallup says identify as LGBTQ+. They only meet the player, on the apps; the town never sees them.
# Ids follow the town's; `prep.py visitors` re-runs this step alone and leaves the town untouched.
VISITORS_PER_SEX = 120


def visitors():
    town = [p for p in json.loads((OUT / "personas.json").read_text()) if not p.get("visitor")]
    seen, rng = {p["uuid"] for p in town}, random.Random(SEED + 3)
    pool = [r for f in ["rows.json", "rows2.json"] for r in json.loads((RAW / "nemotron" / f).read_text())
            if int(r["age"]) >= MIN_AGE and r["uuid"] not in seen]
    rows = []
    for sex in ["male", "female"]:
        cands = [r for r in pool if r["sex"].lower() == sex]
        keys = {r["uuid"]: rng.random() ** (1 / lgbtq_share(int(r["age"]))) for r in cands}  # weighted sample
        rows += sorted(cands, key=lambda r: -keys[r["uuid"]])[:VISITORS_PER_SEX]
    out = [{"id": len(town) + k, "uuid": r["uuid"], "visitor": True,
            "name": guess_name(" ".join(r[f] for f in ["persona", "professional_persona", "hobbies_and_interests", "cultural_background"])),
            "sex": r["sex"].lower(), "age": int(r["age"]), "orientation": "gay", "status": "single",
            "marital_status": r["marital_status"], "education": r["education_level"], "occupation": r["occupation"],
            "hometown": f"{r['city']}, {r['state']}", "persona": r["persona"], "professional": r["professional_persona"],
            "hobbies": r["hobbies_and_interests"], "culture": r["cultural_background"]} for k, r in enumerate(rows)]
    assert all(p["age"] >= MIN_AGE for p in out), "minor in visitor sample"
    write("personas.json", town + out)
    slim = json.loads((OUT / "town.json").read_text())[:len(town)]
    write("town.json", slim + [{k: p[k] for k in ["id", "name", "sex", "age", "orientation", "status", "occupation", "visitor"]} for p in out])
    ages = sorted(p["age"] for p in out)
    print(f"   {len(out)} visitors, age median {ages[len(ages) // 2]}, under 45: {sum(a < 45 for a in ages)}")


# ------------------------------------------------------------ ATUS → schedules
# TEWHERE codes (ATUS 2024 codebook; checked against activity codes: exercise→31, eating out→4, work→2).
# -1 = location not asked (sleep, grooming), which happens at home.
PLACE = {-1: "home", 1: "home", 2: "work", 3: "friends_home", 4: "restaurant_bar", 5: "worship", 6: "store", 7: "store",
         8: "school", 9: "outdoors", 31: "gym", **{c: "transit" for c in range(12, 22)}, 99: "transit"}
PLACES = ["home", "work", "friends_home", "restaurant_bar", "gym", "store", "outdoors", "worship", "school", "transit",
          "other"]
DAYTYPE = {1: "sun", 2: "weekday", 3: "weekday", 4: "weekday", 5: "weekday", 6: "fri", 7: "sat"}  # TUDIARYDAY


def schedules():
    if not (RAW / "atus/atusact_2024.dat").exists():
        print("skipping schedules: ATUS files missing (see scripts/download.sh)", file=sys.stderr)
        return
    act = pd.read_csv(RAW / "atus/atusact_2024.dat", usecols=["TUCASEID", "TEWHERE", "TUCUMDUR24", "TUACTDUR24"])
    resp = pd.read_csv(RAW / "atus/atussum_2024.dat", usecols=["TUCASEID", "TEAGE", "TELFS", "TUDIARYDAY", "TUFINLWGT"])
    resp = resp[resp.TEAGE >= MIN_AGE]
    resp = resp.assign(group=resp.TELFS.isin([1, 2]).map({True: "employed", False: "not_employed"}) + "|"
                       + resp.TEAGE.map(band) + "|" + resp.TUDIARYDAY.map(DAYTYPE))

    # Diary runs 04:00→04:00. Slot i covers 04:00 + 30i minutes; an activity owns the slots whose midpoint it spans.
    end = act.TUCUMDUR24.to_numpy()
    start = end - act.TUACTDUR24.to_numpy()
    first, last = np.ceil((start - 15) / 30).astype(int), np.ceil((end - 15) / 30).astype(int)
    n = np.clip(last - first, 0, None)
    slots = pd.DataFrame({
        "TUCASEID": np.repeat(act.TUCASEID.to_numpy(), n),
        "slot": np.concatenate([np.arange(f, f + k) for f, k in zip(first, n)]),
        "place": np.repeat(act.TEWHERE.map(PLACE).fillna("other").to_numpy(), n)})
    slots = slots[(slots.slot >= 0) & (slots.slot < 48)].merge(resp, on="TUCASEID")

    out = {"source": "ATUS 2024 (BLS), weighted by TUFINLWGT", "slot_start": "04:00", "slot_minutes": 30,
           "places": PLACES, "groups": {}}
    def probs(d):
        w = d.pivot_table(index="slot", columns="place", values="TUFINLWGT", aggfunc="sum", fill_value=0)
        w = w.reindex(index=range(48), columns=PLACES, fill_value=0)
        return {"n": int(d.TUCASEID.nunique()), "p": w.div(w.sum(axis=1), axis=0).round(4).values.tolist()}

    pooled = {g: probs(d) for g, d in slots.assign(g=slots.group.str.replace(r"\|[^|]+\|", "|", regex=True)).groupby("g")}
    for g, d in slots.groupby("group"):
        out["groups"][g] = probs(d)
        if out["groups"][g]["n"] < 50:  # too few respondents: use all ages for this employment × day type
            emp, _, day = g.split("|")
            out["groups"][g] = {**pooled[f"{emp}|{day}"], "pooled_ages": True}
    write("schedules.json", out)
    print(f"  {len(out['groups'])} groups; pooled across ages: {[g for g, v in out['groups'].items() if 'pooled_ages' in v]}")


# ------------------------------------------------- HCMST 2017→2020 → breakup rates
def breakups():
    """Breakups per year for unmarried couples, by how long they'd been together. Couples partnered in 2017,
    followed up in 2020; time at risk split by relationship age (piecewise-constant hazard)."""
    months = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July",
                                          "August", "September", "October", "November", "December"])}
    d = pd.read_stata(RAW / "hcmst/hcmst.dta")
    d = d[d.w2_section.isin(["C, still partnered w 2017 unmarried partner", "no longer partnered w 2017 unmarried partner"])
          & d.w1_relate_duration_in2017_years.notna()]
    w1, w2 = 2017 + 6.8 / 12, 2020 + 8.3 / 12  # wave 1 fielded Jul-Aug 2017, wave 2 Sep-Oct 2020

    def hazard(g, lo, hi):  # breakups per year while the relationship was lo..hi years old
        events = exposure = n = 0.0
        for _, r in g.iterrows():
            w = r.w2_attrition_adj_weights
            broke = r.w2_section.startswith("no longer")
            end = w2
            if broke and not pd.isna(r.w2_breakup_year):
                end = min(max(r.w2_breakup_year + (months.get(r.w2_breakup_month, 6) + 0.5) / 12, w1), w2)
            elif broke:
                end = (w1 + w2) / 2
            start = max(r.w1_relate_duration_in2017_years, 0)  # relationship age at wave 1
            exposure += w * max(0.0, min(hi, start + end - w1) - max(lo, start))
            if broke and lo <= start + end - w1 < hi:
                events += w; n += 1
        return {"per_year": round(events / exposure, 3), "breakups": int(n)}

    noncohab = d[d.w1_partnership_status_cohab == "in unmarried noncohab partnership"]
    out = {"source": "HCMST 2017-2020 (Rosenfeld, Thomas & Hausen), unmarried couples, weighted by w2_attrition_adj_weights",
           "new_couple_first_6_months": hazard(noncohab, 0, 0.5),  # dating, not living together: couples the sim makes
           "new_couple_6_to_24_months": hazard(noncohab, 0.5, 2),
           "unmarried_any_duration": hazard(d, 0, 100)}           # everyone already partnered when the year starts
    write("breakups.json", out)
    print(" ", out)


if __name__ == "__main__":
    if len(sys.argv) > 1:  # one step, e.g. `prep.py breakups`
        globals()[sys.argv[1]]()
        sys.exit()
    cal = gss()
    attraction()
    personas(cal)
    schedules()
    breakups()
