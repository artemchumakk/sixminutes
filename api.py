"""SIXMINUTES scenario API.

  uvicorn api:app --host 0.0.0.0 --port 8090

POST /scenario      {"close": ["Soho"], "pump_delta": {"Acton": -1}, "sample": 40000}
GET  /stations      station list + coords + pumps
GET  /baseline      cached baseline stats
GET  /validation    held-out validation table (the trust anchor)
GET  /layers/{svc}  GeoJSON overlays dropped by service tiers (fire|police|ambulance)
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import polars as pl
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import sim

app = FastAPI(title="SIXMINUTES", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

WORLD: sim.World | None = None
BASELINE: dict[int, pl.DataFrame] = {}      # sample_size -> baseline run
P_UNAVAIL = 0.40                            # calibrated on 2024 (see sim.calibrate)
LOCK = threading.Lock()
DEFAULT_SAMPLE = 40_000


class Scenario(BaseModel):
    close: list[str] = Field(default_factory=list)
    pump_delta: dict[str, int] = Field(default_factory=dict)
    sample: int = Field(default=DEFAULT_SAMPLE, ge=5_000, le=140_000)


def _baseline(n: int) -> pl.DataFrame:
    with LOCK:
        if n not in BASELINE:
            BASELINE[n] = sim.simulate(WORLD, sim.Posture(), year=2025, sample=n,
                                       seed=14, p_unavail=P_UNAVAIL)
        return BASELINE[n]


@app.on_event("startup")
def _load() -> None:
    global WORLD
    WORLD = sim.World()
    threading.Thread(target=_baseline, args=(DEFAULT_SAMPLE,), daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {"ok": WORLD is not None, "stations": len(WORLD.names) if WORLD else 0}


@app.get("/")
def index():
    from fastapi.responses import FileResponse
    return FileResponse(Path(__file__).parent / "dashboard.html")


def _to_wgs(E, N):
    from pyproj import Transformer
    t = Transformer.from_crs(27700, 4326, always_xy=True)
    lon, lat = t.transform(E, N)
    return lat, lon


@app.get("/stations")
def stations() -> list[dict]:
    w = WORLD
    lat, lon = _to_wgs(w.SE, w.SN)
    return [
        {"name": w.names[i], "E": float(w.SE[i]), "N": float(w.SN[i]),
         "lat": float(lat[i]), "lon": float(lon[i]), "pumps": int(w.pumps[i])}
        for i in range(len(w.names))
    ]


@app.get("/wards")
def wards() -> list[dict]:
    """Ward centroids (from incident coords) for delta visualisation."""
    w = (WORLD.inc.group_by("IncGeo_WardName", "IncGeo_BoroughName")
         .agg(E=pl.col("Easting_rounded").median(), N=pl.col("Northing_rounded").median(), n=pl.len())
         .filter(pl.col("n") >= 20))
    lat, lon = _to_wgs(w["E"].to_numpy(), w["N"].to_numpy())
    return [
        {"ward": r["IncGeo_WardName"], "borough": r["IncGeo_BoroughName"],
         "lat": float(lat[i]), "lon": float(lon[i]), "n": int(r["n"])}
        for i, r in enumerate(w.iter_rows(named=True))
    ]


@app.get("/validation")
def validation() -> dict:
    p = Path("docs/validation.md")
    if not p.exists():
        raise HTTPException(404, "run: python sim.py --validate")
    return {"markdown": p.read_text()}


@app.get("/baseline")
def baseline() -> dict:
    b = _baseline(DEFAULT_SAMPLE)
    return {
        "n": b.height,
        "mean_s": float(b["sim_s"].mean()),
        "p90_s": float(b["sim_s"].quantile(0.9)),
        "throughput_inc_per_s": sim.METRICS["rate"],
    }


@app.post("/scenario")
def scenario(s: Scenario) -> dict:
    w = WORLD
    unknown = [x for x in list(s.close) + list(s.pump_delta) if x not in w.sidx]
    if unknown:
        raise HTTPException(400, f"unknown stations: {unknown}; see GET /stations")
    t0 = time.time()
    base = _baseline(s.sample)
    posture = sim.Posture(closed=frozenset(s.close), pump_delta=dict(s.pump_delta))
    cf = sim.simulate(w, posture, year=2025, sample=s.sample, seed=14, p_unavail=P_UNAVAIL)
    j = base.select("IncidentNumber", base_s=pl.col("sim_s")).join(
        cf.select("IncidentNumber", "sim_s", "ward", "borough"), on="IncidentNumber"
    ).with_columns(d=pl.col("sim_s") - pl.col("base_s"))

    by_ward = (
        j.group_by("ward", "borough")
        .agg(delta_mean_s=pl.col("d").mean(), n=pl.len(),
             pushed_360=((pl.col("sim_s") > 360) & (pl.col("base_s") <= 360)).sum())
        .filter(pl.col("n") >= 20)
        .sort("delta_mean_s", descending=True)
    )
    affected = by_ward.filter(pl.col("delta_mean_s").abs() > 5)
    return {
        "posture": {"close": s.close, "pump_delta": s.pump_delta},
        "elapsed_s": round(time.time() - t0, 2),
        "city": {
            "mean_delta_s": round(float(j["d"].mean()), 1),
            "p90_delta_s": round(float(j["d"].quantile(0.9)), 1),
            "pushed_past_6min": int(j.filter((pl.col("sim_s") > 360) & (pl.col("base_s") <= 360)).height),
        },
        "worst_wards": affected.head(12).to_dicts(),
        "ward_deltas": {r["ward"]: round(r["delta_mean_s"], 1) for r in by_ward.iter_rows(named=True)},
    }


@app.get("/layers/{svc}")
def layers(svc: str) -> dict:
    safe = {"fire", "police", "ambulance"}
    if svc not in safe:
        raise HTTPException(404, f"service must be one of {sorted(safe)}")
    geo = Path(f"data/processed/geo/{svc}.geojson")
    if not geo.exists():
        candidates = sorted(Path("data/processed/geo").glob(f"{svc}_*.geojson"))
        if not candidates:
            raise HTTPException(404, f"no layers for {svc} yet (teammates: see README contracts)")
        geo = candidates[0]
    return json.loads(geo.read_text())
