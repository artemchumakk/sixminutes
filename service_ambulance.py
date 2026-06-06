"""SIXMINUTES — ambulance tier (Tier B-).

Contract (see README.md §4):
    load_demand()    -> [cell, gx, gy, weight, category, period]
    load_stations()  -> [name, E, N, ...]
    closure_damage() -> [station, calls, mean_added_s, p90_added_s, pushed_over_target]

Also builds las_targets (the AmbSYS answer-key) and runs the transfer experiment.
We BORROW the fire-learned travel model (data/travel_xgb.json) — zero ambulance tuning.
Everything here is a modeled PROXY: never claim these are real LAS incidents.
Conventions: EPSG:27700 metres · 1km cell `E{E//1000}_N{N//1000}` · all times in seconds.
"""
from __future__ import annotations
import json
import ssl
import urllib.request
import urllib.parse
from pathlib import Path

import numpy as np
import polars as pl

DATA = Path(__file__).parent / "data"
PROC = DATA / "processed"
PROC.mkdir(exist_ok=True)

C1_TARGET_P90 = 900   # seconds — LAS Category-1 90th-percentile standard
C1_TARGET_MEAN = 420  # seconds — LAS Category-1 mean standard (used for closure threshold:
                      # the free-flow sim never reaches 900s, so 900s would make the column always 0)

# Demand source: REAL London Ambulance Service incident counts per ward, from the GLA
# Ward Atlas (2012-2014 mean), mapped to 1km cells by ward centroid. Built by
# etl_ambulance_demand.py -> data/processed/ambulance_ward_demand.parquet.
# This REPLACED the old fire-brigade proxy (door-forcings + RTCs), which only saw the
# ~120k incidents the fire brigade was also called to; the Ward Atlas sees all ~1.07M
# real LAS incidents/yr. Spatial resolution is ward-level (~600 zones) — the native
# resolution of the published data.


# ============================================================ STATIONS
def _wgs84_to_bng(lon: np.ndarray, lat: np.ndarray):
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    return tr.transform(lon, lat)


