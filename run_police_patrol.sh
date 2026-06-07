#!/usr/bin/env bash
# Supervised persistent POLICE patrol session (ElevenLabs bounty). Crash-safe: memory is
# journal-backed SQLite in logs_police/; restarts lose nothing. Needs run_police_api.sh up
# for live counterfactual confirms (degrades gracefully without it).
cd "$(dirname "$0")"
set -a; [ -f ./.env ] && . ./.env; set +a
mkdir -p logs_police
while true; do
  .venv/bin/python police_agent.py --patrol --speak >> logs_police/patrol.log 2>&1
  echo "$(date -u) police patrol exited rc=$? — restarting in 5s" >> logs_police/patrol.log
  sleep 5
done
