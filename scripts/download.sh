#!/usr/bin/env bash
# Fetch raw public datasets into data/raw/<source>/. Re-runnable; skips files already present.
set -euo pipefail
cd "$(dirname "$0")/../data/raw"
UA="Mozilla/5.0 (sex-simulation data prep)"

get() { # dir url [user-agent]
  local f="$1/$(basename "$2")"
  [ -s "$f" ] || curl -fsSL -A "${3:-$UA}" -o "$f" "$2"
  case "$f" in *.zip) unzip -qo "$f" -d "$1" ;; esac
}

# GSS 2022 + 2024 cross-sections (NORC), pooled — PARTNERS, SEXFREQ for calibration
for y in 2022 2024; do get gss https://gss.norc.org/content/dam/gss/get-the-data/documents/stata/${y}_stata.zip; done
# Columbia speed dating experiment (Fisman & Iyengar), via Gelman ARM examples (OpenML mirror unreachable)
get speeddating "http://www.stat.columbia.edu/~gelman/arm/examples/speed.dating/Speed%20Dating%20Data.csv"

# ATUS 2024 (BLS) — activity file has where/when, summary file has age/sex/day.
# BLS 403s any request whose User-Agent lacks a contact email.
if [ -n "${BLS_CONTACT:-}" ]; then
  get atus https://www.bls.gov/tus/datafiles/atusact-2024.zip "sex-simulation-dataprep ($BLS_CONTACT)"
  get atus https://www.bls.gov/tus/datafiles/atussum-2024.zip "sex-simulation-dataprep ($BLS_CONTACT)"
else
  echo "skipping ATUS: set BLS_CONTACT=<your email> (BLS requires it in the User-Agent)" >&2
fi

ls -R . | head -40
