#!/usr/bin/env bash
# Serve the ambulance scenario API. Mirror of run_api.sh, on port 8096 so it can
# run alongside the fire engine (8095).
cd "$(dirname "$0")"
set -a; [ -f ./.env ] && . ./.env; set +a
exec .venv/bin/python -m uvicorn api_ambulance:app --host 0.0.0.0 --port 8096
