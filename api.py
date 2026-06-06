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
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import sim

app = FastAPI(title="SIXMINUTES", version="0.2")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
ROOT = Path(__file__).parent
(ROOT / "logs/audio").mkdir(parents=True, exist_ok=True)
app.mount("/vendor", StaticFiles(directory=ROOT / "static/vendor"), name="vendor")
app.mount("/audio", StaticFiles(directory=ROOT / "logs/audio"), name="audio")

WORLD: sim.World | None = None
BASELINE: dict[tuple[int, str], pl.DataFrame] = {}   # (sample, world) -> baseline run
P_UNAVAIL = 0.40                            # calibrated on 2024 (see sim.calibrate)
LOCK = threading.Lock()
DEFAULT_SAMPLE = 40_000
LSP5: dict[str, list[float]] = json.loads((ROOT / "data/lsp5_coords.json").read_text())

# ---- Ghost Operator command bus -------------------------------------------
UI_COMMANDS: list[dict] = []
ASK_HISTORY: list[dict] = []
ASK_BUSY = threading.Lock()


class Scenario(BaseModel):
    close: list[str] = Field(default_factory=list)
    open: list[str] = Field(default_factory=list)        # names from LSP5 catalogue
    pump_delta: dict[str, int] = Field(default_factory=dict)
    baseline: str = Field(default="current", pattern="^(current|pre2014)$")
    hours: list[int] | None = Field(default=None, min_length=2, max_length=2)  # [22,6] = night map
    sample: int = Field(default=DEFAULT_SAMPLE, ge=5_000, le=140_000)


def _posture(close: list[str], open_: list[str], pump_delta: dict[str, int]) -> sim.Posture:
    opened = {n: (LSP5[n][0], LSP5[n][1], 1) for n in open_ if n in LSP5}
    return sim.Posture(closed=frozenset(close), pump_delta=dict(pump_delta), opened=opened)


WINDOW_MONTHS = 12      # the product replays the freshest 12 months of London
WINDOW_N = 0            # total incidents in that window (set at startup)


def _baseline(n: int, world: str = "current",
              hours: tuple[int, int] | None = None) -> pl.DataFrame:
    with LOCK:
        key = (n, world, hours)
        if key not in BASELINE:
            posture = (sim.Posture() if world == "current"
                       else _posture([], list(LSP5.keys()), {}))
            BASELINE[key] = sim.simulate(WORLD, posture, latest_months=WINDOW_MONTHS,
                                         sample=n, seed=14, p_unavail=P_UNAVAIL, hours=hours)
        return BASELINE[key]


@app.on_event("startup")
def _load() -> None:
    global WORLD, WINDOW_N
    WORLD = sim.World()
    from datetime import timedelta
    cutoff = WORLD.inc["t0"].max() - timedelta(days=int(WINDOW_MONTHS * 30.44))
    WINDOW_N = int((WORLD.inc["t0"] > cutoff).sum())
    print(f"[api] product window: latest {WINDOW_MONTHS} months = {WINDOW_N:,} incidents "
          f"(through {WORLD.inc['t0'].max()})")

    def _prewarm() -> None:
        _baseline(DEFAULT_SAMPLE, "current")
        _baseline(DEFAULT_SAMPLE, "pre2014")   # 2014 capability stays internal (demo via agent)
    threading.Thread(target=_prewarm, daemon=True).start()


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
    unknown = [x for x in list(s.close) + list(s.pump_delta) if x not in w.sidx and x not in LSP5]
    unknown += [x for x in s.open if x not in LSP5]
    if unknown:
        raise HTTPException(400, f"unknown stations: {unknown}; see GET /stations")
    t0 = time.time()
    hours = tuple(s.hours) if s.hours else None
    base = _baseline(s.sample, s.baseline, hours)
    # closing a 2014 station in pre2014 world = omit it from the opened set
    if s.baseline == "pre2014":
        open_set = [n for n in LSP5 if n not in s.close]
    else:
        open_set = [n for n in s.open if n not in s.close]
    posture = _posture([c for c in s.close if c in w.sidx], open_set, s.pump_delta)
    cf = sim.simulate(w, posture, latest_months=WINDOW_MONTHS, sample=s.sample,
                      seed=14, p_unavail=P_UNAVAIL, hours=hours)
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
        "window": f"latest {WINDOW_MONTHS} months",
        "scale": round(WINDOW_N / s.sample, 3),   # sample -> full-window/yr scaling
        "elapsed_s": round(time.time() - t0, 2),
        "city": {
            "mean_delta_s": round(float(j["d"].mean()), 1),
            "p90_delta_s": round(float(j["d"].quantile(0.9)), 1),
            "pushed_past_6min": int(j.filter((pl.col("sim_s") > 360) & (pl.col("base_s") <= 360)).height),
        },
        "worst_wards": affected.head(12).to_dicts(),
        "ward_deltas": {r["ward"]: round(r["delta_mean_s"], 1) for r in by_ward.iter_rows(named=True)},
    }


