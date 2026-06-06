# AMBULANCE TIER — Your Complete Brief

You own the **ambulance layer** of SIXMINUTES (read `README.md` first — concept, architecture, integration contract). This brief is self-contained: rules, rubric, your data (verified today), tasks in priority order, exact schemas, traps.

## 0. Context in 30 seconds

We're building London's blue-light digital twin. Fire is the validated core. **Your job: the ambulance layer (Tier B–) and the single most scientific moment of the demo — the TRANSFER EXPERIMENT:** we learned London's blue-light travel physics from 600k fire legs; you test whether that physics, applied to LAS stations + your demand proxy, reproduces London Ambulance Service's *real published* response times (C1 mean 430s, C1 p90 734s — already extracted to `data/ambsys.csv`). If your simulation lands within ~10–15%, the transfer is validated and the whole multi-service concept is scientifically armed.

## 1. Hackathon rules (your obligations too)

1. All running code written **during** the hackathon; OSS deps only if ≥2 weeks old.
2. **No OpenAI/Anthropic/Google LLM calls anywhere** — "merely calling GPT-4 = 0 points". Any LLM = Nemotron (ask Artem for keys; never commit).
3. Building closes **Sat 21:00**, reopens **Sun 08:00**. Code freeze + submission **Sun 11:00** (we submit 10:40).
4. Don't touch/move the DGX Spark hardware.

## 2. Rubric — what YOUR work scores

