"""SIXMINUTES — ambulance scenario API (Tier B-).

  uvicorn api_ambulance:app --host 0.0.0.0 --port 8096

A faithful sibling of the fire API (api.py): same route surface and response
shapes, so the dispatcher console can drive an ambulance twin with the exact
same map/panel/agent UX. The PHYSICS differ — ambulance response here is a
free-flow nearest-station model (Thames-aware travel + a call-weighted
activation prior), the same model service_ambulance.py validates against real
AmbSYS C1 numbers (~429s mean). A "scenario" closes stations and the nearest
SURVIVING station answers instead; everything else (ward deltas, KPIs,
histograms, the inspector) falls out of one cached attendance matrix.

Route parity with api.py:
  GET  /health
  GET  /stations            station list + coords + a synthetic vehicle count
  GET  /wards               ward centroids (name, borough, lat, lon, n)
  GET  /wards_geo           London ward polygons (same file the fire twin uses)
  GET  /baseline?hours=h0,h1
  GET  /station/{name}      inspector: cover web, calls carried, closure cost
  POST /scenario            {close:[...], hours:[h0,h1], sample:N}
  GET  /ui/commands         Ghost Operator command bus (poll)
  POST /ui/emit             push a UI command
  POST /ask                 command bar -> deterministic operator -> choreography
  POST /ask/stop
  POST /voice/transcribe    browser mic -> ElevenLabs STT (key server-side)

All times in seconds · EPSG:27700 metres · 1km demand cells.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

import numpy as np
import polars as pl
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import service_ambulance as svc
import ambulance_posture as pos

app = FastAPI(title="SIXMINUTES · Ambulance", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
ROOT = Path(__file__).parent

# ---- standards / windowing -------------------------------------------------
PROMISE_S = 420                 # LAS Category-1 mean standard (7-minute promise)
# NHS England ARP Category-2 standards (citywide AmbSYS, published — never per-location)
C2_TARGET_MEAN_MIN = 18         # 18-minute C2 mean standard
C2_TARGET_P90_MIN = 40          # 40-minute C2 90th-percentile standard
DEFAULT_SAMPLE = 40_000
WINDOW = "annual demand · GLA Ward Atlas 2012–2014"
HIST_EDGES = [0, 120, 180, 240, 300, 360, 420, 480, 540, 600, 720, 900]

LOCK = threading.Lock()
WORLD: "World | None" = None
RUNS: dict[tuple[int, tuple[int, int] | None], "AmbRun"] = {}
WINDOW_N = 0                     # real LAS incidents/yr the demand surface represents


# ============================================================ WORLD
class World:
    """Stations, the borrowed travel model, the demand surface and ward geometry —
    everything the scenario engine needs, loaded once."""

    def __init__(self) -> None:
        PROC = svc.PROC
        st = (pl.read_parquet(PROC / "ambulance_stations.parquet")
              if (PROC / "ambulance_stations.parquet").exists() else svc.load_stations())
        self.names: list[str] = st["name"].to_list()
        self.SE = st["E"].to_numpy().astype(np.float64)
        self.SN = st["N"].to_numpy().astype(np.float64)
        self.sidx = {n: i for i, n in enumerate(self.names)}

        self.demand = (pl.read_parquet(PROC / "ambulance_demand.parquet")
                       if (PROC / "ambulance_demand.parquet").exists() else svc.load_demand())
        self.model = svc._load_travel_model()

        # diurnal hour shape, borrowed from LFB incident times (documented proxy)
        inc = pl.read_parquet(svc.DATA / "incidents_ambulance.parquet")
        hc = inc.group_by("HourOfCall").len().drop_nulls().sort("HourOfCall")
        self.hr_vals = hc["HourOfCall"].to_numpy()
        self.hr_p = hc["len"].to_numpy().astype(float)
        self.hr_p = self.hr_p / self.hr_p.sum()

        self.ward_names, self.ward_E, self.ward_N, self.ward_borough = _ward_centroids()
        self._relabel_placeholders()   # OSM stations with no name -> "{ward} Ambulance Station"

        # real incidents/yr the surface stands for (assign a scale to sampled counts)
        global WINDOW_N
        wd = pl.read_parquet(PROC / svc._WARD_DEMAND) if (PROC / svc._WARD_DEMAND).exists() else None
        WINDOW_N = int(round(float(wd["ambulance"].sum()))) if wd is not None else 1_070_000

    def _relabel_placeholders(self) -> None:
        """OSM stations missing a name tag arrive as 'amb_<id>'. Rename each to the
        nearest ward so the map/inspector read cleanly; dedupe on collision."""
        used = {n for n in self.names if not n.startswith("amb_")}
        for i, n in enumerate(self.names):
            if not n.startswith("amb_"):
                continue
            d2 = (self.ward_E - self.SE[i]) ** 2 + (self.ward_N - self.SN[i]) ** 2
            ward = self.ward_names[int(d2.argmin())] or "London"
            base = f"{ward} Ambulance Station"
            name, k = base, 2
            while name in used:
                name, k = f"{base} ({k})", k + 1
            used.add(name)
            self.names[i] = name
        self.sidx = {n: i for i, n in enumerate(self.names)}

    # to WGS84 for the map
    def wgs(self, E, N):
        from pyproj import Transformer
        t = Transformer.from_crs(27700, 4326, always_xy=True)
        lon, lat = t.transform(E, N)
        return np.asarray(lat), np.asarray(lon)


def _ward_centroids() -> tuple[list[str], np.ndarray, np.ndarray, list[str]]:
    """Centroid (BNG) + name + borough for every London ward polygon, so a sampled
    incident can be tagged to the ward the map paints (WD22NM)."""
    gj = json.loads((svc.DATA / "london_wards.geojson").read_text())
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, 27700, always_xy=True)
    names, boroughs, lons, lats = [], [], [], []
    for f in gj["features"]:
        props = f.get("properties", {})
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates")
        if not coords:
            continue
        # mean of the first ring's vertices (good enough for nearest-ward tagging)
        pts = coords[0][0] if geom.get("type") == "MultiPolygon" else coords[0]
        arr = np.asarray(pts, dtype=float)
        if arr.ndim != 2 or arr.shape[0] == 0:
            continue
        names.append(props.get("WD22NM", ""))
        boroughs.append(props.get("LAD22NM", ""))
        lons.append(float(arr[:, 0].mean()))
        lats.append(float(arr[:, 1].mean()))
    E, N = tr.transform(np.asarray(lons), np.asarray(lats))
    return names, np.asarray(E), np.asarray(N), boroughs


def _assign_wards(E: np.ndarray, N: np.ndarray) -> np.ndarray:
    """Nearest ward centroid for each incident -> array of ward-name strings."""
    w = WORLD
    out = np.empty(len(E), dtype=object)
    chunk = 20000
    for s0 in range(0, len(E), chunk):
        s1 = min(s0 + chunk, len(E))
        d2 = ((E[s0:s1, None] - w.ward_E[None, :]) ** 2
              + (N[s0:s1, None] - w.ward_N[None, :]) ** 2)
        idx = d2.argmin(axis=1)
        out[s0:s1] = [w.ward_names[j] for j in idx]
    return out


# ============================================================ CACHED RUN
class AmbRun:
    """One sampled population of C1 incidents + its full attendance matrix.
    Baseline = nearest over ALL stations; a scenario just masks columns and
    re-takes the row-min. Built once per (sample, hours), then reused."""

    def __init__(self, sample: int, hours: tuple[int, int] | None, seed: int = 14) -> None:
        w = WORLD
        r_space, r_time = (np.random.default_rng(s)
                           for s in np.random.SeedSequence(seed).spawn(2))
        self.E, self.N = svc._sample_incidents(w.demand, sample, r_space)
        # hour band: sample HR inside [h0,h1] (wraps midnight), else the diurnal shape
        if hours is None:
            HR = r_time.choice(w.hr_vals, size=sample, p=w.hr_p).astype(np.float32)
        else:
            h0, h1 = hours
            band = (list(range(h0, h1)) if h0 < h1 else list(range(h0, 24)) + list(range(0, h1)))
            HR = r_time.choice(np.asarray(band or [12]), size=sample).astype(np.float32)
        DOW = r_time.integers(1, 8, sample).astype(np.float32)
        MO = r_time.integers(1, 13, sample).astype(np.float32)

        att = svc._attendance_matrix(w.model, self.E, self.N, HR, DOW, MO, w.SE, w.SN)
        self.act = svc._sample_turnout(r_time, sample).astype(np.float32)
        att = att + self.act[:, None]
        att[att > 9e8] = np.inf                       # no station within 15km
        self.att = att.astype(np.float32)             # [n_inc, n_st], travel+activation

        order = np.argsort(np.where(np.isinf(att), 9e18, att), axis=1)
        rows = np.arange(len(self.E))
        self.nearest = order[:, 0]                    # baseline first-due station idx
        self.base_s = att[rows, self.nearest]         # baseline response seconds
        self.valid = np.isfinite(self.base_s)
        self.ward = _assign_wards(self.E, self.N)

    def masked_response(self, closed_idx: list[int]) -> np.ndarray:
        """Per-incident response with `closed_idx` stations removed (row-min over survivors)."""
        if not closed_idx:
            return self.base_s
        m = self.att.copy()
        m[:, closed_idx] = np.inf
        return m.min(axis=1)


def _run(sample: int, hours: tuple[int, int] | None) -> AmbRun:
    with LOCK:
        key = (sample, hours)
        if key not in RUNS:
            RUNS[key] = AmbRun(sample, hours)
        return RUNS[key]


# ============================================================ LIFECYCLE
@app.on_event("startup")
def _load() -> None:
    global WORLD
    WORLD = World()
    print(f"[amb-api] {len(WORLD.names)} stations · {WORLD.demand.height} demand rows · "
          f"{WINDOW_N:,} real incidents/yr")

    def _prewarm() -> None:
        _run(DEFAULT_SAMPLE, None)
        print("[amb-api] baseline prewarmed")
    threading.Thread(target=_prewarm, daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {"ok": WORLD is not None, "stations": len(WORLD.names) if WORLD else 0,
            "promise_s": PROMISE_S}


# ============================================================ STATIONS / WARDS
_VEH_CACHE: dict[str, int] | None = None


def _vehicles() -> dict[str, int]:
    """Synthetic per-station vehicle count, scaled by how many baseline incidents the
    station is first-due for (so the map's marker sizes mean something). 2–9."""
    global _VEH_CACHE
    if _VEH_CACHE is None:
        run = _run(DEFAULT_SAMPLE, None)
        counts = np.bincount(run.nearest[run.valid], minlength=len(WORLD.names))
        share = counts / max(1, counts.max())
        _VEH_CACHE = {WORLD.names[i]: int(2 + round(7 * share[i])) for i in range(len(WORLD.names))}
    return _VEH_CACHE


@app.get("/stations")
def stations() -> list[dict]:
    w = WORLD
    lat, lon = w.wgs(w.SE, w.SN)
    veh = _vehicles()
    return [
        {"name": w.names[i], "E": float(w.SE[i]), "N": float(w.SN[i]),
         "lat": float(lat[i]), "lon": float(lon[i]),
         "pumps": veh[w.names[i]]}                    # field named `pumps` for FE shape-parity
        for i in range(len(w.names))
    ]


@app.get("/wards")
def wards() -> list[dict]:
    run = _run(DEFAULT_SAMPLE, None)
    w = WORLD
    cnt: dict[str, int] = {}
    for k in run.ward[run.valid]:
        cnt[k] = cnt.get(k, 0) + 1
    centroid = {w.ward_names[i]: (w.ward_E[i], w.ward_N[i], w.ward_borough[i])
                for i in range(len(w.ward_names))}
    out = []
    for name, n in cnt.items():
        if name not in centroid:
            continue
        E, N, boro = centroid[name]
        lat, lon = w.wgs(np.array([E]), np.array([N]))
        out.append({"ward": name, "borough": boro,
                    "lat": float(lat[0]), "lon": float(lon[0]), "n": int(n)})
    return out


@app.get("/wards_geo")
def wards_geo() -> dict:
    return json.loads((svc.DATA / "london_wards.geojson").read_text())


# ============================================================ BASELINE
@app.get("/baseline")
def baseline(hours: str | None = None) -> dict:
    hb = _parse_hours(hours)
    run = _run(DEFAULT_SAMPLE, hb)
    s = run.base_s[run.valid]
    return {
        "n": int(s.size),
        "window": WINDOW,
        "window_n": WINDOW_N,
        "mean_s": round(float(s.mean()), 1),
        "median_s": round(float(np.median(s)), 1),
        "p90_s": round(float(np.percentile(s, 90)), 1),
        "promise_rate": round(float((s <= PROMISE_S).mean()), 4),
    }


def _parse_hours(hours: str | None) -> tuple[int, int] | None:
    if not hours:
        return None
    try:
        a, b = (int(x) for x in hours.split(","))
        return (a, b)
    except Exception:
        raise HTTPException(400, "hours must be 'h0,h1', e.g. 22,6")


# ============================================================ STATION INSPECTOR
_DAMAGE_CACHE: dict[str, dict] | None = None


def _damage(run: AmbRun) -> dict[str, dict]:
    """Per-station closure cost from the cached matrix: for incidents this station is
    first-due for, how much does the second-best add, and how many tip past the promise."""
    global _DAMAGE_CACHE
    if _DAMAGE_CACHE is not None:
        return _DAMAGE_CACHE
    att = run.att
    order = np.argsort(np.where(np.isinf(att), 9e18, att), axis=1)
    rows = np.arange(att.shape[0])
    best = att[rows, order[:, 0]]
    second = att[rows, order[:, 1]]
    valid = np.isfinite(best) & np.isfinite(second)
    nearest = order[:, 0][valid]
    delta = np.maximum(second[valid] - best[valid], 0.0)
    b2, s2 = best[valid], second[valid]
    out: dict[str, dict] = {}
    scale = WINDOW_N / att.shape[0]
    for i in range(len(WORLD.names)):
        sel = nearest == i
        c = int(sel.sum())
        if c == 0:
            continue
        pushed = int(((s2[sel] > PROMISE_S) & (b2[sel] <= PROMISE_S)).sum())
        out[WORLD.names[i]] = {
            "calls": c,
            "local_added_s": float(np.mean(delta[sel])),
            "pushed_past_promise_yr": int(round(pushed * scale)),
            "city_added_s": float(np.sum(delta[sel]) / att.shape[0]),
        }
    _DAMAGE_CACHE = out
    return out


@app.get("/station/{name}")
def station_detail(name: str) -> dict:
    w = WORLD
    if name not in w.sidx:
        raise HTTPException(404, f"unknown station '{name}'")
    i = w.sidx[name]
    run = _run(DEFAULT_SAMPLE, None)
    dmg = _damage(run).get(name)

    # nearest cover web: 3 closest stations by metres
    d2 = (w.SE - w.SE[i]) ** 2 + (w.SN - w.SN[i]) ** 2
    nearest = [{"name": w.names[j], "km": round(float(np.sqrt(d2[j])) / 1000, 1)}
               for j in np.argsort(d2)[1:4]]

    # ground wards: where is this station first-due most often
    sel = (run.nearest == i) & run.valid
    wcnt: dict[str, int] = {}
    for k in run.ward[sel]:
        wcnt[k] = wcnt.get(k, 0) + 1
    ground = [k for k, _ in sorted(wcnt.items(), key=lambda kv: -kv[1])[:5]]

    calls = int(sel.sum())
    scale = WINDOW_N / DEFAULT_SAMPLE
    return {
        "name": name,
        "pumps": _vehicles()[name],
        "nearest_cover": nearest,
        "calls_carried_sample": calls,
        "calls_carried_per_yr": int(round(calls * scale)),
        "turnout_day_med_s": None,                    # no per-amb-station turnout in source
        "turnout_night_med_s": None,
        "ground_wards": ground,
        "closure": (
            {"local_added_s": round(dmg["local_added_s"], 1),
             "pushed_past_6min": dmg["pushed_past_promise_yr"],   # FE field name; value = /yr
             "city_added_s": round(dmg["city_added_s"], 2)} if dmg else None
        ),
    }


# ============================================================ SCENARIO
class Scenario(BaseModel):
    close: list[str] = Field(default_factory=list)
    hours: list[int] | None = Field(default=None, min_length=2, max_length=2)
    sample: int = Field(default=DEFAULT_SAMPLE, ge=5_000, le=140_000)


@app.post("/scenario")
def scenario(s: Scenario) -> dict:
    w = WORLD
    unknown = [x for x in s.close if x not in w.sidx]
    if unknown:
        raise HTTPException(400, f"unknown stations: {unknown}; see GET /stations")
    if len(s.close) > 40:
        raise HTTPException(400, "closing more than 40 stations isn't a scenario, it's an apocalypse")
    t0 = time.time()
    hours = tuple(s.hours) if s.hours else None
    run = _run(s.sample, hours)
    closed_idx = [w.sidx[n] for n in s.close]

    base = run.base_s
    cf = run.masked_response(closed_idx)
    finite = np.isfinite(base) & np.isfinite(cf)
    b = base[finite]
    c = cf[finite]
    d = c - b
    ward = run.ward[finite]
    scale = WINDOW_N / s.sample

    # per-ward deltas
    df = pl.DataFrame({"ward": ward.astype(str), "base": b, "scen": c, "d": d})
    by_ward = (df.group_by("ward")
               .agg(delta_mean_s=pl.col("d").mean(), n=pl.len(),
                    pushed_360=((pl.col("scen") > PROMISE_S) & (pl.col("base") <= PROMISE_S)).sum())
               .filter(pl.col("n") >= 20)
               .sort("delta_mean_s", descending=True))
    affected = by_ward.filter(pl.col("delta_mean_s").abs() > 5)
    # borough lookup for worst-wards table
    boro = {w.ward_names[i]: w.ward_borough[i] for i in range(len(w.ward_names))}

    hist_base = np.histogram(b, bins=HIST_EDGES + [1e9])[0].tolist()
    hist_cf = np.histogram(c, bins=HIST_EDGES + [1e9])[0].tolist()

    return {
        "posture": {"close": s.close, "pump_delta": {}},
        "window": WINDOW,
        "hours": s.hours,
        "scale": round(scale, 3),
        "elapsed_s": round(time.time() - t0, 3),
        "city": {
            "mean_delta_s": round(float(d.mean()), 1) if d.size else 0.0,
            "p90_delta_s": round(float(np.percentile(d, 90)), 1) if d.size else 0.0,
            "pushed_past_6min": int(((c > PROMISE_S) & (b <= PROMISE_S)).sum()),
        },
        "kpi": {
            "base": {"mean_s": round(float(b.mean()), 1), "p90_s": round(float(np.percentile(b, 90)), 1),
                     "promise_rate": round(float((b <= PROMISE_S).mean()), 4)},
            "scenario": {"mean_s": round(float(c.mean()), 1), "p90_s": round(float(np.percentile(c, 90)), 1),
                         "promise_rate": round(float((c <= PROMISE_S).mean()), 4)},
            "n": int(b.size),
        },
        "hist": {"edges": HIST_EDGES, "base": hist_base, "scenario": hist_cf},
        "worst_wards": [
            {"ward": r["ward"], "borough": boro.get(r["ward"], ""),
             "delta_mean_s": round(r["delta_mean_s"], 1), "n": int(r["n"]),
             "pushed_360": int(round(r["pushed_360"] * scale))}
            for r in affected.head(30).iter_rows(named=True)
        ],
        "ward_deltas": {r["ward"]: round(r["delta_mean_s"], 1) for r in by_ward.iter_rows(named=True)},
    }


# ============================================================ INSIGHTS
# Three official-facing layers: (1) the broken C2 promise from real AmbSYS data,
# (2) a per-cell coverage surface for the hero map, (3) predictive-posture playbooks.

_C2_CACHE: dict | None = None


@app.get("/c2_series")
def c2_series() -> dict:
    """Real London Ambulance Service monthly response times from AmbSYS — the broken
    Category-2 promise. This is published, force-level (citywide) data: it says the
    promise is broken across London, never where a specific call was slow."""
    global _C2_CACHE
    if _C2_CACHE is not None:
        return _C2_CACHE
    las = svc.las_targets()
    series = []
    for r in las.iter_rows(named=True):
        if r["c2_mean_s"] is None:
            continue
        series.append({
            "year": int(r["year"]), "month": int(r["month"]),
            "label": f"{int(r['year'])}-{int(r['month']):02d}",
            "c2_mean_min": round(r["c2_mean_s"] / 60, 1),
            "c2_p90_min": round(r["c2_p90_s"] / 60, 1) if r["c2_p90_s"] else None,
            "c1_mean_min": round(r["c1_mean_s"] / 60, 1) if r["c1_mean_s"] else None,
        })
    latest = series[-1] if series else None
    worst = max(series, key=lambda m: m["c2_mean_min"]) if series else None
    recent = [m for m in series if latest and m["year"] >= latest["year"] - 2]
    winter = [m["c2_mean_min"] for m in recent if m["month"] in (11, 12, 1, 2)]
    summer = [m["c2_mean_min"] for m in recent if m["month"] in (5, 6, 7, 8)]
    _C2_CACHE = {
        "org": "London Ambulance Service",
        "source": "NHS AmbSYS (published, force-level / citywide)",
        "standards_min": {"c2_mean": C2_TARGET_MEAN_MIN, "c2_p90": C2_TARGET_P90_MIN,
                          "c1_mean": 7, "c1_p90": 15},
        "series": series,
        "headline": {
            "latest": latest, "worst": worst,
            "winter_mean_min": round(sum(winter) / len(winter), 1) if winter else None,
            "summer_mean_min": round(sum(summer) / len(summer), 1) if summer else None,
        },
    }
    return _C2_CACHE


_COVERAGE_CACHE: dict[tuple, dict] = {}


@app.get("/coverage_cells")
def coverage_cells(hour: int = 18, category: str = "proxy_all") -> dict:
    """Per-cell predicted response over the real demand surface — the hero map layer.
    Cells where a long predicted response meets heavy demand are the standby priorities.
    `category` re-weights demand by stream (all / assault / alcohol)."""
    if category not in ("proxy_all", "assault", "alcohol"):
        raise HTTPException(400, "category must be proxy_all|assault|alcohol")
    hour = int(hour) % 24
    key = (hour, category)
    if key in _COVERAGE_CACHE:
        return _COVERAGE_CACHE[key]
    w_ = WORLD
    dem = w_.demand.filter(pl.col("category") == category)
    gx = dem["gx"].to_numpy(); gy = dem["gy"].to_numpy()
    weight = dem["weight"].to_numpy().astype(float)
    E = ((gx + 0.5) * 1000.0).astype(np.float32)
    N = ((gy + 0.5) * 1000.0).astype(np.float32)
    turn = pos._turnout_const()
    stats, best = pos.coverage(E, N, weight, w_.SE, w_.SN, hour, w_.model, turn)
    lat, lon = w_.wgs(E, N)
    target = pos.TARGET
    cells = []
    for i in range(len(E)):
        r = best[i]
        covered = bool(np.isfinite(r))
        cells.append({
            "cell": f"E{int(gx[i])}_N{int(gy[i])}",
            "lat": round(float(lat[i]), 5), "lon": round(float(lon[i]), 5),
            "demand": int(round(weight[i])),
            "response_s": round(float(r), 0) if covered else None,
            "over_target": (not covered) or (float(r) > target),
        })
    out = {
        "hour": hour, "category": category, "target_s": target,
        "n_cells": len(cells), "demand_total": int(round(float(weight.sum()))),
        "window_n": WINDOW_N, "summary": stats, "cells": cells,
    }
    _COVERAGE_CACHE[key] = out
    return out


@app.get("/hospitals")
def hospitals() -> list[dict]:
    """Major London A&Es used by the handover-drain playbook."""
    return [{"name": n, "lat": lat, "lon": lon} for n, (lon, lat) in pos.HOSPITALS.items()]


_POSTURE_CACHE: dict[tuple, dict] = {}


def _geolocate_cells(obj: dict) -> dict:
    """Walk a posture result, find every 'E{gx}_N{gy}' cell ref, and attach a
    cell -> {lat, lon} map so the frontend can drop standby pins on the board."""
    found: set[str] = set()

    def walk(x):
        if isinstance(x, str):
            if re.fullmatch(r"E\d+_N\d+", x):
                found.add(x)
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(obj)
    if found:
        order = sorted(found)
        gx, gy = [], []
        for c in order:
            m = re.fullmatch(r"E(\d+)_N(\d+)", c)
            gx.append(int(m.group(1))); gy.append(int(m.group(2)))
        E = (np.asarray(gx) + 0.5) * 1000.0
        N = (np.asarray(gy) + 0.5) * 1000.0
        lat, lon = WORLD.wgs(E, N)
        obj["cell_coords"] = {
            order[i]: {"lat": round(float(lat[i]), 5), "lon": round(float(lon[i]), 5)}
            for i in range(len(order))
        }
    return obj


@app.get("/posture/{playbook}")
def posture_play(playbook: str, bucket: str = "pm", hospital: str | None = None,
                 n_units: int = 6, stuck_frac: float = 0.15, n_standby: int = 5) -> dict:
    """Predictive-posture playbooks (where to pre-position idle units):
      standby  — under-served hot demand at this time of day
      handover — a hospital A&E ties up N nearest units; who loses C1 + best patch
      winter   — chronic handover backlog citywide + standby recovery
    All modeled on the same validated free-flow engine."""
    if bucket not in pos.BUCKETS:
        raise HTTPException(400, f"bucket must be one of {sorted(pos.BUCKETS)}")
    key = (playbook, bucket, hospital, int(n_units), round(float(stuck_frac), 3), int(n_standby))
    if key in _POSTURE_CACHE:
        return _POSTURE_CACHE[key]
    try:
        if playbook == "standby":
            out = pos.standby_posture(bucket=bucket)
        elif playbook == "handover":
            hosp = hospital or next(iter(pos.HOSPITALS))
            if hosp not in pos.HOSPITALS:
                raise HTTPException(400, "unknown hospital; see GET /hospitals")
            out = pos.handover_drain(hospital=hosp, n_units=int(n_units), bucket=bucket)
        elif playbook == "winter":
            out = pos.winter_surge(stuck_frac=float(stuck_frac), n_standby=int(n_standby), bucket=bucket)
        else:
            raise HTTPException(404, "playbook must be standby|handover|winter")
    except HTTPException:
        raise
    except FileNotFoundError as e:
        raise HTTPException(503, f"posture data not built: {e}")
    out = _geolocate_cells(out)
    _POSTURE_CACHE[key] = out
    return out


# ============================================================ GHOST OPERATOR
UI_COMMANDS: list[dict] = []
ASK_BUSY = threading.Lock()
STOP_FLAG = threading.Event()
ALLOWED_CMDS = {"narrate", "reset", "close_stations", "run_scenario",
                "focus_ward", "focus_station", "move_unit", "audio"}


@app.get("/ui/commands")
def ui_commands(since: int = 0) -> dict:
    return {"next": len(UI_COMMANDS), "commands": UI_COMMANDS[max(0, since):]}


def _emit(cmd: dict) -> dict:
    if cmd.get("type") not in ALLOWED_CMDS:
        raise HTTPException(400, f"unknown command type; allowed: {sorted(ALLOWED_CMDS)}")
    if len(UI_COMMANDS) > 5000:
        raise HTTPException(429, "command bus full")
    if "text" in cmd:
        cmd["text"] = str(cmd["text"])[:600]
    cmd["id"] = len(UI_COMMANDS)
    cmd["ts"] = time.time()
    UI_COMMANDS.append(cmd)
    return {"ok": True, "id": cmd["id"]}


@app.post("/ui/emit")
def ui_emit(cmd: dict) -> dict:
    return _emit(cmd)


@app.post("/ask/stop")
def ask_stop() -> dict:
    STOP_FLAG.set()
    return {"ok": True}


class Ask(BaseModel):
    text: str = Field(max_length=2000)
    speak: bool = True
    context: dict | None = None


def _match_stations(text: str) -> list[str]:
    """Find station names mentioned in free text (whole-word, case-insensitive)."""
    t = text.lower()
    hits = []
    for name in WORLD.names:
        stem = name.lower().replace(" ambulance station", "").strip()
        if stem and re.search(rf"\b{re.escape(stem)}\b", t):
            hits.append(name)
    return hits


def _answer_for(text: str) -> tuple[str, list[dict]]:
    """Deterministic operator: ground a plain-English answer + map choreography in the
    real scenario engine. (No LLM — a grounded stand-in until the ambulance agent lands.)"""
    t = text.lower().strip()
    cmds: list[dict] = []

    if any(k in t for k in ("reset", "clear the board", "start over")):
        cmds.append({"type": "reset"})
        return "Board reset — every station back online.", cmds

    named = _match_stations(text)
    wants_close = any(k in t for k in ("close", "shut", "lose", "offline", "down", "what if"))
    if named and (wants_close or "cost" in t or "damage" in t):
        res = scenario(Scenario(close=named))
        d = res["city"]["mean_delta_s"]
        pushed = int(round(res["city"]["pushed_past_6min"] * res["scale"]))
        worst = res["worst_wards"][0] if res["worst_wards"] else None
        cmds.append({"type": "close_stations", "names": named})
        cmds.append({"type": "run_scenario"})
        worst_txt = (f" The worst-hit ward is {worst['ward']} at +{round(worst['delta_mean_s'])}s."
                     if worst else "")
        ans = (f"Closing {', '.join(n.replace(' Ambulance Station','') for n in named)} moves "
               f"London's mean C1 response {'+' if d >= 0 else ''}{d}s, with about "
               f"{pushed:,} calls a year pushed past the 7-minute promise.{worst_txt}")
        cmds.append({"type": "narrate", "text": ans, "final": True})
        return ans, cmds

    if named:  # just inspect
        cmds.append({"type": "focus_station", "name": named[0]})
        ans = (f"Focused on {named[0].replace(' Ambulance Station','')}. Click it to close it, "
               f"or ask what its closure would cost.")
        cmds.append({"type": "narrate", "text": ans, "final": True})
        return ans, cmds

    if "rank" in t or "worst" in t or "irreplaceable" in t:
        dmg = _damage(_run(DEFAULT_SAMPLE, None))
        top = sorted(dmg.items(), key=lambda kv: -kv[1]["local_added_s"])[:5]
        rows = "; ".join(f"{n.replace(' Ambulance Station','')} +{round(v['local_added_s'])}s"
                         for n, v in top)
        ans = f"Most damaging ambulance closures, by added local response: {rows}."
        cmds.append({"type": "narrate", "text": ans, "final": True})
        return ans, cmds

    ans = ("Click an ambulance station to close it and watch London re-simulate, or ask me "
           "what closing a named station would cost.")
    cmds.append({"type": "narrate", "text": ans, "final": True})
    return ans, cmds


@app.post("/ask")
def ask(a: Ask) -> dict:
    if not ASK_BUSY.acquire(blocking=False):
        raise HTTPException(429, "operator is mid-choreography; wait for it to finish")
    try:
        STOP_FLAG.clear()
        ctx_close = (a.context or {}).get("closed") or []
        text = a.text
        if ctx_close:
            text = f"[BOARD: closed={ctx_close}] {a.text}"
        answer, cmds = _answer_for(text)
        for c in cmds:
            _emit(c)
        if a.speak and answer:
            out = _tts(answer[:600])
            if out:
                _emit({"type": "audio", "url": f"/audio/{out}", "text": answer[:600]})
        return {"answer": answer}
    finally:
        ASK_BUSY.release()


# ============================================================ VOICE (ElevenLabs)
def _tts(text: str) -> str | None:
    """Best-effort TTS via ElevenLabs; returns a filename under logs/audio or None.
    Reuses the same audio dir + voice the fire engine serves."""
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        return None
    try:
        import httpx
        voice = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
            headers={"xi-api-key": key},
            json={"text": text, "model_id": "eleven_flash_v2_5"},
            timeout=60,
        )
        if r.status_code != 200:
            return None
        out_dir = ROOT / "logs/audio"
        out_dir.mkdir(parents=True, exist_ok=True)
        fname = f"amb_{int(time.time()*1000)}.mp3"
        (out_dir / fname).write_bytes(r.content)
        return fname
    except Exception:
        return None


@app.post("/voice/transcribe")
def voice_transcribe(file: UploadFile = File(...)) -> dict:
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        raise HTTPException(503, "voice not configured on this engine")
    import httpx
    data = file.file.read()
    if len(data) > 10_000_000:
        raise HTTPException(413, "audio too large")
    r = httpx.post(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers={"xi-api-key": key},
        data={"model_id": "scribe_v1"},
        files={"file": (file.filename or "voice.webm", data, file.content_type or "audio/webm")},
        timeout=60,
    )
    if r.status_code != 200:
        raise HTTPException(502, f"transcription failed: {r.status_code}")
    return {"text": r.json().get("text", "")}


# serve generated audio (shared dir with the fire engine)
from fastapi.staticfiles import StaticFiles  # noqa: E402

(ROOT / "logs/audio").mkdir(parents=True, exist_ok=True)
app.mount("/audio", StaticFiles(directory=ROOT / "logs/audio"), name="audio")
