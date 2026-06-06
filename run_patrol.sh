#!/usr/bin/env bash
# Supervised persistent patrol session (ElevenLabs bounty). Crash-safe: memory is
# journal-backed SQLite; restarts lose nothing.
cd "$(dirname "$0")"
set -a; [ -f ./.env ] && . ./.env; set +a
mkdir -p logs
while true; do
  .venv/bin/python agent.py --patrol --speak >> logs/patrol.log 2>&1
  echo "$(date -u) patrol exited rc=$? — restarting in 5s" >> logs/patrol.log
  sleep 5
done
