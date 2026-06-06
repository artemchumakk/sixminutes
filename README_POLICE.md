# POLICE TIER — Your Complete Brief

You own the **police layer** of SIXMINUTES (read `README.md` first — concept, architecture, integration contract). This file contains everything you need: rules, rubric, your data (already verified + downloaded), your tasks in priority order, exact output schemas, and the traps.

## 0. Context in 30 seconds

We're building London's blue-light digital twin. Fire is the validated core (full response physics from 600k timed legs). **Your job: the police demand + counterfactual layer (Tier B)** — granular crime demand, transferred travel physics, validated against published aggregates. Feasibility for your tier is ALREADY PROVEN (see FEASIBILITY.md Test 5): 3,423,129 records, demand stability Spearman **0.952** (violence 0.949, robbery 0.930) on the 1km grid. You're not exploring — you're building on certified ground.

## 1. Hackathon rules (your obligations too)

1. All running code written **during** the hackathon; OSS deps only if ≥2 weeks old.
2. **No OpenAI/Anthropic/Google LLM calls anywhere** — "merely calling GPT-4 = 0 points". Any LLM use = Nemotron (ask Artem for env keys; never commit them).
3. Building closes **Sat 21:00**, reopens **Sun 08:00**. Code freeze + submission **Sun 11:00** (we submit 10:40).
4. Don't touch/move the DGX Spark hardware.

## 2. Rubric — what YOUR work scores

- **Technical depth (15):** your counterfactual damage table = "custom logic", your validation anchor = rigor.
- **Insight (10):** police-layer insight candidates below — one concrete non-obvious finding wins this.
- **Usability (10):** your damage table reads as "which front counters / bases matter most" — a real MOPAC analyst decision.
- **Completeness (15):** your parquet outputs integrate into the live dashboard without crashing.

## 3. Your data (verified live today)

| Dataset | Where | Status |
|---|---|---|
| Street-level crime, MPS + City of London, **May 2023–Apr 2026** (36 months) | `bash download_data.sh` → `data/police/<YYYY-MM>/*.csv` (1.7GB archive from [data.police.uk](https://data.police.uk/data/)) | ✅ downloaded + stability-certified |
| Columns | `Crime ID, Month, Longitude, Latitude, LSOA code/name, Crime type, Last outcome` | note: **no time-of-day**, snap-point anonymized coords |
| MPS estate / station locations | London Datastore — search "MPS front counters" / "MPS estate"; **fallback: OSM** `amenity=police` (Overpass snippet below) | ⚠️ you verify tonight |
| Response-time validation anchors | Met FOI: force/borough averages by call grade 2019–2024 ([met.police.uk FOI](https://www.met.police.uk/foi-ai/metropolitan-police/disclosure-2024/august-2024/police-response-times-january2019-july2024/)); I-grade target = 15 min | ⚠️ you fetch the FOI tables |

OSM fallback for stations:
```bash
curl -s "https://overpass-api.de/api/interpreter" --data-urlencode \
 'data=[out:json][timeout:90];area["name"="Greater London"]->.a;nwr["amenity"="police"](area.a);out center;' > data/police_stations_osm.json
```

## 4. YOUR TASKS (priority order — stop anywhere, every step ships value)

### T1 — ETL → canonical demand surface (tonight, ~1.5h) 🔴 critical
`service_police.py :: load_demand()`. Read all 72 CSVs (polars), drop null coords, **convert WGS84→EPSG:27700 with pyproj** (the canonical grid is BNG — see README integration contract; my t5 test used an approximate grid, yours must be exact):
```python
from pyproj import Transformer
t = Transformer.from_crs(4326, 27700, always_xy=True)
E, N = t.transform(lon_array, lat_array)   # vectorized
cell = f"E{int(E//1000)}_N{int(N//1000)}"
```
Output `data/processed/police_demand.parquet`: `[cell, gx, gy, weight, category, period]` where weight = monthly mean count, category ∈ {all, violence, burglary, robbery, asb, vehicle, theft}, period ∈ {Y1,Y2,Y3, all}. Sanity: totals match t5 (3.42M), top cells = West End.

### T2 — Stations table (tonight, ~1h) 🔴 critical
`load_stations()` → `data/processed/police_stations.parquet` `[name, E, N, kind]` (kind: station/front_counter/base). Datastore first, OSM fallback. Dedupe within 100m. Expect ~70–150 in Greater London.

### T3 — Closure damage table (Sun AM, ~1.5h) 🟠 the thesis, police edition
Mirror `t3_counterfactual.py` (read it — the pattern is exactly transferable): for each violence-weighted demand cell, nearest station vs nearest-after-closure using **the shared travel model** `data/travel_xgb.json` (fire-learned physics; load with xgboost, features `[dist_m, hour, dow, month, st_idx]` — use hour=12 fixed + note the caveat, since police data has no hour). Output `closure_damage()` → `data/processed/police_damage.parquet` `[station, calls, mean_added_s, p90_added_s, pushed_over_target]` (target 900s I-grade).
**Question your table answers on camera:** "Does call-volume ranking invert for police bases like it does for fire stations (−0.18)?"

### T4 — Validation anchor (Sun AM, ~45min) 🟠
Pull Met FOI response aggregates (I/S grade, borough/monthly where available) into `data/processed/police_response_anchors.parquet` + a 10-line `POLICE_VALIDATION.md`: our transferred-physics simulated I-grade distribution vs published averages, % gap, honest statement of Tier B confidence.

### T5 — Insight candidates (whenever you see one, write it down) 🟡
- Violence demand vs station coverage **equity map** — which high-violence cells are farthest from any base?
- Front-counter closures (dozens closed since 2017) — damage table for what was lost (historical counterfactual!).
- Robbery hotspot persistence (your 0.930) — "the same 40 cells, every year".
Drop findings into `docs/insights_police.md` with numbers.

### T6 — GeoJSON payloads (Sun, 30min) 🟡
Per category: `data/processed/geo/police_<category>.geojson` (cell polygons or centroids + weight). Artem wires them to the map.

## 5. Traps (learned the hard way today)

- **No hour-of-day in police data** — never claim diurnal patterns; spatial only. (LFB diurnal ≠ crime diurnal; don't borrow.)
- Snap-point anonymization (~street anchors) — fine at 1km, NEVER claim address precision.
- LSOA codes are 2021-vintage — don't join to older LSOA tables without checking.
- A few records have null/zero coords — drop, count, report the drop rate.
- `Crime ID` can be null/duplicate (anonymization) — never assume uniqueness; count rows, not IDs.

## 6. Definition of done

- [ ] `service_police.py` with the 3 contract functions, type-hinted, runs from clean checkout via `download_data.sh`
- [ ] 3 parquet outputs in `data/processed/` matching schemas exactly
- [ ] `POLICE_VALIDATION.md` with the aggregate comparison number
- [ ] 1+ insight in `docs/insights_police.md` with a number in it
- [ ] Nothing crashes on a cell/station with zero data (try Heathrow cells)
- [ ] No secrets committed
