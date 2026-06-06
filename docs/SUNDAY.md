# SUNDAY RUNBOOK — 08:00 → submit 10:40

Set an alarm for 10:25. The form takes 10–15 min. Late = rejected.

## 08:00–08:20 — harvest the night
```bash
# is the patrol alive? how big is the session?
ssh spark 'cd ~/sixwatch && tmux ls; wc -l logs/session_*.jsonl; ls logs/audio | wc -l; \
  .venv/bin/python -c "import sqlite3; c=sqlite3.connect(\"logs/memory.db\"); \
  print(c.execute(\"SELECT COUNT(*), MAX(minute) FROM events\").fetchone())"'
# pull the bounty artifacts into the repo
rsync -az spark:sixwatch/logs/ ~/Desktop/Code/sixminutes/logs/
cd ~/Desktop/Code/sixminutes && git add -f logs/session_*.jsonl && git commit -m "feat: bounty session logs" && git push
```
If patrol died overnight: logs up to the crash still count (journal-backed). Note the
duration honestly; 1h11m+ was banked by 19:31 Saturday.

## 08:20–09:15 — integrate teammates
- Their parquets land in `data/processed/` per contracts (README.md §4).
- Check: `python -c "import polars as pl; print(pl.read_parquet('data/processed/police_demand.parquet').head())"` etc.
- GeoJSON into `data/processed/geo/` → layers appear via `GET /layers/{svc}` automatically.
- If a teammate misses the deadline: their tier degrades to a slide — do NOT block the video on it.

## 09:15–09:40 — rehearsal
```bash
# local stack
./run_api.sh &        # dashboard :8095
python agent.py --voice
```
Judge-question drill (ask these aloud, confirm answers come from memory/tools):
1. "What happened at minute 14 of your session?"        → registry hit
2. "What do you know about Biggin Hill?"                → seeded finding
3. "Were the 2014 closures a mistake?"                  → 63/52 convergence + better-ten verdict
4. "Close Soho and Whitechapel — who gets hurt?"        → live sim, spoken numbers
5. WiFi-OFF drill: kill wifi, dashboard + sim still work (Parakeet fallback for STT if needed).

## 09:40–10:25 — the video (script: docs/VIDEO_SCRIPT.md, shot checklist at bottom)
Record in one take if possible; the rough clips from Saturday are fallback B-roll.
Upload unlisted YouTube/Drive → paste link into docs/SUBMISSION.md.

## 10:25–10:40 — SUBMIT
- Form fields: copy from docs/SUBMISSION.md verbatim (description, stack story, bounty).
- Repo link + video link + team names.
- Screenshot the confirmation.

## If things are on fire (the bad kind)
- Dashboard breaks → `curl -s localhost:8095/scenario -X POST -H 'Content-Type: application/json' -d '{"close":["Soho"]}' | jq` — the API is the product, the UI is sugar.
- Spark unreachable → everything runs on the Mac (proven); cite the Spark numbers from git history.
- Voice breaks → `python agent.py --chat` + Saturday's recorded voice clip in the video.