def _fetch_osm_stations(out: Path) -> None:
    """Greater London ambulance stations from OSM Overpass (curl is blocked → urllib+certifi)."""
    import certifi
    # Greater London bounding box (lat/lon); match both tag conventions OSM uses.
    bbox = "51.28,-0.52,51.70,0.34"
    q = (f'[out:json][timeout:120];('
         f'nwr["emergency"="ambulance_station"]({bbox});'
         f'nwr["amenity"="ambulance_station"]({bbox});'
         f');out center;')
    ctx = ssl.create_default_context(cafile=certifi.where())
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=b"data=" + urllib.parse.quote(q).encode(),
        headers={"User-Agent": "sixminutes-hackathon/1.0 (research)",
                 "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=120) as r:
        out.write_bytes(r.read())


def load_stations() -> pl.DataFrame:
    """~70 LAS station locations → [name, E, N]. Cached in data/ambulance_stations_osm.json."""
    import urllib.parse  # noqa: F401 (used in _fetch_osm_stations via urllib.parse)
    raw = DATA / "ambulance_stations_osm.json"
    if not raw.exists():
        _fetch_osm_stations(raw)
    js = json.loads(raw.read_text())
    names, lons, lats = [], [], []
    for el in js.get("elements", []):
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        if lon is None or lat is None:
            continue
        nm = (el.get("tags") or {}).get("name") or f"amb_{el.get('id')}"
        names.append(nm); lons.append(lon); lats.append(lat)
    E, N = _wgs84_to_bng(np.array(lons), np.array(lats))
    df = pl.DataFrame({"name": names, "E": np.asarray(E), "N": np.asarray(N)})
    # drop obvious non-LAS noise (volunteer St John, hospital A&E entries)
    nm = pl.col("name").str.to_lowercase()
    df = df.filter(~(nm.str.contains("st john") | nm.str.contains("st. john")
                     | nm.str.contains("a&e") | nm.str.contains("hospital")))
    # dedupe within 100m
    keep_e, keep_n, keep_i = [], [], []
    for i, (e, n) in enumerate(zip(df["E"], df["N"])):
        if all((e - ke) ** 2 + (n - kn) ** 2 > 100 ** 2 for ke, kn in zip(keep_e, keep_n)):
            keep_e.append(e); keep_n.append(n); keep_i.append(i)
    df = df[keep_i]
    df.write_parquet(PROC / "ambulance_stations.parquet")
    print(f"stations: {df.height} (deduped)")
    return df


# ============================================================ LAS TARGETS (answer key)
def las_targets() -> pl.DataFrame:
    """AmbSYS RRU rows → [year, month, c1_mean_s, c1_p90_s, c2_mean_s, c2_p90_s]."""
    df = pl.read_csv(DATA / "ambsys.csv", infer_schema_length=0)  # all strings; cast below
    las = df.filter(pl.col("Org Code") == "RRU").select(
        year=pl.col("Year").cast(pl.Int32, strict=False),
        month=pl.col("Month").cast(pl.Int32, strict=False),
        c1_mean_s=pl.col("A25").cast(pl.Float64, strict=False),
        c1_p90_s=pl.col("A26").cast(pl.Float64, strict=False),
        c2_mean_s=pl.col("A31").cast(pl.Float64, strict=False),
        c2_p90_s=pl.col("A32").cast(pl.Float64, strict=False),
    ).drop_nulls("c1_mean_s").sort(["year", "month"])
    las.write_parquet(PROC / "las_targets.parquet")
    recent = las.filter(pl.col("year") >= 2024)
    print(f"las_targets: {las.height} months; 2024+ C1 mean={recent['c1_mean_s'].mean():.0f}s "
          f"p90={recent['c1_p90_s'].mean():.0f}s  (sanity: ~430/745)")
    return las


# ============================================================ DEMAND (REAL)
_WARD_DEMAND = "ambulance_ward_demand.parquet"  # built by etl_ambulance_demand.py
_PERIOD = "2012-2014 (GLA Ward Atlas)"


def load_demand() -> pl.DataFrame:
    """Real LAS demand → [cell, gx, gy, weight, category, period].

    Reads the GLA Ward Atlas surface (real ambulance incident counts per ward, mapped
    to 1km cells by ward centroid). category 'proxy_all' carries ALL ambulance incidents
    — the primary demand the simulation samples from. 'assault' and 'alcohol' are real
    sub-streams kept for insight colour. (Name 'proxy_all' retained for the downstream
    contract; the values are now real counts, not a fire proxy.)
    """
    wd = PROC / _WARD_DEMAND
    if not wd.exists():
        import etl_ambulance_demand as etl
        etl.build()
    cells = pl.read_parquet(wd)

    frames = []
    for cat, col in (("proxy_all", "ambulance"), ("assault", "assault"), ("alcohol", "alcohol")):
        frames.append(cells.select(
            "cell", "gx", "gy",
            weight=pl.col(col).cast(pl.Float64),
            category=pl.lit(cat),
            period=pl.lit(_PERIOD),
        ).filter(pl.col("weight") > 0))
    out = pl.concat(frames)
    out.write_parquet(PROC / "ambulance_demand.parquet")
    tot = cells["ambulance"].sum()
    print(f"demand: {cells.height} occupied 1km cells (ward-level); REAL ambulance "
          f"incidents/yr={tot:,.0f} (assault={cells['assault'].sum():,.0f} "
          f"alcohol={cells['alcohol'].sum():,.0f}) period={_PERIOD}")
    return out


# ============================================================ TRANSFER + CLOSURE
def _load_travel_model():
    import xgboost as xgb
    m = xgb.XGBRegressor()
    # Prefer the DGX Spark (GB10) GPU-trained model if present; fall back to shared CPU model.
    gpu = DATA / "travel_xgb_gpu.json"
    m.load_model(str(gpu if gpu.exists() else DATA / "travel_xgb.json"))
    return m


def _sample_turnout(rng, n: int) -> np.ndarray:
    """Activation-time prior borrowed from LFB station turnout, CALL-WEIGHTED by station volume
    (audit HIGH #6 — unweighted median-of-medians biased the sample). NOTE: still a per-station
    median, so tail dispersion is understated; the p90 friction gap is therefore a lower bound."""
    fs = pl.read_parquet(DATA / "stations.parquet")
    tmed = fs["turnout_med"].to_numpy().astype(np.float32)
    w = fs["n"].to_numpy().astype(np.float64)
    return rng.choice(tmed, size=n, p=w / w.sum())


# ---------------- Thames barrier routing ----------------
# London's river is a hard barrier: you can only cross at a bridge/tunnel. We approximate
# the Thames as a centre-line N=f(E) (monotone in Easting) and the crossings as a list of
# real bridge/tunnel points (BNG metres, west→east). If an incident and a station sit on
# OPPOSITE banks, the straight line is impossible — the true distance is via the cheapest
# crossing: dist(incident→bridge) + dist(bridge→station). Same-bank trips keep straight-line.
# Coarse (the river's Isle-of-Dogs meander is smoothed) but it captures the dominant effect.
_THAMES_E = np.array([516000, 519000, 522000, 525000, 528000, 530000, 531000, 532500,
                      533700, 535500, 537500, 539000, 541000, 543500, 547000, 551000, 556000], float)
_THAMES_N = np.array([169000, 174500, 176200, 176600, 177600, 178300, 180000, 180300,
                      180200, 179700, 178200, 178800, 179000, 179100, 180500, 180500, 176000], float)
_BRIDGES_E = np.array([517700, 524100, 525800, 527300, 528700, 530000, 530300, 530800,
                       531600, 532700, 533700, 535100, 538900, 543500, 556700], float)
_BRIDGES_N = np.array([169700, 175900, 176300, 177100, 177700, 178200, 179400, 180400,
                       180700, 180400, 180200, 180100, 180600, 179100, 175600], float)


def _bank(E, N):
    """+1 north of the river, -1 south, at each point's Easting."""
    return np.sign(N - np.interp(E, _THAMES_E, _THAMES_N))


def _effective_distance(Ei, Ni, SE, SN):
    """[m, n_st] road-effective distance: straight-line, but cross-river pairs are
    rerouted via the cheapest bridge (incident→bridge→station)."""
    m, ns = len(Ei), len(SE)
    straight = np.sqrt((Ei[:, None] - SE[None, :]) ** 2 + (Ni[:, None] - SN[None, :]) ** 2)
    crosses = (_bank(Ei, Ni)[:, None] != _bank(SE, SN)[None, :])
    if not crosses.any():
        return straight
    # cheapest crossing per (incident, station): min over bridges of d(i,b)+d(b,s)
    d_ib = np.sqrt((Ei[:, None] - _BRIDGES_E[None, :]) ** 2 + (Ni[:, None] - _BRIDGES_N[None, :]) ** 2)
    d_bs = np.sqrt((_BRIDGES_E[:, None] - SE[None, :]) ** 2 + (_BRIDGES_N[:, None] - SN[None, :]) ** 2)
    via = np.full((m, ns), np.inf, np.float64)
    for b in range(len(_BRIDGES_E)):              # running min keeps memory at m×n_st
        np.minimum(via, d_ib[:, b][:, None] + d_bs[b][None, :], out=via)
    return np.where(crosses, via, straight)


def _attendance_matrix(model, E, N, HR, DOW, MO, SE, SN, chunk=40000):
    """Predicted attendance (travel only) from EVERY ambulance station for each incident.
    Distance is Thames-aware (cross-river trips are rerouted via the nearest bridge)."""
    n_inc, n_st = len(E), len(SE)
    out = np.empty((n_inc, n_st), dtype=np.float32)
    for s0 in range(0, n_inc, chunk):
        s1 = min(s0 + chunk, n_inc)
        d = _effective_distance(E[s0:s1], N[s0:s1], SE, SN)
        m = s1 - s0
        feats = np.empty((m * n_st, 5), dtype=np.float32)
        feats[:, 0] = d.ravel()
        feats[:, 1] = np.repeat(HR[s0:s1], n_st)
        feats[:, 2] = np.repeat(DOW[s0:s1], n_st)
        feats[:, 3] = np.repeat(MO[s0:s1], n_st)
        feats[:, 4] = 0.0  # st_idx NEUTRALISED: the fire model's per-station residual is keyed to
        # specific FIRE stations and does not transfer to ambulance stations. Feeding ambulance
        # indices injected up to ~154s of meaningless noise (audit CRITICAL #1). Constant 0 makes the
        # model use only [dist, hour, dow, month] — the physics that genuinely transfers.
        travel = model.predict(feats).reshape(m, n_st)
        travel[d > 15000] = 9e9  # outside model validity radius
        out[s0:s1] = travel
    return out


def _sample_incidents(demand: pl.DataFrame, n: int, rng):
    """Draw n synthetic C1 incidents from proxy_all cells (weighted). Caller supplies an
    independent rng so spatial and temporal sampling are decoupled (audit MEDIUM #5)."""
    d = demand.filter(pl.col("category") == "proxy_all")
    gx = d["gx"].to_numpy(); gy = d["gy"].to_numpy(); w = d["weight"].to_numpy()
    idx = rng.choice(len(w), size=n, p=w / w.sum())
    # uniform within the chosen 1km cell, in BNG metres
    E = (gx[idx] + rng.random(n)) * 1000.0
    N = (gy[idx] + rng.random(n)) * 1000.0
    return E.astype(np.float32), N.astype(np.float32)


def transfer_experiment(n: int = 50000, seed: int = 7) -> dict:
    """Simulate C1 response using BORROWED fire physics; compare to real AmbSYS C1 mean/p90."""
    demand = load_demand() if not (PROC / "ambulance_demand.parquet").exists() else \
        pl.read_parquet(PROC / "ambulance_demand.parquet")
    st = load_stations() if not (PROC / "ambulance_stations.parquet").exists() else \
        pl.read_parquet(PROC / "ambulance_stations.parquet")
    tgt = pl.read_parquet(PROC / "las_targets.parquet").filter(pl.col("year") >= 2024)
    actual_mean = float(tgt["c1_mean_s"].mean()); actual_p90 = float(tgt["c1_p90_s"].mean())

    model = _load_travel_model()
    SE = st["E"].to_numpy(); SN = st["N"].to_numpy()
    # independent rng streams for spatial vs temporal sampling (audit MEDIUM #5)
    r_space, r_time = (np.random.default_rng(s) for s in np.random.SeedSequence(seed).spawn(2))
    E, N = _sample_incidents(demand, n, r_space)

    # diurnal hour shape borrowed from LFB incidents (documented approximation)
    inc = pl.read_parquet(DATA / "incidents_ambulance.parquet")
    hr_counts = (inc.group_by("HourOfCall").len().drop_nulls().sort("HourOfCall"))
    hrs = hr_counts["HourOfCall"].to_numpy(); hp = hr_counts["len"].to_numpy().astype(float)
    HR = r_time.choice(hrs, size=n, p=hp / hp.sum()).astype(np.float32)
    DOW = r_time.integers(1, 8, n).astype(np.float32)
    MO = r_time.integers(1, 13, n).astype(np.float32)

    att = _attendance_matrix(model, E, N, HR, DOW, MO, SE, SN)  # travel only
    att[att > 9e8] = np.nan                     # sentinel (no station within 15km) → NaN
    travel_best = np.nanmin(att, axis=1)
    act = _sample_turnout(r_time, n)            # call-weighted activation prior
    resp = travel_best + act
    resp = resp[np.isfinite(resp)]              # drop uncoverable incidents

    sim_mean = float(np.mean(resp)); sim_p90 = float(np.percentile(resp, 90))
    res = {
        "sim_mean_s": round(sim_mean, 1), "sim_p90_s": round(sim_p90, 1),
        "actual_mean_s": round(actual_mean, 1), "actual_p90_s": round(actual_p90, 1),
        "mean_gap_pct": round(100 * (sim_mean - actual_mean) / actual_mean, 1),
        "p90_gap_pct": round(100 * (sim_p90 - actual_p90) / actual_p90, 1),
        "n": int(len(resp)),
    }
    print("TRANSFER:", res)
    return res


def closure_damage() -> pl.DataFrame:
    """For each station: added seconds if it were closed (next-best station responds).
    Demand = sampled C1 incidents; station 'owns' an incident if it is its nearest base.
    -> [station, calls, mean_added_s, p90_added_s, pushed_over_target]
    """
    demand = pl.read_parquet(PROC / "ambulance_demand.parquet")
    st = pl.read_parquet(PROC / "ambulance_stations.parquet")
    names = st["name"].to_list()
    SE = st["E"].to_numpy(); SN = st["N"].to_numpy()
    model = _load_travel_model()

    r_space, r_time = (np.random.default_rng(s) for s in np.random.SeedSequence(11).spawn(2))
    E, N = _sample_incidents(demand, 50000, r_space)
    HR = r_time.integers(0, 24, len(E)).astype(np.float32)
    DOW = r_time.integers(1, 8, len(E)).astype(np.float32)
    MO = r_time.integers(1, 13, len(E)).astype(np.float32)
    act = _sample_turnout(r_time, len(E))       # call-weighted activation prior

    att = _attendance_matrix(model, E, N, HR, DOW, MO, SE, SN) + act[:, None]
    att[att > 9e8] = np.nan                      # sentinel guard (audit CRITICAL #2)
    order = np.argsort(att, axis=1)              # NaN sorts last → real stations first
    rows = np.arange(len(E))
    nearest = order[:, 0]
    best = att[rows, order[:, 0]]
    second = att[rows, order[:, 1]]
    # keep only incidents with a real nearest AND a real backup within 15km
    valid = np.isfinite(best) & np.isfinite(second)
    n_uncoverable = int((~np.isfinite(second) & np.isfinite(best)).sum())
    nearest, best, second = nearest[valid], best[valid], second[valid]
    delta = np.maximum(second - best, 0)         # added seconds if nearest station closed

    name_map = pl.DataFrame({"station_idx": np.arange(len(names)), "station": names})
    df = pl.DataFrame({
        "station_idx": nearest, "best": best, "second": second, "delta": delta,
    }).join(name_map, on="station_idx")          # vectorized name lookup (audit MEDIUM)
    per = df.group_by("station").agg(
        calls=pl.len(),
        mean_added_s=pl.col("delta").mean(),
        p90_added_s=pl.col("delta").quantile(0.9),
        # "pushed over target" = closing this station tips a call past the C1 MEAN standard (420s);
        # 900s p90 is unreachable in a free-flow sim, so the mean standard is the live signal.
        pushed_over_target=((pl.col("second") > C1_TARGET_MEAN) & (pl.col("best") <= C1_TARGET_MEAN)).sum(),
    ).sort("mean_added_s", descending=True)
    per.write_parquet(PROC / "ambulance_damage.parquet")
    print(f"closure_damage: {per.height} stations ranked  ({n_uncoverable:,} uncoverable incidents excluded)")
    return per


def main() -> None:
    print("== load_stations =="); load_stations()
    print("== las_targets ==");   las_targets()
    print("== load_demand ==");   load_demand()
    print("== transfer_experiment =="); transfer_experiment()
    print("== closure_damage =="); closure_damage()
    print("AMBULANCE PIPELINE DONE")


if __name__ == "__main__":
    main()
