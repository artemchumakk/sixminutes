"""SIXMINUTES — Police tier (Tier B): demand surface + transferred-physics closure damage.

Contract (see README.md §4):
    load_demand()    -> pl.DataFrame  [cell, gx, gy, weight, category, period]
    load_stations()  -> pl.DataFrame  [name, E, N, kind]
    closure_damage() -> pl.DataFrame  [station, calls, mean_added_s, p90_added_s, pushed_over_target]

Canonical grid: EPSG:27700 (BNG, metres), 1km cells  ->  cell = f"E{E//1000}_N{N//1000}".
Police open data has NO time-of-day and NO incident-level response times: demand is monthly,
travel physics is transferred from the fire XGBoost model, validation is aggregate (FOI). Tier B.
"""
from __future__ import annotations

import glob
import json
import os
import urllib.request
import urllib.parse
from pathlib import Path

import numpy as np
import polars as pl
import xgboost as xgb
from pyproj import Transformer

DATA = Path(__file__).parent / "data"
PROC = DATA / "processed"
WGS84_TO_BNG = Transformer.from_crs(4326, 27700, always_xy=True)
BNG_TO_WGS84 = Transformer.from_crs(27700, 4326, always_xy=True)

# --- T3 transferred-physics closure damage ---
TARGET_S = 900            # Met I-grade (Immediate) target: a unit on scene within 15 min
MET_IGRADE_MEAN_S = 801   # London I-grade mean ~13m21s (MPS FOI / MOPAC) — absolute-scale anchor; see POLICE_VALIDATION.md
TRAVEL_MAX_M = 15_000     # fire travel model validity radius (matches t3_counterfactual.py)
STRAND_CEIL_S = 1800      # cap on added/out-of-range response (~travel across the full 15 km radius): stops the 9e9 sentinel polluting means
FIRE_STATIONS = DATA / "stations.parquet"   # shared fire input, READ-ONLY: borrow each police station's nearest-fire travel-physics id
TRAVEL_MODEL = DATA / "travel_xgb.json"     # shared travel model (trained on fire incidents)

# data.police.uk street "Crime type" -> coarse rubric categories. Unmapped -> only the "all" bucket.
CATEGORY_MAP = {
    "Violence and sexual offences": "violence",
    "Burglary": "burglary",
    "Robbery": "robbery",
    "Anti-social behaviour": "asb",
    "Vehicle crime": "vehicle",
    "Theft from the person": "theft",
    "Other theft": "theft",
    "Bicycle theft": "theft",
    "Shoplifting": "theft",
}

# London bbox guard (drops the handful of out-of-force stray points)
LON_MIN, LON_MAX, LAT_MIN, LAT_MAX = -0.62, 0.40, 51.20, 51.80


def _year_period() -> pl.Expr:
    """36-month window May2023-Apr2026 -> three 12-month years (matches FEASIBILITY t5)."""
    return (
        pl.when(pl.col("Month") <= "2024-04").then(pl.lit("Y1"))
        .when(pl.col("Month") <= "2025-04").then(pl.lit("Y2"))
        .otherwise(pl.lit("Y3"))
    )


