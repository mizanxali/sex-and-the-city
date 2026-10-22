# sex-and-the-city

Comedy dating sim grounded in real data: create a character, drop them into a town of 1,000 personas, watch a month.

## Data prep

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
./scripts/download.sh                       # ATUS needs BLS_CONTACT=<email>, or download the zips by hand
.venv/bin/python -I scripts/prep.py         # → data/{personas,calibration,attraction,schedules,breakups}.json
.venv/bin/python -I scripts/prep.py visitors  # → 240 out-of-town visitors appended to personas.json and town.json
.venv/bin/python -I scripts/enrich.py       # → data/traits.json (Claude Batch API, ~$2, needs .env; --direct: minutes, full price)
.venv/bin/python -I scripts/icons.py        # → public/og.png, apple-touch-icon.png, favicon.svg (needs npm install)
```

## Data sources

- Personas: [NVIDIA Nemotron-Personas-USA](https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA), CC BY 4.0. Sampled, filtered to 21+, and extended with generated traits. 240 more from the unused sample rows, weighted toward the ages that identify as LGBTQ+, are gay singles from out of town (see Game balance).
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

The 💋 in the favicon and link-preview image is [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Apache 2.0). The game lives at [sexandthecity.fun](https://sexandthecity.fun); that URL is hardcoded in the link-preview tags and the share card.

## Models in the game

The sim decides every outcome; models only judge fit or write words.

| Call | Model | When | Rough cost |
|---|---|---|---|
| Moderate the character description (real person, minor, hateful) | Jev | per description built, and again at release | < $0.001 |
| Description → capped stats + bio | Claude Opus 5.5 | per character | ~1¢ |
| Would each compatible persona date the player, and vice versa | Jev | per run, ~520 personas in 13 parallel requests, ~1s | ~1¢ |
| Feed lines for up to 40 key events | Claude Haiku 5.5 | per run | < 1¢ |
| End-of-month recap | Claude Opus 5.5 (server-side refusal fallback on) | per run | ~2¢ |

Jev reads the player's own description. Its answers become logit nudges on the speed-dating model for judgments involving the player: the differences between people (capped at sd 0.5) decide *who* likes you, and the town's average verdict compared with a plain character's decides *how many*. That verdict is eased toward ±1 logit (tanh, so a better description always helps a little more and the best ones don't tie at a cap): over 40 months, a charming one (+0.54) is worth +21-38% and a great one (+0.76) +24-75%, depending on the build; an off-putting one roughly halves the score. Verdicts are cached per character, so releasing the same character again re-rolls the month, not Jev. The questions tell Jev to weigh concrete details, ignore self-praise and instructions, and ignore race, ethnicity, body size and disability. `npm run jev-check` (~30¢) re-measures the plain-character baseline and checks all three. Last run: a specific, charming description +0.53; a specific but ordinary one −0.52 (worse than leaving it empty, 0); flattery −0.12; a prompt injection −0.09; an unappealing one −0.95; the same description with race, body size or disability changed, within 0.08 of each other.

## Leaderboard

Every run by everyone, ranked forever by body count; only the character name and score are public. The server picks each run's seed, simulates the month itself with its own Jev scores, and stores the score in SQLite (`node:sqlite`, file `game.db`, or `DB_PATH`); the browser replays the same month from the same seed. Names are moderated (real people, slurs, explicit names). "Tweak & try again" reloads the form with the last character filled in, to edit or release unchanged for new dice. The recap's "Share your month" draws a 1080×1350 card in the browser (`src/web/share.ts`: name, body count, rank, the month's headline, the link) and opens the phone's share sheet, or downloads it and copies the link on desktop; "Post on 𝕏" pre-fills a post. Jev scores for the story stay in memory for the newest 10,000 runs. `/api/character`, `/api/run`, `/api/story` and `/api/leaderboard` are limited per IP (20, 20, 30 and 120 per 10 minutes). Without the API the game still runs, unranked, on the calibrated model and canned text.

## Game balance

The town is calibrated to real surveys; the player isn't. They're the main character (`MAIN_CHARACTER` in `src/sim/engine.ts`), and the goal is a leaderboard where a creative description and well-chosen stats both pay, and every kind of character can compete.

- **Odds.** Six conversations per half hour instead of one, always with a single who could be into them; half the town's app swipes, shown only compatible singles; 3× the hookup odds; bar-hopping across town; a night that can end at someone's place from 19:00. The player doesn't lose interest with age.
- **Charm, by who's deciding.** A logit bonus on everyone's yes to the player, keyed on the chooser's sex (women in the speed-dating data say yes far less), in person and on the apps, plus a bonus on the player's own yes by their sex. The player is eager and the town is the hard part, so a description the town likes has room to pay off. These six knobs were fitted together (coordinate search) for equal ceilings across sex × orientation and a ~25% payoff for a charming description.
- **Every stat does something.** Apps see looks only; in person strangers see all five (speed-dating model). Fun multiplies the odds a night out ends at someone's place, sincerity the odds a date does, smarts adds up to +1 logit to in-person first impressions, and ambition books new dates on the next free evening instead of a random one. Every rating has diminishing returns (square root), so spreading points competes with maxing two.
- **Nights out are a bar crawl.** Each one (Fri, Sat, Thu, Wed, Sun, in that order) is 19:00-midnight at the bars, a new bar every hour. Everyone, player included, only swipes on nights in.
- **Out-of-town visitors.** The town has 17 single gay men and 19 single gay women, against ~150 singles for a straight player. A gay player's apps also reach 120 gay singles of their sex from the wider region (`VISITORS` in `src/sim/world.ts`, from `prep.py visitors`). They never move around or meet anyone else; `npm run check` asserts it.
- "Keeping it casual" players never couple up and move on after a hookup; "looking for love" players can couple, which slows the score.

Last `npm run balance`: random builds median 7.7, 90th percentile 14.0, best 18.3. Best build per identity (searching ~100 stat splits, 8 months each): straight man 16.9, straight woman 16.1, bi man 18.6, bi woman 17.1, gay man 14.1, gay woman 14.9.

- **The best stats depend on how you play.** Apps players want looks and ambition; bar-hoppers want fun; a balanced 33-point build lands about 15-20% under the best, the worst about 0-2.
- **Apps, bars and a mix all compete** for straight and bi players (a strong straight man: apps 14.3, mixed 16.0, bars only 11.5; a strong straight woman: 11.6, 12.8, 14.5). Gay players need the apps (bars only: 1.5-5.6), because visitors are only on the apps.
- **Age matters a little.** A strong build at 21 / 28 / 40 / 55: men 14.4 / 16.0 / 16.6 / 10.8, women 11.4 / 12.8 / 14.1 / 11.8.
- **"Looking for love" scores less** (3.9 vs 8.9 across random builds): it's the story mode.

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
- **Identities are close, not equal.** Gay men top out about 15% below straight men and bi men about 10% above, and gay players can't compete without the apps. A typical (default-form) woman scores well under a typical man (7.6 vs 12.8 over 40 months); only the best builds are level. Women's scores also respond more to the description, so at the very top (strong build, great description) women lead by about 10%.
- **Visitors are a game device, not data.** They come from the same persona source, weighted toward the ages Gallup says identify as LGBTQ+, but how many a gay player "reaches" (120) is tuned for the leaderboard.
- **Jev's verdicts are measured on a handful of descriptions.** The plain-character baseline varies by about ±0.15 logit with age and sex (older characters get warmer verdicts), so the same description is worth a few percent more for a 45-year-old. The bias check covers race, body size and wheelchair use on one description; other traits (religion, accent, trans characters) aren't tested.
