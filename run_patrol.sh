#!/usr/bin/env bash
# Supervised persistent patrol session (ElevenLabs bounty). Crash-safe: memory is
# journal-backed SQLite; restarts lose nothing. Exponential backoff stops a
# crash-loop from spamming the registry (the Sat-night lesson).
cd "$(dirname "$0")"
set -a; [ -f ./.env ] && . ./.env; set +a
mkdir -p logs
backoff=5
while true; do
  start=$(date +%s)
  .venv/bin/python agent.py --patrol --speak >> logs/patrol.log 2>&1
  rc=$?
  dur=$(( $(date +%s) - start ))
  if [ "$dur" -gt 120 ]; then backoff=5; else backoff=$(( backoff * 4 )); [ "$backoff" -gt 600 ] && backoff=600; fi
  echo "$(date -u) patrol exited rc=${rc} after ${dur}s — restart in ${backoff}s" >> logs/patrol.log
  sleep "$backoff"
done