def load_demand() -> pl.DataFrame:
    """Canonical police demand surface on the 1km BNG grid.

    weight = monthly-mean crime count for (cell, category, period).
    period in {Y1, Y2, Y3, all}; category in {all, violence, burglary, robbery, asb, vehicle, theft}.
    """
    files = sorted(glob.glob(str(DATA / "police" / "*" / "*.csv")))
    if not files:
        raise FileNotFoundError(f"no police CSVs under {DATA/'police'} — run download_data.sh first")

    frames = []
    for f in files:
        try:
            frames.append(
                pl.read_csv(f, columns=["Month", "Longitude", "Latitude", "Crime type"],
                            infer_schema_length=0)
            )
        except Exception as e:  # per-file isolation: one bad CSV never kills the load
            print(f"  WARN skipping {os.path.basename(f)}: {e}")
    raw = pl.concat(frames)
    n_raw = raw.height

    df = (
        raw.with_columns(
            lon=pl.col("Longitude").cast(pl.Float64, strict=False),
            lat=pl.col("Latitude").cast(pl.Float64, strict=False),
        )
        .drop_nulls(["lon", "lat"])
        .filter((pl.col("lon") != 0) | (pl.col("lat") != 0))
        .filter(pl.col("lon").is_between(LON_MIN, LON_MAX) & pl.col("lat").is_between(LAT_MIN, LAT_MAX))
    )
    n_clean = df.height
    print(f"[demand] raw rows {n_raw:,} -> clean {n_clean:,}  (dropped {n_raw-n_clean:,} = {100*(n_raw-n_clean)/n_raw:.2f}% null/zero/out-of-bbox)")

    # reproject WGS84 -> EPSG:27700 (vectorised), build the canonical 1km cell id
    E, N = WGS84_TO_BNG.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
    df = df.with_columns(
        gx=(pl.Series(E) // 1000).cast(pl.Int32),
        gy=(pl.Series(N) // 1000).cast(pl.Int32),
        yperiod=_year_period(),
        cat=pl.col("Crime type").replace_strict(CATEGORY_MAP, default=None, return_dtype=pl.Utf8),
    ).with_columns(cell=pl.format("E{}_N{}", "gx", "gy"))

    base = df.select(["cell", "gx", "gy", "yperiod", "cat"])
    # expand each crime into the "all" category + (if mapped) its specific category
    cat_long = pl.concat([
        base.with_columns(category=pl.lit("all")),
        base.filter(pl.col("cat").is_not_null()).with_columns(category=pl.col("cat")),
    ])
    # expand into the "all" period + its own 12-month year
    full = pl.concat([
        cat_long.with_columns(period=pl.lit("all")),
        cat_long.with_columns(period=pl.col("yperiod")),
    ])

    agg = full.group_by(["cell", "gx", "gy", "category", "period"]).len().rename({"len": "count"})

    months = {r["yperiod"]: r["m"] for r in
              df.group_by("yperiod").agg(pl.col("Month").n_unique().alias("m")).iter_rows(named=True)}
    months["all"] = df["Month"].n_unique()
    out = (
        agg.with_columns(
            weight=(pl.col("count") / pl.col("period").replace_strict(months, default=36, return_dtype=pl.Int32))
        )
        .select(["cell", "gx", "gy", "weight", "category", "period"])
        .sort(["category", "period", "weight"], descending=[False, False, True])
    )
    return out


# ----------------------------------------------------------------------------- T2

OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
)
OVERPASS_Q = ('[out:json][timeout:90];area["name"="Greater London"]->.a;'
              'nwr["amenity"="police"](area.a);out center;')


def _fetch_osm_police() -> list[dict]:
    data = urllib.parse.urlencode({"data": OVERPASS_Q}).encode()
    headers = {"User-Agent": "sixminutes-police/1.0 (hackathon research)", "Accept": "application/json"}
    for url in OVERPASS_ENDPOINTS:
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=90) as r:
                els = json.load(r)["elements"]
            out = []
            for e in els:
                lat = e.get("lat") or e.get("center", {}).get("lat")
                lon = e.get("lon") or e.get("center", {}).get("lon")
                if lat is None or lon is None:
                    continue
                tags = e.get("tags", {})
                out.append({"name": tags.get("name", f"police_{e['id']}"), "lon": lon, "lat": lat,
                            "operator": tags.get("operator", ""), "police": tags.get("police", "")})
            if out:
                print(f"[stations] OSM: {len(out)} amenity=police via {url.split('/')[2]}")
                return out
        except Exception as ex:
            print(f"  overpass {url.split('/')[2]} failed: {ex}")
    return []


def _classify(name: str, operator: str, police: str) -> str:
    s = f"{name} {operator} {police}".lower()
    if "front counter" in s or "front_counter" in s:
        return "front_counter"
    if any(k in s for k in ("headquarters", "hq", "training", "base", "depot")):
        return "base"
    return "station"


