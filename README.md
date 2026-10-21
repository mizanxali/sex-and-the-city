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

## Simulation and game

```sh
npm install
cp .env.example .env  # ANTHROPIC_API_KEY, TYPESAFE_API_KEY
npm run dev         # the game at localhost:5173, no API calls (canned text, no Jev)
npm run dev:api     # API on :8787 + the game, with Claude and Jev
npm run check       # determinism, 21+ only, and a simulated year vs GSS on held-out seeds (~4s)
npm run calibrate   # refit data/tuning.json against GSS (~10 min)
```

## Art

All CC0: [KayKit City Builder Bits](https://kaylousberg.itch.io/city-builder-bits) by Kay Lousberg (downtown, roads, props), and Kenney's [City Kit Suburban](https://kenney.nl/assets/city-kit-suburban) (houses, trees, recoloured per house with its variation textures) and [Mini Characters](https://kenney.nl/assets/mini-characters) (people). Licences in `public/models/`.

## Models in the game

The sim decides every outcome; models only judge fit or write words.

| Call | Model | When | Rough cost |
|---|---|---|---|
| Moderate the character description (real person, minor, hateful) | Jev | per character | < $0.001 |
| Description → capped stats + bio | Claude Opus 5.5 | per character | ~1¢ |
| Would each compatible persona date the player, and vice versa | Jev | per run, ~270 personas in 7 parallel requests, ~0.5s | < $0.01 |
| Feed lines for up to 40 key events | Claude Haiku 5.5 | per run | < 1¢ |
| End-of-month recap | Claude Opus 5.5 (server-side refusal fallback on) | per run | ~2¢ |

Jev's answers become zero-mean logit nudges on the calibrated speed-dating model for judgments involving the player, so the town's calibrated rates hold. Without the API the game still runs on the calibrated model and canned text.

## Known misfits

Where the simulated town still disagrees with reality. Update this list when calibration changes.

- **Young singles' partner counts are the wrong shape.** Women 21-29 are too concentrated (25% with 3+ partners a year vs 14% in GSS, 26% with exactly 1 vs 42%); men 21-29 too thin at the top (14% with 3+ vs 28%). The speed-dating model has men saying yes more (49% vs 37%), so young women collect the most sparks.
- **Men 45-64 cluster at 2 partners** (15% vs 3%) and miss the 3+ tail (4% vs 14%).
- **`openPartnered` (0.1) is a guess, not fitted.** GSS's "2+ partners while partnered" rate (14-15%) counts people who paired up mid-year, so it can't serve as a target.
- **Large fitted knobs.** `chat` 21.7 and `appSwipes` 17 compensate for a quiet town (0.4 nights out a week on average) and most chats being between incompatible people. They're curve-fit, not measured.
- **Few distinct sincerity values.** The LLM gave only 3 levels (7-9); rescaling to the speed-dating spread keeps 3 levels. Per-encounter perception noise smooths it.
- **Dating-app use may be high.** 105 of 180 singles are on apps, including older and widowed people.
- **Speed-dating data is narrow.** Straight NYC grad students, 2002-04, ages 18-55; age-gap effects beyond that range rely on the `agePenalty` and `decline*` knobs.
- **Jev's bias correction is measured on one test character.** Symmetric nudges raise average luck (+11% at the 0.5 spread cap); shifting offsets down by spread²/3 cancelled it for a 28-year-old man (0.62 vs 0.63 partners a month). Other characters may drift by a few percent.
