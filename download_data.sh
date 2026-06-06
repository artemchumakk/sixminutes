#!/usr/bin/env bash
# SIXMINUTES — pull every dataset (all URLs verified live 2026-06-06).
# Total ~2.2GB. Re-runnable; skips files that already exist.
set -euo pipefail
cd "$(dirname "$0")/data" 2>/dev/null || { mkdir -p data && cd data; }

get() { [ -f "$2" ] && { echo "skip $2"; return; }; echo "GET $2"; curl -sL --retry 3 -o "$2" "$1"; }

# --- London Fire Brigade (London Datastore) ---
get "https://data.london.gov.uk/download/em8xy/58m/LFB%20Incident%20data%20from%202024%20onwards.xlsx" incidents_2024on.xlsx
get "https://data.london.gov.uk/download/em8xy/f5066d66-c7a3-415f-9629-026fbda61822/LFB%20Incident%20data%20from%202018%20-%202023.xlsx" incidents_2018_2023.xlsx
get "https://data.london.gov.uk/download/24r65/3ff29fb5-3935-41b2-89f1-38571059237e/LFB%20Mobilisation%20data%20from%202021%20-%202024.csv" mob_2021_2024.csv
get "https://data.london.gov.uk/download/24r65/7d5b4e2f-3ddb-48b9-8a4d-bf86bdf6a4ef/LFB%20Mobilisation%20data%20from%202025.csv" mob_2025on.csv
get "https://data.london.gov.uk/download/em8xy/cb9d6550-e502-40a9-a5e4-1f055f31316f/Metadata.xlsx" incidents_metadata.xlsx
get "https://data.london.gov.uk/download/24r65/0eaaa520-1f54-4c33-9008-f394b78206be/Mobilisations%20Metadata.xlsx" mobilisations_metadata.xlsx

# --- NHS AmbSYS (ambulance system indicators, incl. London Ambulance Service) ---
get "https://www.england.nhs.uk/statistics/wp-content/uploads/sites/2/2026/05/AmbSYS-to-Apr-2026-QWZX3.csv" ambsys.csv

# --- Police street-level crime (data.police.uk archive; MPS + City of London extracted) ---
if [ ! -d police ]; then
  get "https://data.police.uk/data/archive/2026-04.zip" police_archive.zip
  unzip -o -q police_archive.zip "*metropolitan-street.csv" "*city-of-london-street.csv" -d police/
fi

echo "DONE. Now: .venv/bin/python etl.py"