class Cover(BaseModel):
    stripped: list[str]                                   # stations with pumps committed
    hours: list[int] | None = Field(default=None, min_length=2, max_length=2)
    donors: int = Field(default=20, ge=4, le=40)          # nearest-N candidate donors
    sample: int = Field(default=DEFAULT_SAMPLE, ge=5_000, le=140_000)


@app.post("/cover")
def cover(c: Cover) -> dict:
    """Real-time repositioning: pumps at `stripped` are committed — which single
    pump move best protects London right now? Sweeps nearest donors, ranks by
    promise-breaks avoided. (~1s per candidate.)"""
    w = WORLD
    unknown = [x for x in c.stripped if x not in w.sidx]
    if unknown:
        raise HTTPException(400, f"unknown stations: {unknown}")
    t0 = time.time()
    hours = tuple(c.hours) if c.hours else None
    base = _baseline(c.sample, "current", hours)
    base_pushed = 0  # baseline has none pushed vs itself by definition

    # the bleeding state: stripped stations' pumps all committed
    strip_delta = {s: -int(w.pumps[w.sidx[s]]) for s in c.stripped}
    stripped_run = sim.simulate(w, sim.Posture(pump_delta=strip_delta),
                                latest_months=WINDOW_MONTHS, sample=c.sample,
                                seed=14, p_unavail=P_UNAVAIL, hours=hours)
    s_pushed = int(((stripped_run["sim_s"] > 360) & (base["sim_s"] <= 360)).sum())

    # candidate donors: nearest N stations to the (first) stripped house, that have pumps
    tgt = c.stripped[0]
    ti = w.sidx[tgt]
    d2 = (w.SE - w.SE[ti]) ** 2 + (w.SN - w.SN[ti]) ** 2
    order = [w.names[i] for i in d2.argsort() if w.names[i] not in c.stripped][:c.donors]

    moves = []
    for donor in order:
        delta = dict(strip_delta)
        delta[donor] = delta.get(donor, 0) - 1
        delta[tgt] = delta.get(tgt, 0) + 1          # donor pump relocates into the empty house
        run = sim.simulate(w, sim.Posture(pump_delta=delta),
                           latest_months=WINDOW_MONTHS, sample=c.sample,
                           seed=14, p_unavail=P_UNAVAIL, hours=hours)
        m_pushed = int(((run["sim_s"] > 360) & (base["sim_s"] <= 360)).sum())
        moves.append({"from": donor, "to": tgt,
                      "pushed_with_move": m_pushed,
                      "promise_breaks_avoided": s_pushed - m_pushed})
    moves.sort(key=lambda m: -m["promise_breaks_avoided"])

    worst = (stripped_run.with_columns(d=stripped_run["sim_s"] - base["sim_s"])
             .group_by("ward").agg(d=pl.col("d").mean(), n=pl.len())
             .filter(pl.col("n") >= 10).sort("d", descending=True).head(5))
    return {
        "stripped": c.stripped,
        "hours": c.hours,
        "elapsed_s": round(time.time() - t0, 1),
        "scale": round(WINDOW_N / c.sample, 3),
        "uncovered": {"pushed_past_6min": s_pushed,
                      "worst_wards": [{"ward": r["ward"], "added_s": round(r["d"], 1)}
                                       for r in worst.iter_rows(named=True)]},
        "best_move": moves[0] if moves else None,
        "moves": moves[:8],
        "note": "replayed posture math on the latest 12 months; plug in live CAD and this runs for real",
    }


# ---------------------------- Ghost Operator --------------------------------

@app.get("/ui/commands")
def ui_commands(since: int = 0) -> dict:
    return {"next": len(UI_COMMANDS), "commands": UI_COMMANDS[max(0, since):]}


ALLOWED_CMDS = {"narrate", "reset", "close_stations", "open_2014", "run_scenario",
                "compare_postures", "focus_ward", "focus_station", "show_finding",
                "show_validation", "show_metric", "audio"}
