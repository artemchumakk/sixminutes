# FIRE TIER + CORE SYSTEM — Artem's Brief (start to finish)

Fire IS the core: the validated tier everything else plugs into. This brief = the
simulator, the scenario API, the agent+voice, the Spark, integration, video, submission.
Rules & rubric: see `README.md` §2–3. Feasibility already done: `FEASIBILITY.md`.

**Clock:** Sat ~18:20 → venue closes 21:00 (≈2h40m) · Sun 08:00 → submit 10:40 (≈2h40m).
**Never-cut list:** validation run · one voice round-trip · overnight agent session ·
demo video · submission. Everything else has a cut line.

---

## TONIGHT

### Block 1 — `sim.py`: the discrete-event simulator core (18:20–19:30) 🔴

The generalization of the already-validated counterfactual engine, now with queueing:

- **State:** stations (from `data/stations.parquet`) × pump count K (derive K from max
  concurrent mobilisations per station in `mobilisations.parquet`, cap 2; default 1).
- **Event loop (heapq):** replay 2024–25 incidents in timestamp order. For each:
  pick nearest AVAILABLE pump by predicted attendance = sampled turnout (empirical
  per station×hourband from mobilisations) + travel from `travel_xgb.json` with
  quantile noise (q10/q90 models exist). Mark pump busy for the incident's
  `PumpMinutesRounded` (fallback: median 45min). Release on completion.
- **Posture parameter:** `Posture(closed={names}, moved={name:(E,N)}, pump_delta={name:±1})`.
- **API:** `simulate(incidents, posture) -> DataFrame[incident_id, sim_attendance_s]`.

**VALIDATION RUN (the rubric moment):** simulate the *real* posture over 2025
incidents → compare sim vs actual `FirstPumpArriving_AttendanceTime`:
mean / median / p90 / distribution overlay. Print + save to `docs/validation.md`.
Target: within ~10–15% on p50/p90. THEN print **incidents/sec** (Performance pts).

Cut line: if queueing fights you >45min, ship busy-tracking with K=1 and say
"pessimistic concurrency" honestly.

### Block 2 — `api.py`: scenario API (19:30–20:15) 🔴

FastAPI, all-local, replay-safe:
- `POST /scenario {close:[], move:{}, weather:"baseline|wet"}` → run on 30k-incident
  2025 sample (<10s) → `{city: {mean_delta, p90_delta}, worst_wards: [...], table: [...]}`
  (wet mode: travel × empirically-fitted rain multiplier if time; else cut)
