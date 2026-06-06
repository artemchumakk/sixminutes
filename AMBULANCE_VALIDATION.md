# Ambulance Tier (B) — Validation & Honesty Log

> **Demand is now REAL.** Per-cell demand comes from the **GLA Ward Atlas** — actual London Ambulance Service incident counts per ward (2012–2014 mean). The old fire-brigade proxy (door-forcings + RTCs, ~120k incidents) has been **retired**. What remains borrowed is the **travel-time physics** (learned from fire mobilisations) and the **within-year timing shape** (LFB 999 call hours), because the Ward Atlas publishes annual ward totals only. Response targets come from real **AmbSYS**. Tier upgraded **B– → B**: real demand + real targets + borrowed travel physics.

## Transfer experiment (headline) — DONE ✅ (re-run on REAL demand)

We applied the **fire-learned travel model** (zero ambulance tuning) to 73 LAS stations + **real Ward-Atlas demand**, simulating 50,000 Category-1 calls.

| metric | simulated | actual (AmbSYS 2024+) | gap (sim vs actual) |
|---|---|---|---|
| C1 mean | **381.1s** | 429.8s | **−11.3%** |
| C1 p90  | **495.5s** | 734.4s | **−32.5%** |

**Reading it honestly:** with **real ambulance demand geography** the borrowed physics reproduces the average C1 response to **within ~11%** (tighter than the −12.8% we got on the fire proxy) with zero ambulance tuning — the multi-service transfer concept holds, and holds *better* once the demand map is real. Our sim **under**-estimates, and the gap widens at the p90 tail. That is the expected direction and is itself the finding: our model is **first-order free-flow** — it assumes the nearest station is always available and never models queueing, crew unavailability, or hospital handover delays. Those operational frictions are exactly what inflate real-world ambulance times, especially the tail. **The gap ≈ a lower bound on the cost of operational friction a pure travel model can't see.** Both numbers are published as-is.

Assumptions documented: hour-of-day sampled from LFB's diurnal incident shape; activation/turnout time sampled (call-weighted) from LFB station turnout medians; `st_idx` feature **neutralised** (set to 0) — the fire model's per-station residual is keyed to specific fire stations and does not transfer, so the sim uses only `[dist, hour, dow, month]`. (Earlier runs that fed ambulance indices injected ~150s of station-aliasing noise and reported a misleadingly larger gap; fixed per audit.)

## Thames barrier routing — DONE ✅ (`service_ambulance._effective_distance`)
Straight-line distance is impossible across a river. We model the Thames as a centre-line `N=f(E)` plus 15 real bridge/tunnel crossings (BNG). If an incident and a station are on **opposite banks**, distance is rerouted via the cheapest crossing (`incident→bridge→station`); same-bank trips keep straight-line. Effect on the aggregate is small (mean 381.1→382.0s — London has stations on both banks) but it corrects the specific cross-river cases the average model got wrong. Coarse (the Isle-of-Dogs meander is smoothed); documented.

## Availability model — DONE ✅ (`ambulance_availability.py`) — closes the p90 gap
The transfer experiment is **free-flow**: it assumes the nearest station always has a crew ready. That is the single biggest simplification, and it is exactly why free-flow p90 (497s) fell short of real (734s). The availability model removes it: a **finite fleet** (~240 double-crewed ambulances on shift, calibrated) serves a week of real-shaped demand; each job ties a unit up for `response + on-scene + handover`, so calls **queue** for the next free unit when demand peaks.

| scenario | mean | p90 | over 900s (C1 target) |
|---|---|---|---|
| free-flow (old) | 382s | 497s | ~0% |
| **availability, normal handover (~25 min)** | **428.8s** | **586.5s** | 0% |
| **availability, crisis handover (~55 min)** | **553.8s** | **726.6s** | 6.6% |
| real (AmbSYS 2024+) | 429.8s | 734.4s | — |

**The finding:** once availability is modelled, the simulated **mean matches reality (428.8s vs 429.8s)** and the **p90 reaches reality only when handover is at crisis levels** — i.e. the gap between free-flow and real *was* the availability/handover effect. The handover sweep shows a **non-linear cliff**: 20→60 min handover drives mean 424→676s, p90 572→1222s, and calls breaching the 900s C1 target 0%→16%. Hospital handover delay is the dominant lever on London's ambulance crisis, and the model now reproduces it. Calibration honesty: `total_units` and `on-scene` are tuned so normal handover reproduces the real mean — the result is the *direction and magnitude* of the effect, not a digit-perfect forecast.

---

## What's built so far (Steps 1–2 ✅)