def load_stations() -> pl.DataFrame:
    """London police estate -> [name, E, N, kind].  OSM Overpass; deduped within 100m."""
    rows = _fetch_osm_police()
    if not rows:
        raise RuntimeError("could not fetch any police stations (Overpass unreachable)")

    lon = np.array([r["lon"] for r in rows], dtype=float)
    lat = np.array([r["lat"] for r in rows], dtype=float)
    E, N = WGS84_TO_BNG.transform(lon, lat)

    df = pl.DataFrame({
        "name": [r["name"] for r in rows],
        "E": E, "N": N,
        "kind": [_classify(r["name"], r["operator"], r["police"]) for r in rows],
    }).filter(  # keep only points that actually land in the London BNG window
        pl.col("E").is_between(490_000, 565_000) & pl.col("N").is_between(150_000, 205_000)
    )

    # greedy dedupe within 100m (OSM often has a node + a building way for one site)
    keptE, keptN, keep = [], [], []
    for r in df.iter_rows(named=True):
        e, n = r["E"], r["N"]
        if any((e - ke) ** 2 + (n - kn) ** 2 < 100 ** 2 for ke, kn in zip(keptE, keptN)):
            keep.append(False)
        else:
            keep.append(True); keptE.append(e); keptN.append(n)
    out = df.filter(pl.Series(keep)).with_columns(E=pl.col("E").round(1), N=pl.col("N").round(1))
    print(f"[stations] {df.height} raw -> {out.height} after 100m dedupe  "
          f"(kinds: {dict(out['kind'].value_counts().iter_rows())})")
    return out


# ----------------------------------------------------------------------------- T3

def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    """Spearman rank correlation (numpy-only; no scipy dependency)."""
    ra = np.argsort(np.argsort(a)); rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def _wquantile(values: np.ndarray, weights: np.ndarray, q: float) -> float:
    """Weight-aware quantile (q in [0,1]); empty -> nan, zero total weight -> max."""
    if values.size == 0:
        return float("nan")
    order = np.argsort(values)
    v = values[order]; cw = np.cumsum(weights[order])
    if cw[-1] <= 0:
        return float(v[-1])
    idx = int(np.searchsorted(cw, q * cw[-1]))
    return float(v[min(idx, v.size - 1)])


