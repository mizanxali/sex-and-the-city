# sex-and-the-city

Comedy dating sim grounded in real data: create a character, drop them into a town of 1,000 personas, watch a month.

## Data prep

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
./scripts/download.sh                       # ATUS needs BLS_CONTACT=<email>, or download the zips by hand
.venv/bin/python -I scripts/prep.py         # → data/{personas,calibration,attraction,schedules,breakups}.json
.venv/bin/python -I scripts/enrich.py       # → data/traits.json (Claude Batch API, ~$2, needs .env)
```

## Data sources

- Personas: [NVIDIA Nemotron-Personas-USA](https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA), CC BY 4.0. Sampled, filtered to 21+, and extended with generated traits.
- Partner counts and relationship status: [General Social Survey](https://gss.norc.org) 2022 and 2024, NORC at the University of Chicago.
- Attraction model: Fisman, Iyengar, Kamenica & Simonson (2006), speed dating experiment, Columbia University.
- Breakup rates: Rosenfeld, Michael J., Reuben J. Thomas, and Sonia Hausen. 2023. [How Couples Meet and Stay Together 2017-2020-2022](https://data.stanford.edu/hcmst2017) combined dataset. Stanford University Libraries. Its data use agreement asks users to cite it and to tell the contact person (mrosenfe@stanford.edu) about work that uses it.
- Daily schedules: [American Time Use Survey](https://www.bls.gov/tus/) 2024, U.S. Bureau of Labor Statistics.
- Orientation rates: Gallup LGBTQ+ identification, [2025](https://news.gallup.com/poll/656708/lgbtq-identification-rises.aspx) and [2026](https://news.gallup.com/poll/702206/lgbtq-identification-holds.aspx) reports.

## Simulation and game

```sh
npm install
cp .env.example .env  # ANTHROPIC_API_KEY, TYPESAFE_API_KEY
npm run dev         # the game at localhost:5173, no API calls (canned text, no Jev)
npm run dev:api     # API on :8787 + the game, with Claude and Jev
npm run check       # determinism, 21+ only, and a simulated year vs GSS on held-out seeds (~4s)
npm run calibrate   # refit data/tuning.json against GSS (~40 min)
npm run balance     # the player's score spread across 240 random builds, and which choices pay off (~70s)
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

## Game balance

The town is calibrated to real surveys; the player isn't. They're the main character (`MAIN_CHARACTER` in `src/sim/engine.ts`): six conversations per half hour instead of one, half the town's app swipes (more only floods them with matches they have no free evenings for), a logit bonus on yes in both directions (+2 for men, +1 for women, since women in the speed-dating data say yes far less), 3× the hookup odds, bar-hopping across town, and a night that can end at someone's place from 19:00. "Keeping it casual" players never couple up and move on after a hookup; "looking for love" players can couple, which slows the score. Everyone, player included, only swipes on nights in: a dinner, date, bar or party after 18:00 means no apps that night.

Tuned for a typical month of 3-5 partners and 10-15 for strong builds. Last `npm run balance`: median 4.0, 90th percentile 10.7, best random build 15.7; a strong man 11.0, a strong woman 14.7.

- **Apps still decide most of the score** (6.4 a month with, 1.4 without). Dates are the bottleneck: a strong player already has more matches than free evenings.
- **Nights out matter a little** (4.3 at 0 nights, 5.7 at 5), and not at all for the strongest builds, who are capped by evenings.
- **Gay players score lowest** (2.1): the smallest pool. Bisexual players score highest (7.5).

## Known misfits

Where the simulated town still disagrees with reality. Update this list when calibration changes.

- **Young women are too active.** Women 21-29: 31% with 3+ partners a year vs 14% in GSS, 29% with exactly 1 vs 42%; women 30-44 similar (24% vs 15% with 3+). The speed-dating model has men saying yes more (49% vs 37%), and the town has more young single men than women.
- **Young men miss the 3+ tail.** Men 21-29: 17% with 3+ vs 28%, too many with exactly 2 (30% vs 12%). Everyone in the town has similar odds, while in reality a small group has most of the partners.
- **Older men are off both ways.** Men 45-64 cluster at 2 partners (13% vs 3%) and miss the 3+ tail (7% vs 14%); men 65+ are too quiet (79% with none vs 69%).
- **Large fitted knobs.** `chat` 32.5 and `appSwipes` 13.8 compensate for a quiet town (bars empty after dinner) and most chats being between incompatible people. They're curve-fit, not measured.
- **Rare rates overfit the calibration seeds.** The fit picked `openMarried` 0.15 because it matched 16 training seeds; on fresh seeds it doubled the married affair rate, so it's set to 0.10 by hand. The search also stalls in local minima (a second pass found nothing).
- **Breakup rates rest on few couples.** The first-six-months rate (1.66 a year) comes from 15 HCMST breakups. Couples formed in town are treated as dating, not living together, for as long as they last; married couples never split (1.5% a year in HCMST).
- **Few distinct sincerity values.** The LLM gave only 4 levels across 1,000 people; rescaling to the speed-dating spread keeps 4 levels. Per-encounter perception noise smooths it.
- **Dating-app use may be high.** 194 of 333 singles are on apps, including older and widowed people.
- **Speed-dating data is narrow.** Straight NYC grad students, 2002-04, ages 18-55; age-gap effects beyond that range rely on the `agePenalty` and `decline*` knobs.
- **Jev's bias correction is measured on one test character.** Symmetric nudges raise average luck (+11% at the 0.5 spread cap); shifting offsets down by spread²/3 is meant to cancel it. With the main-character boosts, the test character (a 28-year-old man) gets 8.46 partners a month with nudges vs 9.16 without (−8%). Other characters may drift differently.
