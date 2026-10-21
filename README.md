# sex-simulation

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