def closure_damage(hour: int = 12, dow: int = 3, month: int = 6) -> pl.DataFrame:
    """Transferred-physics closure damage per police station (the Tier-B thesis).

    For each violence-weighted 1km demand cell: if its nearest station shut, how many
    extra seconds to the next-nearest? Travel is the SHARED fire XGBoost model
    (data/travel_xgb.json); police stations aren't in that model, so each borrows its
    nearest fire station's index as a local travel-physics id. Police street data has no
    time-of-day, so we evaluate a fixed weekday-midday slice (hour=12, dow=3, month=6).
    Absolute response is anchored to the published Met I-grade mean (POLICE_VALIDATION.md);
    the damage RANKING and the call-volume thesis are scale-invariant.

    Returns [station, calls, mean_added_s, p90_added_s, pushed_over_target].
    """
    demand = pl.read_parquet(PROC / "police_demand.parquet").filter(
        (pl.col("category") == "violence") & (pl.col("period") == "all")
    )
    stn = pl.read_parquet(PROC / "police_stations.parquet")
    if demand.height == 0 or stn.height < 2:
        raise RuntimeError("need >=1 demand cell and >=2 stations (run T1/T2 first)")
    fire = pl.read_parquet(FIRE_STATIONS)
    model = xgb.XGBRegressor(); model.load_model(str(TRAVEL_MODEL))

    # cell centroids (BNG metres) and violence crime weight (crimes / month)
    cx = demand["gx"].to_numpy().astype(np.float64) * 1000 + 500
    cy = demand["gy"].to_numpy().astype(np.float64) * 1000 + 500
    w = demand["weight"].to_numpy().astype(np.float64)
    n_cell = cx.size

    SE = stn["E"].to_numpy(); SN = stn["N"].to_numpy()
    names = stn["name"].to_list(); n_st = len(names)

    # each police station borrows its nearest fire station's index (a valid model st_idx)
    FE = fire["E"].to_numpy(); FN = fire["N"].to_numpy()
    borrow_idx = (np.sqrt((SE[:, None] - FE[None, :]) ** 2 + (SN[:, None] - FN[None, :]) ** 2)
                  .argmin(axis=1).astype(np.float32))

    home = np.empty(n_cell, dtype=np.int32)
    t_home = np.empty(n_cell, dtype=np.float64)   # nearest predicted attendance (s)
    t_next = np.empty(n_cell, dtype=np.float64)   # next-best attendance if home closed (s)

    CHUNK = 4000
    for c0 in range(0, n_cell, CHUNK):
        c1 = min(c0 + CHUNK, n_cell); m = c1 - c0
        d = np.sqrt((cx[c0:c1, None] - SE[None, :]) ** 2 + (cy[c0:c1, None] - SN[None, :]) ** 2)
        feats = np.empty((m * n_st, 5), dtype=np.float32)
        feats[:, 0] = d.ravel()
        feats[:, 1] = hour; feats[:, 2] = dow; feats[:, 3] = month
        feats[:, 4] = np.tile(borrow_idx, m)
        att = model.predict(feats).reshape(m, n_st).astype(np.float64)
        att[d > TRAVEL_MAX_M] = 9e9                        # outside model validity
        two = np.argpartition(att, kth=1, axis=1)[:, :2]   # two nearest by predicted attendance
        a0 = att[np.arange(m), two[:, 0]]; a1 = att[np.arange(m), two[:, 1]]
        closer = a0 <= a1
        home[c0:c1] = np.where(closer, two[:, 0], two[:, 1])
        t_home[c0:c1] = np.minimum(a0, a1)
        t_next[c0:c1] = np.maximum(a0, a1)

    reachable_home = t_home < 9e8                          # nearest station within model range
    nxt = np.where(t_next >= 9e8, STRAND_CEIL_S, t_next)   # no 2nd station in range -> capped ceiling (stranded)
    delta = np.where(reachable_home, np.clip(nxt - t_home, 0.0, STRAND_CEIL_S), 0.0)  # added s if home closed

    # anchor the absolute scale to the published Met I-grade mean (does NOT affect rankings/thesis)
    overhead = (MET_IGRADE_MEAN_S - float(np.average(t_home[reachable_home], weights=w[reachable_home]))
                if reachable_home.any() else 0.0)
    pushed_mask = reachable_home & ((t_home + overhead) <= TARGET_S) & ((nxt + overhead) > TARGET_S)

    # crime-weighted aggregate per home station (numpy group-by; robust to zero-data stations)
    order = np.argsort(home, kind="stable")
    hs, ws, ds, ps = home[order], w[order], delta[order], pushed_mask[order]
    uniq, starts = np.unique(hs, return_index=True)
    ends = np.append(starts[1:], hs.size)
    rows = []
    for k, j in enumerate(uniq):
        sl = slice(int(starts[k]), int(ends[k]))
        ww, dd, pp = ws[sl], ds[sl], ps[sl]
        calls = float(ww.sum())
        rows.append({
            "station": names[int(j)],
            "calls": round(calls, 2),
            "mean_added_s": round(float(np.average(dd, weights=ww)) if calls > 0 else 0.0, 1),
            "p90_added_s": round(_wquantile(dd, ww, 0.9), 1),
            "pushed_over_target": round(float(ww[pp].sum()), 2),
        })
    return pl.DataFrame(rows).sort("mean_added_s", descending=True)


# ----------------------------------------------------------------------------- T4

