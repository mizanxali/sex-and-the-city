# sex-and-the-city

Comedy dating sim grounded in real data: create a character, drop them into a town of 1,000 personas, watch a month.

## Data prep

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
./scripts/download.sh                       # ATUS needs BLS_CONTACT=<email>, or download the zips by hand
.venv/bin/python -I scripts/prep.py         # → data/{personas,calibration,attraction,schedules,breakups}.json
.venv/bin/python -I scripts/enrich.py       # → data/traits.json (Claude Batch API, ~$2, needs .env)
.venv/bin/python -I scripts/icons.py        # → public/og.png, apple-touch-icon.png, favicon.svg (needs npm install)
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
npm run jev-check   # Jev's verdicts on sample descriptions and a bias check (~30¢ of API calls)
```

## Art

All CC0: [KayKit City Builder Bits](https://kaylousberg.itch.io/city-builder-bits) by Kay Lousberg (downtown, roads, props), and Kenney's [City Kit Suburban](https://kenney.nl/assets/city-kit-suburban) (houses, trees, recoloured per house with its variation textures) and [Mini Characters](https://kenney.nl/assets/mini-characters) (people). Licences in `public/models/`.

The 💋 in the favicon and link-preview image is [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Apache 2.0). Set `SITE_URL` when building (`SITE_URL=https://… npm run build`) so the link-preview image URL is absolute.

## Models in the game

The sim decides every outcome; models only judge fit or write words.

| Call | Model | When | Rough cost |
|---|---|---|---|
| Moderate the character description (real person, minor, hateful) | Jev | per description built, and again at release | < $0.001 |
| Description → capped stats + bio | Claude Opus 5.5 | per character | ~1¢ |
| Would each compatible persona date the player, and vice versa | Jev | per run, ~520 personas in 13 parallel requests, ~1s | ~1¢ |
| Feed lines for up to 40 key events | Claude Haiku 5.5 | per run | < 1¢ |
| End-of-month recap | Claude Opus 5.5 (server-side refusal fallback on) | per run | ~2¢ |

Jev reads the player's own description. Its answers become logit nudges on the speed-dating model for judgments involving the player: the differences between people (capped at sd 0.5) decide *who* likes you, and the town's average verdict compared with a plain character's (capped at ±1 logit, about ±35% partners a month) decides *how many*. The questions tell Jev to weigh concrete details, ignore self-praise and instructions, and ignore race, ethnicity, body size and disability. `npm run jev-check` (~30¢) re-measures the plain-character baseline and checks all three. Last run: a specific, charming description +0.61; flattery −0.15; a prompt injection −0.07; an unappealing one −1 (the cap); the same description with race, body size or disability changed, within 0.08 of each other.

## Leaderboard

Every run by everyone, ranked forever by body count; only the character name and score are public. The server picks each run's seed, simulates the month itself with its own Jev scores, and stores the score in SQLite (`node:sqlite`, file `game.db`, or `DB_PATH`); the browser replays the same month from the same seed. Names are moderated (real people, slurs, explicit names). "Run it back" releases the same character again: a new run with new dice. The recap's "Share your month" draws a 1080×1350 card in the browser (`src/web/share.ts`: name, body count, rank, the month's headline, the GSS reality line, the link) and opens the phone's share sheet, or downloads it and copies the link on desktop; "Post on 𝕏" pre-fills a post. Jev scores for the story stay in memory for the newest 10,000 runs. `/api/character`, `/api/run`, `/api/story` and `/api/leaderboard` are limited per IP (20, 20, 30 and 120 per 10 minutes). Without the API the game still runs, unranked, on the calibrated model and canned text.

## Game balance

The town is calibrated to real surveys; the player isn't. They're the main character (`MAIN_CHARACTER` in `src/sim/engine.ts`): six conversations per half hour instead of one, half the town's app swipes (more only floods them with matches they have no free evenings for), a logit bonus on yes in both directions (+2 for men, +1 for women, since women in the speed-dating data say yes far less), 3× the hookup odds, bar-hopping across town, and a night that can end at someone's place from 19:00. "Keeping it casual" players never couple up and move on after a hookup; "looking for love" players can couple, which slows the score. Everyone, player included, only swipes on nights in: a dinner, date, bar or party after 18:00 means no apps that night.

The description is a stat too: the town's overall verdict on it moves the score by up to about ±35% (`npm run check`: 9.1 partners a month without, 12.5 at the maximum). Tuned, before that, for a typical month of 3-5 partners and 10-15 for strong builds. Last `npm run balance`: median 4.0, 90th percentile 10.7, best random build 15.7; a strong man 11.0, a strong woman 14.7.

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
- **Jev's verdicts are measured on a handful of descriptions.** The plain-character baseline varies by about ±0.15 logit with age and sex (older characters get warmer verdicts), so the same description is worth a few percent more for a 45-year-old. The bias check covers race, body size and wheelchair use on one description; other traits (religion, accent, trans characters) aren't tested.
