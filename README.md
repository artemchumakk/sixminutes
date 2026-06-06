# WARDEN — London's Blue-Light Digital Twin (formerly SIXMINUTES)

> **Every blue-light service makes London a clock promise — fire: 6 minutes, ambulance: 7, police: 15.
> We built the one engine that knows where each promise breaks — and what it costs to fix it.**

NVIDIA Hack for Impact London · June 5–7 2026 · Track: **Urban Operations**
Team: Artem (core sim + agent + integration) · Police tier (see `README_POLICE.md`) · Ambulance tier (see `README_AMBULANCE.md`)

---

## 1. What this is

A **validated digital twin of London's emergency response network**, built from open data:

- We ingest every LFB incident since 2018 (988k) and every fire-engine mobilisation since 2021 (1.0M, timed to the second), 3.4M police crime records, and NHS ambulance performance series.
- We **learn the city's blue-light physics** (turnout + travel time distributions) from 600k real fire legs — the only service that publishes its full response physics — and **transfer** it to police & ambulance.
- A **discrete-event simulator** replays real historical incidents under counterfactual postures: close a station, move a pump, strike day, storm. Validated against ground truth.
- A **Nemotron agent** (Spark-local) operates the simulator by **voice** (ElevenLabs) and runs persistently overnight (bounty).

### Why it must exist (proven, not claimed — see FEASIBILITY.md)

- London's emergency demand geography repeats like clockwork: **r = 0.96–0.99 year-over-year** on a 1km grid; next year is predictable at **Spearman 0.95–0.98**. You can't predict one fire; you can position for ten thousand.
- Yet station decisions are effectively made by **counting calls** — and call volume correlates **NEGATIVELY (−0.18)** with true closure damage. The spreadsheet method closes the wrong stations.
- The mic-drop: **Biggin Hill (385 calls/yr, quietest tier) is a top-2 most damaging closure (+195s mean, 96 incidents/yr pushed past 10 min). Whitechapel (2,692 calls, 7× busier) is nearly free (+40s).**

## 2. THE RULES (non-negotiable)

1. All code required to run **must be written during the hackathon**. Open-source deps allowed only if open-sourced **≥2 weeks ago**.
2. **"Merely calling GPT-4 via API gets 0 points"** → ZERO OpenAI/Anthropic/Google LLM calls anywhere in the runtime path. LLM = **Nemotron** (Nebius API or Spark-local vLLM). Embeddings = Qwen3-Embedding / NVIDIA rerank.
3. Submissions **must** use City of London open data (our spine: London Datastore LFB datasets ✅) and align with a track (Urban Operations ✅).
4. Do NOT unplug/move the DGX Spark. Building closes **Sat 21:00**, reopens **Sun 08:00**.
5. **Code freeze & submission Sun 11:00** — GitHub repo + project description + **3–5 min demo video**. Form takes 10–15 min → submit by **10:40**. Late = rejected.
6. Teams 3–5 people. Zero drugs/alcohol. Clean up.

## 3. THE RUBRIC (build to it, literally)

| Criterion | Pts | How WE score it |
|---|---|---|
| Completeness | 15 | Full loop: raw data → sim → agent → voice → dashboard, no crashes. Replay mode for WiFi death |
| Technical depth | 15 | Calibrated DES + learned physics + counterfactual engine + cross-service transfer + RAG memory |
| NVIDIA stack | 15 | Nemotron (Spark vLLM + Nebius), nemotron-rerank, XGBoost-GPU on Spark, Parakeet STT fallback |
| Spark story | 15 | 30B agent + sim state + 2.3M-row store + vector memory in one 128GB unified address space; emergency data never leaves the room |
| Insight quality | 10 | −0.18 inversion + named stations; night turnout +38s; C2 = the broken promise |
| Usability | 10 | Output = ranked redeployment briefs a planner can action tomorrow; tier badges = honest confidence |
| Creativity | 10 | Fire data as Rosetta Stone for all blue-light physics; voice-driven counterfactuals |
| Performance | 10 | MEASURE: incidents/sec simulated, full-year-in-N-seconds, sweep of 102 closures |

**Bounties:** ElevenLabs persistent agent (≥1h11m logged session, voice in+out, judges quiz long-term recall — we run it OVERNIGHT on the Spark) + Best Use of Nemotron (RTX 5080).

## 4. Architecture