# Published Met I-grade (Immediate) aggregates — the Tier-B validation anchor.
# Sources: MPS FOI "Police response times Jan2019-Jul2024"; MOPAC; London Assembly answers.
MET_ANCHORS = [
    {"metric": "igrade_target_s",        "value": 900.0, "note": "MPS/MOPAC: respond within 15 min"},
    {"metric": "igrade_mean_s",          "value": 801.0, "note": "MPS FOI Jan2019-Jul2024 (~13m21s)"},
    {"metric": "igrade_pct_within_15min", "value": 85.0,  "note": "MOPAC Q3 2018/19 (target 90%)"},
]


def validate() -> dict:
    """T4 — anchor the police tier to published reality (aggregate-only; Tier B).

    Police open data has no incident-level response times, so per-incident travel
    cannot be validated. Two honest checks instead:
      (1) demand-surface stability — does the past two years' crime predict this year's?
          (same >=0.85 bar as fire; if it holds, the demand surface is signal not noise)
      (2) absolute-scale anchor — the published Met I-grade mean that T3 calibrates to.
    Writes data/processed/police_response_anchors.parquet; returns stability + anchors.
    """
    d = pl.read_parquet(PROC / "police_demand.parquet")

    def stab(cat: str) -> dict:
        w = (d.filter((pl.col("category") == cat) & pl.col("period").is_in(["Y1", "Y2", "Y3"]))
              .select("cell", "period", "weight")
              .pivot(values="weight", index="cell", on="period").fill_null(0.0))
        for c in ("Y1", "Y2", "Y3"):
            if c not in w.columns:
                w = w.with_columns(pl.lit(0.0).alias(c))
        y1, y2, y3 = w["Y1"].to_numpy(), w["Y2"].to_numpy(), w["Y3"].to_numpy()
        return {
            "category": cat,
            "cells": w.height,
            "r_Y1Y2": round(float(np.corrcoef(np.log1p(y1), np.log1p(y2))[0, 1]), 3),
            "r_Y2Y3": round(float(np.corrcoef(np.log1p(y2), np.log1p(y3))[0, 1]), 3),
            "predictY3_spearman": round(_spearman((y1 + y2) / 2, y3), 3),
        }

    stabs = [stab(c) for c in ("all", "violence", "burglary", "robbery")]
    pl.DataFrame(MET_ANCHORS).write_parquet(PROC / "police_response_anchors.parquet")
    print(f"  wrote {PROC/'police_response_anchors.parquet'}  ({len(MET_ANCHORS)} Met anchors)")
    return {"stability": stabs, "anchors": MET_ANCHORS}


# ----------------------------------------------------------------------------- T6

def _point(lon: float, lat: float, props: dict) -> dict:
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(float(lon), 5), round(float(lat), 5)]},
            "properties": props}


def build_geojson() -> list[str]:
    """T6 — map payloads (WGS84): per-category demand + stations + closure damage.

    Writes data/processed/geo/police_<category>.geojson (demand cell centroids, period=all),
    plus police_stations.geojson and police_damage.geojson. Returns the paths written.
    """
    geo = PROC / "geo"; geo.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    demand = pl.read_parquet(PROC / "police_demand.parquet").filter(pl.col("period") == "all")
    for cat in demand["category"].unique().sort().to_list():
        sub = demand.filter(pl.col("category") == cat)
        lon, lat = BNG_TO_WGS84.transform(sub["gx"].to_numpy() * 1000 + 500,
                                          sub["gy"].to_numpy() * 1000 + 500)
        feats = [_point(lo, la, {"cell": c, "weight": round(float(w), 3)})
                 for c, w, lo, la in zip(sub["cell"].to_list(), sub["weight"].to_list(), lon, lat)]
        path = geo / f"police_{cat}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection",
                                    "properties": {"category": cat, "period": "all", "crs": "WGS84"},
                                    "features": feats}))
        written.append(str(path))

    stn = pl.read_parquet(PROC / "police_stations.parquet").unique(subset="name", keep="first")
    slon, slat = BNG_TO_WGS84.transform(stn["E"].to_numpy(), stn["N"].to_numpy())
    sfeats = [_point(lo, la, {"name": n, "kind": k})
              for n, k, lo, la in zip(stn["name"].to_list(), stn["kind"].to_list(), slon, slat)]
    (geo / "police_stations.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": sfeats}))
    written.append(str(geo / "police_stations.geojson"))

    dmg = (pl.read_parquet(PROC / "police_damage.parquet")
           .join(stn.select("name", "E", "N"), left_on="station", right_on="name", how="left")
           .drop_nulls(["E", "N"]))
    dlon, dlat = BNG_TO_WGS84.transform(dmg["E"].to_numpy(), dmg["N"].to_numpy())
    dfeats = [_point(lo, la, {"station": r["station"], "calls": r["calls"],
                             "mean_added_s": r["mean_added_s"], "p90_added_s": r["p90_added_s"],
                             "pushed_over_target": r["pushed_over_target"]})
              for r, lo, la in zip(dmg.iter_rows(named=True), dlon, dlat)]
    (geo / "police_damage.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": dfeats}))
    written.append(str(geo / "police_damage.geojson"))
    return written