- `GET /stations`, `GET /baseline`, `GET /layers/{fire|police|ambulance}` (serves
  teammates' GeoJSON from `data/processed/geo/` — contract in README.md §4)
- On startup, background thread: full 102-station closure sweep with queueing →
  `data/processed/fire_damage_v2.parquet` (the sim-grade version of t3)

### Block 3 — `agent.py` + voice (20:15–20:50) 🔴

- Nemotron tool-calling agent (OpenAI-compatible client; env `SIXMINUTES_LLM_*` →
  Nebius `nvidia/nemotron-3-super-120b-a12b`, or Spark vLLM when reachable).
- Tools: `run_scenario(posture)` (hits api.py) · `sql(query)` (DuckDB over parquet) ·
  `recall(question)` (memory search).
- **Memory (bounty-grade):** SQLite `events` table (ts, sim_time, type, location,
  severity, narrative) = structured anomaly registry → exact recall; plus JSONL
  session log `logs/session_<ts>.jsonl` of every utterance/tool call (submission
  artifact). Vector layer (Qwen3-Embedding) only if time Sunday — registry first.
- **Voice:** ElevenLabs TTS out + STT in (push-to-talk CLI loop is fine tonight).
  Record ONE full round-trip on phone video as insurance.

### 20:30 sharp — START THE OVERNIGHT BOUNTY SESSION 🏆

`python agent.py --patrol`: agent watches an accelerated (60×) replay of 2025 days
through the sim, narrates notable events (TTS), writes events + JSONL continuously.
- Plan A: on the Spark (if network fixed) — runs at venue all night.
- Plan B: on this Mac at home — ElevenLabs+Nebius only need internet. Equally valid.
- Supervisor: `while true; do python agent.py --patrol || sleep 5; done` — journal-backed,
  crash loses nothing. By morning: 12h logged session (bounty needs 1h11m).

### 20:50–21:00 — push everything, note status in repo, leave.

Overnight automated (kick off before leaving): Nebius `nemotron-3-super-120b` job
over closure-sweep results + delay-code aggregates + night-turnout table →
`docs/insight_candidates.md` (ranked, with effect sizes).

---

## SUNDAY

| When | What |
|---|---|
| 08:00–08:30 | Harvest: overnight sweep + insight candidates + session logs. **Pick THE insight** (fallbacks: Biggin Hill −0.18 inversion · night turnout +38s · C2 broken promise) |
| 08:30–09:15 | Integrate teammates' parquets → `/layers/*` → dashboard (3rd teammate owns UI; reuse hackathon-written Leaflet shell, tier badges A/B/B–) |
| 09:15–09:45 | Voice rehearsal incl. judge-style recall test ("what happened at minute 14?") against the overnight registry. Replay-mode run with WiFi OFF |
| 09:45–10:25 | **Record 3–5min video in rubric order:** (1) live loop end-to-end (2) NVIDIA stack + Spark story + nvidia-smi (3) validation numbers (4) THE insight (5) voice counterfactual finale (6) performance numbers |
| 10:25–10:40 | **SUBMIT: repo link + description (paste from READMEs/FEASIBILITY) + video.** 10:40, not 10:59 |

## Spark tasks (15 min, whenever network appears)

1. `rsync` repo + parquet → Spark; `uv venv` + deps.
2. Re-train `t2_physics.py` with `device="cuda"` → "trained on DGX Spark" + timing vs Mac.
3. `nvidia-smi` screenshot with models resident (deck asset).
4. vLLM Nemotron-Nano-30B on :8001 → point agent env at it → "zero cloud in the loop".
5. Move overnight session to Spark (Plan A).

## Cut lines (in order, if behind)

wet-weather mode → move-pump (keep closures only) → vector memory (registry suffices)
→ dashboard scenario panel (map + curl is enough) → 102-sweep (use t3 table from repo).
**Never cross the never-cut list.**

## Insight candidates (pick ONE Sunday morning, lead the video with it)

1. **The −0.18 inversion** (Biggin Hill vs Whitechapel) — already computed, guaranteed.
2. **Night turnout penalty +38s** city-wide; map wards that lose the 6-min promise only at night.
3. **Concurrency tax** (NEW, from tonight's sim): % of late arrivals caused by busy
   pumps, not distance — the number nobody has ever published.
4. Cross-service: fire promise holds / ambulance C1 tail fails, same streets (needs ambulance tier).

---

## APPENDED — THE GHOST OPERATOR (fully agentic UI) · green-lit Sat 20:50

**Goal:** type or say "show me X" → the dashboard operates itself like a ghost human:
stations click red, RUN fires, camera pans to the wound, agent narrates (ElevenLabs).

**Architecture:** the agent gets hands — a `ui` tool beside run_scenario/sql/recall.
`POST /ask {text}` → Nemotron emits a CHOREOGRAPHY of fixed safe verbs
(narrate, close_stations, open_2014, compare_postures, run_scenario, focus_ward,
focus_station, show_finding, show_validation, show_metric, reset) → an append-only
command bus (`GET /ui/commands?since=`) → the frontend executes each verb with
~700ms theatrical pacing USING THE SAME JS FUNCTIONS A HUMAN CLICK CALLS.
LLM directs the film; it does not get root on the DOM. Voice routes through the
same pipe (--voice → same agent → wall animates while it speaks).

**API additions:** /ask · /ui/commands · /ui/emit · Scenario gains `open:[...]` +
`baseline:"current"|"pre2014"` (cached 112-station baseline for 2014-mode comparisons)
· static mount for TTS audio · data/lsp5_coords.json (the ten 2014 stations, data-derived).

**Frontend additions:** command bar ("ask the room") · command executor + narration
ticker (typewriter + audio) · presets (Biggin Hill / strike day / 2014 actual /
2014 naive / 2014 optimal) · 2014 Time-Machine mode with ghost stations · findings
rail (−0.18 · 63/52 · 1.47× · Dagenham +47s) · ward polygons (fallback: centroids)
· Duty Log panel tailing the patrol session · vendored Leaflet (WiFi-death-proof).

**Patrol upgrades (fully agentic overnight):** investigate-on-anomaly (agent pulls
ward context via sql, reasons, writes assessment) · autonomous counterfactuals on
clusters (agent runs the simulator UNPROMPTED, records recommendation) · 07:00
self-written morning briefing. Box session untouched tonight (keeps banking logs);
smart patrol runs on the Mac overnight; box gets the new brain Sun 08:05.

**The defense line:** deterministic core, agentic shell — no LLM in the physics;
the agent decides what to investigate, simulate, show, and say.