```
                      ┌─ FIRE  (Tier A: full twin — demand + physics + per-incident validation)
RAW OPEN DATA ────────┼─ POLICE (Tier B: granular demand + transferred physics + aggregate validation)
                      └─ AMBULANCE (Tier B–: proxy demand + transferred physics + AmbSYS validation)
        │
        ▼
CALIBRATION LAYER  — turnout dists per station×hour · XGBoost travel model (medAE 43.8s,
        │            quantiles calibrated 78.8/80) · trained on DGX Spark GPU
        ▼
DES CORE (custom logic) — replay real incidents under counterfactual postures;
        │                 queueing, concurrency, move-ups. Validated vs ground truth
        ▼
SCENARIO API (FastAPI) — POST /scenario {close: [...], move: [...], weather: ...}
        │                → per-cell / per-ward deltas, promise-break maps, ranked briefs
        ▼
NEMOTRON AGENT — tool-calls the sim · episodic vector memory + structured anomaly
        │        registry · Spark-local via vLLM · overnight persistent session
        ▼
ELEVENLABS VOICE (in+out)  +  NEXT.JS MAP DASHBOARD (tier-badged layers)
```

### The canonical integration contract (ALL teammates: conform exactly)

- **CRS: EPSG:27700** (British National Grid, meters). Police data is WGS84 → convert with pyproj.
- **Cell id: `f"E{int(easting//1000)}_N{int(northing//1000)}"`** (1km grid).
- **All times in seconds.** Targets: fire first pump 360s · ambulance C1 mean 420s / p90 900s · police I-grade 900s.
- Each service ships a module `service_<name>.py` exposing:
  ```python
  def load_demand() -> pl.DataFrame      # [cell, gx, gy, weight, category, period]
  def load_stations() -> pl.DataFrame    # [name, E, N, ...]
  def closure_damage() -> pl.DataFrame   # [station, calls, mean_added_s, p90_added_s, pushed_over_target]
  ```
- Processed outputs → `data/processed/<service>_{demand,stations,damage}.parquet`
- Dashboard layers → GeoJSON via `backend /api/layers/{service}` (I wire this; you provide the parquet).

## 5. Repo map & bootstrap

```
README.md / README_POLICE.md / README_AMBULANCE.md   ← you are here
FEASIBILITY.md          ← the validation study (= submission's technical-depth section)
download_data.sh        ← pulls every dataset (verified URLs)
etl.py                  ← fire incidents+mobilisations → parquet
t1*, t2, t3, t5         ← feasibility tests (stability, physics, counterfactual, police)
data/                   ← gitignored; rebuilt by download_data.sh + etl.py
data/processed/         ← integration outputs (gitignored; schemas above)
```

```bash
uv venv && uv pip install polars fastexcel pyarrow numpy scikit-learn xgboost scipy pyproj
bash download_data.sh && .venv/bin/python etl.py
```

**Keys (Nebius LLM, ElevenLabs): NEVER committed. Ask Artem in person.** Env vars:
`SIXMINUTES_LLM_BASE_URL` (Nebius `https://api.studio.nebius.ai/v1` or Spark `http://scan-14.local:8000/v1`),
`SIXMINUTES_LLM_API_KEY`, `SIXMINUTES_LLM_MODEL` (`nvidia/nemotron-3-super-120b-a12b` on Nebius / Nano-30B on Spark), `ELEVENLABS_API_KEY`.

## 6. Timeline & owners (HARD deadlines)

| When | Artem (core) | Police | Ambulance |
|---|---|---|---|
| Sat → 21:00 | DES core + scenario API + first voice round-trip; Spark GPU train; **start overnight agent session ~20:30**; rough demo video | ETL → demand surface + stations table | Proxy surface + AmbSYS targets + stations table |
| Overnight (automated) | Nebius 120B insight miner over scenario sweeps; agent session logs accumulate | — | — |
| Sun 08:00–09:30 | Integrate layers; pick THE insight; polish dashboard | Damage table + validation anchor + GeoJSON | Transfer experiment result + damage table |
| Sun 09:30–10:30 | Final 3–5 min video (rubric order), repo hygiene | review | review |
| **Sun 10:40** | **SUBMIT** | | |

## 7. Engineering rules

- Python 3.12+, uv, type hints, small modules. Per-component error isolation — one bad row/station never kills a loop.
- **Replay mode mandatory**: every demo path must run offline from local parquet (venue WiFi dies → demo lives).
- Log performance numbers as you go (rows/sec, sim speed) — they are literal rubric points.
- Honesty is a feature: every claim carries its validation number; every layer carries its tier badge.
- No secrets in code, ever. `.env` is gitignored.

## 8. Known traps (already hit, already solved)

- **May-2022 ward boundary redraw** breaks ward-name joins → always use the 1km grid or `WardNameNew`.
- LFB xlsx files are slow → parse once to parquet (etl.py), never re-read xlsx.
- Police CSVs have no time-of-day — month granularity only; never claim diurnal precision for police.
- Dwelling coords rounded to 50m (privacy) — irrelevant at 1km.
- RAPIDS cuDF may lack GB10 kernels on the Spark → cuDF lives on Nebius if needed; Spark stack points come from Nemotron vLLM + XGBoost-GPU (verified plan).