STOP_FLAG = threading.Event()


@app.post("/ui/emit")
def ui_emit(cmd: dict) -> dict:
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


@app.post("/ask/stop")
def ask_stop() -> dict:
    """STOP button: cancel the in-flight choreography at the next agent hop."""
    STOP_FLAG.set()
    return {"ok": True}


class Ask(BaseModel):
    text: str = Field(max_length=2000)
    speak: bool = True


@app.post("/ask")
def ask(a: Ask) -> dict:
    """The command bar: text in -> agent reasons -> choreography out (via /ui/emit)."""
    if not ASK_BUSY.acquire(blocking=False):
        raise HTTPException(429, "agent is mid-choreography; wait for it to finish")
    try:
        import agent as brigade
        STOP_FLAG.clear()
        brigade.SHOULD_STOP = STOP_FLAG.is_set
        brigade.SPEAK_NARRATION = a.speak
        del ASK_HISTORY[:-8]   # keep short memory; old choreographies must not contaminate new asks
        answer = brigade.agent_turn(a.text, ASK_HISTORY)
        # ensure the final answer always lands on screen even if the model forgot ui.narrate
        if not any(c.get("type") == "narrate" and c.get("final") for c in UI_COMMANDS[-8:]):
            ui_emit({"type": "narrate", "text": answer, "final": True})
        return {"answer": answer}
    finally:
        ASK_BUSY.release()


@app.get("/session/tail")
def session_tail(n: int = 30) -> dict:
    """Duty log: tail the newest session JSONL (patrol or ask process)."""
    files = sorted(Path("logs").glob("session_*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not files:
        return {"file": None, "lines": []}
    lines = files[-1].read_text().strip().splitlines()[-n:]
    return {"file": files[-1].name, "lines": [json.loads(x) for x in lines]}


@app.get("/wards_geo")
def wards_geo() -> dict:
    return json.loads((ROOT / "data/london_wards.geojson").read_text())


@app.get("/stations2014")
def stations2014() -> list[dict]:
    E = [v[0] for v in LSP5.values()]
    N = [v[1] for v in LSP5.values()]
    lat, lon = _to_wgs(E, N)
    return [{"name": n, "lat": float(lat[i]), "lon": float(lon[i])}
            for i, n in enumerate(LSP5.keys())]


@app.get("/presets")
def presets() -> dict:
    naive = ["Clerkenwell", "Westminster", "Bow", "Dockhead", "Silvertown",
             "Leyton", "Belsize", "Downham", "Deptford", "Stratford"]
    optimal = ["Dowgate", "Millwall", "Dockhead", "New Cross", "Chelsea",
               "Shadwell", "Islington", "Lewisham", "Stratford", "East Ham"]
    return {
        "biggin_hill": {"label": "Close Biggin Hill (the −0.18 law)", "close": ["Biggin Hill"], "baseline": "current"},
        "whitechapel": {"label": "Close Whitechapel (7× busier, nearly free)", "close": ["Whitechapel"], "baseline": "current"},
        "lsp5_actual": {"label": "2014: the politicians' ten", "close": list(LSP5.keys()), "baseline": "pre2014"},
        "lsp5_naive": {"label": "2014: the naive ten", "close": naive, "baseline": "pre2014"},
        "lsp5_optimal": {"label": "2014: the optimizer's ten", "close": optimal, "baseline": "pre2014"},
    }


@app.get("/findings")
def findings() -> list[dict]:
    # current-network findings only (the 2014 evidence lives in the demo, not app chrome);
    # clicking a card ASKS THE AGENT — nothing canned
    return [
        {"id": "law", "number": "−0.18", "title": "Call volume anti-predicts closure damage",
         "line": "Biggin Hill: quietest station, near-critical. Whitechapel: 7× busier, nearly free.",
         "ask": "Show me what happens if Biggin Hill closes, then contrast it with closing Whitechapel."},
        {"id": "night", "number": "+47s", "title": "Night turnout is station-specific",
         "line": "Dagenham crews: 80s by day, 127s at night. The promise has a time-of-day geography.",
         "ask": "Tell me about the night turnout problem and which stations are worst."},
        {"id": "validated", "number": "±5%", "title": "Validated against blind 2025",
         "line": "Calibrated on 2024, tested on 130k unseen incidents: mean +2.4%, p90 −3.7%.",
         "ask": "How do I know your simulations are trustworthy?"},
    ]


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
