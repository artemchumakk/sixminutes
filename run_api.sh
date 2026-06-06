#!/usr/bin/env bash
# Serve the scenario API + dashboard. Works from any checkout location.
cd "$(dirname "$0")"
set -a; [ -f ./.env ] && . ./.env; set +a
exec .venv/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8095
