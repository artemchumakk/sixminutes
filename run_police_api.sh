#!/usr/bin/env bash
# Serve the POLICE scenario API + dashboard (Tier B). Coexists with the fire API on :8095.
cd "$(dirname "$0")"
set -a; [ -f ./.env ] && . ./.env; set +a
exec .venv/bin/python -m uvicorn police_api:app --host 0.0.0.0 --port 8096
