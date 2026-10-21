# sex-and-the-city

Comedy dating sim grounded in real data: create a character, drop them into a town of 500 personas, watch a month.

## Data prep

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
./scripts/download.sh                       # ATUS needs BLS_CONTACT=<email>, or download the zips by hand
.venv/bin/python -I scripts/prep.py         # → data/{personas,calibration,attraction,schedules}.json
.venv/bin/python -I scripts/enrich.py       # → data/traits.json (Claude Batch API, ~$2, needs .env)
```

## Data sources

- Personas: [NVIDIA Nemotron-Personas-USA](https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA), CC BY 4.0. Sampled, filtered to 21+, and extended with generated traits.
- Partner counts and relationship status: [General Social Survey](https://gss.norc.org) 2022 and 2024, NORC at the University of Chicago.
- Attraction model: Fisman, Iyengar, Kamenica & Simonson (2006), speed dating experiment, Columbia University.
- Daily schedules: [American Time Use Survey](https://www.bls.gov/tus/) 2024, U.S. Bureau of Labor Statistics.
- Orientation rates: Gallup LGBTQ+ identification, [2025](https://news.gallup.com/poll/656708/lgbtq-identification-rises.aspx) and [2026](https://news.gallup.com/poll/702206/lgbtq-identification-holds.aspx) reports.

## Simulation

```sh
npm install
npm run dev         # the game at localhost:5173
npm run check       # determinism, 21+ only, and a simulated year vs GSS on held-out seeds (~4s)
npm run calibrate   # refit data/tuning.json against GSS (~10 min)
```

## Known misfits

Where the simulated town still disagrees with reality. Update this list when calibration changes.

- **Young singles' partner counts are the wrong shape.** Women 21-29 are too concentrated (25% with 3+ partners a year vs 14% in GSS, 26% with exactly 1 vs 42%); men 21-29 too thin at the top (14% with 3+ vs 28%). The speed-dating model has men saying yes more (49% vs 37%), so young women collect the most sparks.
- **Men 45-64 cluster at 2 partners** (15% vs 3%) and miss the 3+ tail (4% vs 14%).
- **`openPartnered` (0.1) is a guess, not fitted.** GSS's "2+ partners while partnered" rate (14-15%) counts people who paired up mid-year, so it can't serve as a target.
- **Large fitted knobs.** `chat` 21.7 and `appSwipes` 17 compensate for a quiet town (0.4 nights out a week on average) and most chats being between incompatible people. They're curve-fit, not measured.
- **Few distinct sincerity values.** The LLM gave only 3 levels (7-9); rescaling to the speed-dating spread keeps 3 levels. Per-encounter perception noise smooths it.
- **Dating-app use may be high.** 105 of 180 singles are on apps, including older and widowed people.
- **Speed-dating data is narrow.** Straight NYC grad students, 2002-04, ages 18-55; age-gap effects beyond that range rely on the `agePenalty` and `decline*` knobs.