- **Technical depth (15):** the transfer experiment is cross-service model validation — judges have not seen this elsewhere.
- **Insight (10):** "**C2 is the broken promise**" — LAS C2 mean is **33.8 min vs the 18-min national standard** (it's in the data you already have). Where do those tails live? Your map answers it.
- **Creativity (10):** using fire-brigade door-forcing incidents as an ambulance demand proxy is exactly the "combine data in a novel way" line item.
- **Usability (10):** your damage table = "which ambulance station closures/moves hurt least" — an honest, tier-badged planning aid.

## 3. Your data (verified live today)

| Dataset | Where | Status |
|---|---|---|
| **AmbSYS** — LAS monthly indicators Aug 2017–Apr 2026 (C1/C2 mean & 90th centile, volumes) | `data/ambsys.csv` (already downloaded; cols `A25/A26` = C1 mean/90th, `A31/A32` = C2 — verify against magnitudes: C1≈430s) — source [NHS AQI](https://www.england.nhs.uk/statistics/statistical-work-areas/ambulance-quality-indicators/) | ✅ in repo pipeline |
| **Spatial demand proxies** — LFB special services, geocoded: **32,825 "Effecting entry/exit"** (forcing doors, overwhelmingly for LAS access to collapsed patients) + **10,073 RTC** (2024+) | `data/incidents.parquet` (run `etl.py` first), filter `SpecialServiceType` — NOTE: re-extract that column from xlsx, see Task T1 | ✅ verified counts |
| LAS ambulance station locations (~70) | OSM Overpass (snippet below); cross-check count vs LAS website list | ⚠️ you verify tonight |
| Optional demand covariate: LSOA population (Census 2021) | London Datastore "LSOA atlas" / ONS | 🟡 optional |

OSM stations:
```bash
curl -s "https://overpass-api.de/api/interpreter" --data-urlencode \
 'data=[out:json][timeout:90];area["name"="Greater London"]->.a;nwr["amenity"="ambulance_station"](area.a);out center;' > data/ambulance_stations_osm.json
```

## 4. YOUR TASKS (priority order)

### T1 — Demand proxy surface (tonight, ~1.5h) 🔴 critical
The shipped `etl.py` drops `SpecialServiceType` — extend it (or write `etl_ambulance.py`) to re-read the two incident xlsx files keeping `[CalYear, SpecialServiceType, Easting_rounded, Northing_rounded, HourOfCall, DateOfCall]`. Build `service_ambulance.py :: load_demand()`:
- weight per 1km cell = α·effecting_entry + β·RTC (start α=1, β=1; document the choice)
- canonical cell id: `f"E{int(E//1000)}_N{int(N//1000)}"` (coords are already BNG meters — no reprojection needed, you have it easier than police)
- Output `data/processed/ambulance_demand.parquet`: `[cell, gx, gy, weight, category, period]`, category ∈ {proxy_all, effecting_entry, rtc}.
- **Honesty doc**: 10 lines in `AMBULANCE_VALIDATION.md` — this is a *proxy* (true LAS incident locations are not public); state it plainly. Optional credibility check: correlate your proxy surface vs the ancient ward-level "ambulance call outs" in the GLA Ward Atlas — even r≈0.6+ is a supporting line.

### T2 — Stations + AmbSYS targets (tonight, ~1h) 🔴 critical
- `load_stations()` → `data/processed/ambulance_stations.parquet` `[name, E, N]` (OSM → BNG via pyproj; dedupe 100m; expect ~70).
- Parse AmbSYS → `data/processed/las_targets.parquet` `[year, month, c1_mean_s, c1_p90_s, c2_mean_s, c2_p90_s]` (LAS rows: `Org Code == "RRU"`).

### T3 — ⭐ THE TRANSFER EXPERIMENT (Sun AM, ~2h) — the headline
Simulate C1 response with **zero ambulance-specific tuning**:
1. Sample N=50,000 synthetic C1 incidents from your demand surface (cells weighted).
2. For each: nearest LAS station → travel time from the shared fire-learned model `data/travel_xgb.json` (features `[dist_m, hour, dow, month, st_idx]`; sample hour from LFB's diurnal shape as approximation — document) + activation time (use LFB turnout distribution as prior; document).
3. Compare simulated mean & p90 vs actual 430s / 734s (2024+ averages from your T2 table).
4. Report in `AMBULANCE_VALIDATION.md`: `sim_mean, sim_p90, actual, % gap` — **whatever the number is, we publish it.** Within 15% = "transfer validated at aggregate level". Outside = we report the gap and what it implies (fire appliances slower than ambulances → expected direction: sim *over*-estimates). Both outcomes are honest science and BOTH are demo-able.

### T4 — Closure damage table (Sun AM, ~1h) 🟠
Mirror `t3_counterfactual.py` with your stations + C1-weighted demand → `closure_damage()` → `data/processed/ambulance_damage.parquet` `[station, calls, mean_added_s, p90_added_s, pushed_over_target]` (target: 900s C1 p90 standard).

### T5 — Insights (ongoing) 🟡 → `docs/insights_ambulance.md`
- **"C2 is the broken promise"**: 33.8min actual vs 18min standard — plot the monthly series from your las_targets table; find the worst months (winter pressure?).
- Cross-service: cells where the **fire** 6-min promise holds but predicted C1 tail is worst → "same street, two different safety nets".
- Co-location: LAS stations within 500m of fire stations — joint-coverage argument.

### T6 — GeoJSON payloads (Sun, 30min) 🟡
`data/processed/geo/ambulance_<category>.geojson` for the dashboard.

## 5. Traps

- AmbSYS columns are coded (`A25` etc.) and some early rows are "." — cast with `strict=False`, validate by magnitude (C1 mean must be ≈ 380–480s; if you get 25,000, you grabbed a count column).
- AmbSYS counts column meanings need the codebook — we only *need* the time indicators; don't burn time decoding counts.
- The proxy is a proxy. Tier badge **B–** everywhere. Never say "LAS incidents", say "modeled ambulance demand (proxy)".
- `Effecting entry` includes some non-medical (lockouts) — note it; the spatial pattern still tracks vulnerable-resident density.
- Coordinates in fire data are 50m-rounded for dwellings — irrelevant at 1km.

## 6. Definition of done

- [ ] `service_ambulance.py` with the 3 contract functions, runs from clean checkout
- [ ] 4 parquet outputs (`demand`, `stations`, `las_targets`, `damage`) matching schemas
- [ ] `AMBULANCE_VALIDATION.md` with the transfer-experiment number front and center
- [ ] 1+ insight with a number in `docs/insights_ambulance.md`
- [ ] No secrets committed
