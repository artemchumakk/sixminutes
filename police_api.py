"""SIXMINUTES — POLICE scenario API (Tier B).  Police-native parallel to api.py.

  uvicorn police_api:app --host 0.0.0.0 --port 8096

POST /scenario      {"close": ["Biggin Hill"], "category": "violence"}
GET  /stations      police estate + coords + kind
GET  /cells         demand surface (crimes/mo per 1 km cell) for ?category=
GET  /categories    available crime categories
GET  /baseline      anchored city response + demand size
GET  /validation    Tier-B honesty doc (the trust anchor)
GET  /layers/{svc}  GeoJSON overlays dropped by service tiers (fire|police|ambulance)

The engine is deterministic (police data has no incident timestamps to replay), so there
is no background simulation to warm — PoliceWorld precomputes the attendance physics once
at startup and every scenario is a cheap column-mask reroute.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

import police_engine as eng

app = FastAPI(title="SIXMINUTES · Police", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ROOT = Path(__file__).parent
GEO = ROOT / "data" / "processed" / "geo"
WORLD: eng.PoliceWorld | None = None

# Voice — identical to the fire tier (agent.py): same ElevenLabs voice + model. Key is
# read from .env at startup (run_police_api.sh sources it); absent key ⇒ /tts 503s and the
# frontend falls back to the browser voice. No key is committed.
EL_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
EL_VOICE = os.environ.get("ELEVENLABS_VOICE", "21m00Tcm4TlvDq8ikWAM")
EL_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_turbo_v2_5")


class Scenario(BaseModel):
    close: list[str] = Field(default_factory=list)
    category: str = Field(default="all")


@app.on_event("startup")
def _load() -> None:
    global WORLD
    WORLD = eng.PoliceWorld()


@app.get("/health")
def health() -> dict:
    return {"ok": WORLD is not None,
            "stations": len(WORLD.names) if WORLD else 0,
            "cells": len(WORLD.cells) if WORLD else 0,
            "tts": bool(EL_KEY)}


@app.get("/tts")
def tts(text: str) -> Response:
    """Speak the Watch Commander's answer with ElevenLabs — identical settings to the fire
    tier (voice 21m00Tcm4TlvDq8ikWAM, model eleven_turbo_v2_5). Returns MP3 bytes. Returns
    503 when no ELEVENLABS_API_KEY is configured so the frontend falls back to browser TTS."""
    if not EL_KEY:
        raise HTTPException(503, "no ELEVENLABS_API_KEY")
    clean = (text or "").strip()
    if not clean:
        raise HTTPException(400, "empty text")
    body = json.dumps({"text": clean[:600], "model_id": EL_MODEL}).encode()
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{EL_VOICE}",
        data=body,
        headers={"xi-api-key": EL_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            audio = resp.read()
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"elevenlabs error {e.code}")
    except urllib.error.URLError as e:
        raise HTTPException(502, f"elevenlabs unreachable: {e.reason}")
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


@app.get("/")
def index():
    return FileResponse(ROOT / "police_dashboard.html")


@app.get("/stations")
def stations() -> list[dict]:
    w = WORLD
    return [{"name": w.names[i], "kind": w.kind[i],
             "E": float(w.SE[i]), "N": float(w.SN[i]),
             "lat": float(w.slat[i]), "lon": float(w.slon[i])}
            for i in range(len(w.names))]


@app.get("/cells")
def cells(category: str = "all") -> list[dict]:
    return WORLD.cells_payload(category)


@app.get("/categories")
def categories() -> list[str]:
    return WORLD.categories


@app.get("/predict")
def predict(lat: float, lon: float, radius_km: float = 2.0) -> dict:
    """Area crime profile + 3-year trend forecast for a clicked/geocoded point.
    Aggregates the 1 km demand cells within radius_km and projects next month's rate."""
    radius_km = max(0.5, min(10.0, radius_km))
    return WORLD.predict(lat, lon, radius_km)


@app.get("/allocation")
def allocation(units: int = 600) -> dict:
    """Demand-matched deployment: distribute `units` response units across station
    catchments by crimes/month, vs an estate-even spread. Surfaces workload imbalance."""
    units = max(100, min(2000, units))
    return WORLD.allocate(units)


@app.get("/plan")
def plan(units: int = 800) -> dict:
    """Next-month redeployment plan: today's even footprint vs units matched to each
    catchment's PROJECTED next-month demand. Returns the per-station transfers
    (pull from over-served, reinforce rising hotspots) in plain, presentable form."""
    units = max(100, min(2000, units))
    return WORLD.plan(units)


@app.get("/baseline")
def baseline() -> dict:
    return WORLD.baseline_stats()


@app.get("/validation")
def validation() -> dict:
    for p in (ROOT / "POLICE_VALIDATION.md", ROOT / "docs" / "insights_police.md"):
        if p.exists():
            return {"markdown": p.read_text()}
    raise HTTPException(404, "no police validation doc (expected POLICE_VALIDATION.md)")


@app.post("/scenario")
def scenario(s: Scenario) -> dict:
    w = WORLD
    unknown = [x for x in s.close if x not in w.sidx]
    if unknown:
        raise HTTPException(400, f"unknown stations: {unknown}; see GET /stations")
    t0 = time.time()
    out = eng.scenario(w, s.close, s.category)
    out["elapsed_s"] = round(time.time() - t0, 3)
    return out


@app.get("/damage")
def damage() -> dict:
    """Per-station closure criticality: how badly closing each station hurts the
    area it served (mean_added_s over its catchment) — the quiet-but-critical signal
    the agent quotes. Same source as the SQL closure_damage table."""
    geo = GEO / "police_damage.geojson"
    if not geo.exists():
        raise HTTPException(404, "no police_damage.geojson")
    return json.loads(geo.read_text())


@app.get("/layers/{svc}")
def layers(svc: str) -> dict:
    safe = {"fire", "police", "ambulance"}
    if svc not in safe:
        raise HTTPException(404, f"service must be one of {sorted(safe)}")
    geo = GEO / f"{svc}.geojson"
    if not geo.exists():
        cand = sorted(GEO.glob(f"{svc}_*.geojson"))
        if not cand:
            raise HTTPException(404, f"no layers for {svc} yet (see README contracts)")
        geo = cand[0]
    return json.loads(geo.read_text())