### Demand — `data/processed/ambulance_demand.parquet` (REAL, GLA Ward Atlas)
Real LAS ambulance demand per ward, built by `etl_ambulance_demand.py` → `load_demand()`:
- **Source:** GLA Ward Atlas "All Ambulance Incidents", mean of 2012–2014 (latest published real ambulance geography). Ward counts mapped to 1km BNG cells by **2011 ward population-centroid** (ONS ArcGIS, `returnCentroid` in EPSG:27700). City of London placed manually (it's a LAD, not a ward). The "London" total pseudo-row (`E12000007`) is dropped to avoid double-counting.
- **Result:** **584 occupied 1km cells; 1,075,092 real ambulance incidents/yr** — this matches LAS's true ~1.1M annual incident volume, a strong external validation. Two real sub-streams kept for colour: assault (31,051/yr) and alcohol-related (32,492/yr).
- Schema: `[cell, gx, gy, weight, category, period]`, category ∈ {proxy_all (= all ambulance), assault, alcohol}. (`proxy_all` name retained for the downstream contract; values are now real counts.)
- **Resolution honesty:** a ward's whole count sits in its centroid 1km cell, so spatial resolution is **ward-level (~600 zones)** — the native resolution of the published data. We do not fake finer resolution than the source supports. Finer (sub-ward) placement would need STATS19 incident coordinates or a live LAS/CAD feed.
- **Why this replaced the fire proxy:** door-forcings + RTCs only captured the ~120k incidents the fire brigade was *also* sent to — a sparse, biased shadow. The Ward Atlas is the real thing.
- **What's still borrowed:** travel-time physics (fire mobilisations) and within-year timing shape (LFB 999 call hours), because the Ward Atlas has no per-incident timing.

### Stations — `data/processed/ambulance_stations.parquet`
- ~73 LAS station locations from OpenStreetMap (bbox over Greater London, both `emergency=` and `amenity=ambulance_station` tags), GPS→BNG via pyproj, deduped within 100m.
- **Limitation:** OSM also lists volunteer St John bases / hospital A&E entries — filtered out by name. Count (73) is consistent with the ~70 LAS stations expected.
- Schema: `[name, E, N]`.

### Answer key — `data/processed/las_targets.parquet`
- LAS rows (`Org Code = "RRU"`) from AmbSYS, time indicators only. Schema `[year, month, c1_mean_s, c1_p90_s, c2_mean_s, c2_p90_s]`.
- **Verified 2024+ averages: C1 mean = 430s, C1 p90 = 734s** (matches the published target exactly). C2 columns also captured (the "broken promise": ~35 min vs 18 min standard).
- Trap handled: AmbSYS columns are code-named (`A25/A26` = C1, `A31/A32` = C2); early rows are "." — cast loosely, sanity-checked by magnitude.

---

## DGX Spark GPU training (Spark-story rubric) ✅
The blue-light travel model our transfer experiment borrows was **(re)trained on the DGX Spark (NVIDIA GB10) GPU** — `device="cuda"`, XGBoost 3.2.0 `USE_CUDA=True` — on 599,849 fire mobilisation legs (435,902 train / 162,365 held-out 2025+).
- **Accuracy reproduces the validated physics:** medAE **43.7s**, MAE 62.0s, R² 0.48 (matches the feasibility study's 43.8s).
- **Honest timing:** GPU fit **1.8s** vs CPU fit **1.6s** (~0.9× — *no speedup at this scale*). At 440k rows × 5 shallow-tree features the data-transfer overhead dominates; GPU only wins on much larger/deeper problems. **We do not claim a GPU speedup** — the Spark value here is that emergency data + training never leave the box, not wall-clock.
- Artifact: `data/travel_xgb_gpu.json` (also on the Spark at `~/sixminutes/data/`). Kept separate — does **not** overwrite the shared `travel_xgb.json`. `service_ambulance.py` auto-prefers it when present.

## Predictive posture engine (`ambulance_posture.py`) ✅
Three scenario tools on the same validated engine — fire physics + demand proxy + 73 LAS stations:
1. **`standby_posture(bucket)`** — time-of-day demand (was time-flat). Splits incidents into night/am/pm/eve and ranks under-served hot cells → where idle units should wait, by hour.
2. **`handover_drain(hospital, n_units, bucket)`** — simulates an A&E tying up N ambulances (removes the N nearest stations), shows which cells breach the C1 standard, and finds the single best standby relocation to patch the worst hole.
3. **`winter_surge(stuck_frac, n_standby)`** — chronic handover backlog ties up a fraction of units citywide; quantifies the coverage hit and how many optimally-placed standby units recover it.

**Honesty:** times are **free-flow** (optimistic — no queueing). The 900s C1 p90 target is never reached in this regime, so the engine operates on the **420s C1 mean standard** and the headline signal is the **scenario delta**, which is robust to the absolute-level optimism. Demand is now **real** (Ward Atlas), but its time-of-day variation is borrowed (LFB shape) — so the hourly signal is driven by traffic-by-hour, not demand moving. No live AVLS vehicle feed yet — plug one in and the same engine runs on real real-time state.

## Conventions (per README integration contract)
EPSG:27700 metres · 1km cell `E{E//1000}_N{N//1000}` · all times in seconds · C1 targets: mean 420s / p90 900s.