def _write(df: pl.DataFrame, name: str) -> None:
    PROC.mkdir(parents=True, exist_ok=True)
    path = PROC / name
    df.write_parquet(path)
    print(f"  wrote {path}  ({df.height:,} rows)")


if __name__ == "__main__":
    print("=== T1: demand surface ===")
    demand = load_demand()
    _write(demand, "police_demand.parquet")
    aa = demand.filter((pl.col("category") == "all") & (pl.col("period") == "all"))
    total = int((aa["weight"] * 36).sum())
    print(f"  total crimes (all/all): {total:,}   cells: {aa.height:,}")
    print("  top 5 demand cells (all/all, crimes/month):")
    for r in aa.head(5).iter_rows(named=True):
        print(f"    {r['cell']:>12}  E~{r['gx']*1000} N~{r['gy']*1000}  {r['weight']:.0f}/mo")

    print("\n=== T2: stations ===")
    stations = load_stations()
    _write(stations, "police_stations.parquet")

    print("\n=== T3: closure damage (the thesis) ===")
    dmg = closure_damage()
    _write(dmg, "police_damage.parquet")
    sp = _spearman(dmg["calls"].to_numpy(), dmg["mean_added_s"].to_numpy())
    print(f"  [THESIS] spearman(call volume, closure damage) = {sp:+.3f}")
    print("           fire stations invert at -0.18; >0.85 would mean 'just shut the quiet ones' is safe")
    thresh = int(dmg.height * 0.4)
    quiet = dmg.with_columns(qrank=pl.col("calls").rank("ordinal")).filter(pl.col("qrank") <= thresh)
    print(f"  [QUIET-BUT-CRITICAL] bottom-40% by call volume ({thresh} stations), top closure damage:")
    for r in quiet.sort("mean_added_s", descending=True).head(8).iter_rows(named=True):
        print(f"    {r['station'][:32]:<32} calls={r['calls']:>7.1f}/mo  +{r['mean_added_s']:>5.0f}s mean  +{r['p90_added_s']:>5.0f}s p90  pushed>15min: {r['pushed_over_target']:.1f}/mo")
    print("  [SAFEST closures by damage] (note their call volumes):")
    for r in dmg.sort("mean_added_s").head(3).iter_rows(named=True):
        print(f"    {r['station'][:32]:<32} calls={r['calls']:>7.1f}/mo  +{r['mean_added_s']:.0f}s mean")

    print("\n=== T4: validation anchor ===")
    v = validate()
    for s in v["stability"]:
        print(f"  stability[{s['category']:<9}] predict-Y3 spearman={s['predictY3_spearman']:.3f}  (bar 0.85)")

    print("\n=== T6: geojson payloads ===")
    for p in build_geojson():
        print(f"  wrote {p}")
