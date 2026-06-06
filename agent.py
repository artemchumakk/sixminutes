"""Brigade Watch — the SIXMINUTES Nemotron agent (ElevenLabs bounty).

Modes:
  python agent.py --ask "close Soho - who gets hurt?"   # one-shot (testing)
  python agent.py --chat                                # text REPL
  python agent.py --voice                               # push-to-talk: EL STT -> agent -> EL TTS
  python agent.py --patrol [--speak]                    # persistent autonomous session (>=1h11m)

Memory architecture (judge-recall-proof):
  logs/memory.db   events(minute, wall_ts, sim_date, kind, location, severity, narrative)
                   -> exact lookup for "what happened at minute 14"
  logs/session_<ts>.jsonl   every utterance + tool call (bounty session log)
  logs/audio/*.mp3          every TTS output (ElevenLabs proof artifacts)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).parent
LOGS = ROOT / "logs"
AUDIO = LOGS / "audio"
LOGS.mkdir(exist_ok=True)
AUDIO.mkdir(exist_ok=True)

LLM_BASE = os.environ.get("SIXMINUTES_LLM_BASE_URL") or os.environ.get(
    "CITYWARDEN_LLM_BASE_URL", "https://api.studio.nebius.ai/v1")
LLM_KEY = os.environ.get("SIXMINUTES_LLM_API_KEY") or os.environ.get("CITYWARDEN_LLM_API_KEY", "")
LLM_MODEL = os.environ.get("SIXMINUTES_LLM_MODEL") or os.environ.get(
    "CITYWARDEN_LLM_MODEL", "nvidia/nemotron-3-super-120b-a12b")
EL_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
EL_VOICE = os.environ.get("ELEVENLABS_VOICE", "21m00Tcm4TlvDq8ikWAM")
API = os.environ.get("SIXMINUTES_API", "http://localhost:8095")

SESSION_START = time.time()
SESSION_LOG = LOGS / f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"


def minute_now() -> int:
    return int((time.time() - SESSION_START) // 60)


def jlog(kind: str, **kw) -> None:
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "minute": minute_now(), "kind": kind, **kw}
    with SESSION_LOG.open("a") as f:
        f.write(json.dumps(rec, default=str) + "\n")


# ---------------------------------------------------------------- memory ----
def db() -> sqlite3.Connection:
    c = sqlite3.connect(LOGS / "memory.db")
    c.execute("""CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY, minute INT, wall_ts TEXT, sim_date TEXT,
        kind TEXT, location TEXT, severity TEXT, narrative TEXT)""")
    return c


def remember_once(kind: str, location: str, severity: str, narrative: str, sim_date: str = "") -> None:
    """Idempotent remember — supervisor restarts must not duplicate seeds."""
    c = db()
    n = c.execute("SELECT COUNT(*) FROM events WHERE kind=? AND narrative=?",
                  (kind, narrative)).fetchone()[0]
    c.close()
    if n == 0:
        remember(kind, location, severity, narrative, sim_date)


def remember(kind: str, location: str, severity: str, narrative: str, sim_date: str = "") -> None:
    c = db()
    c.execute("INSERT INTO events(minute, wall_ts, sim_date, kind, location, severity, narrative) VALUES(?,?,?,?,?,?,?)",
              (minute_now(), datetime.now(timezone.utc).isoformat(), sim_date, kind, location, severity, narrative))
    c.commit(); c.close()
    jlog("event", event_kind=kind, location=location, severity=severity, narrative=narrative, sim_date=sim_date)


def recall(query: str = "", minute: int | None = None, limit: int = 12) -> list[dict]:
    c = db()
    if minute is not None:
        rows = c.execute(
            "SELECT minute, sim_date, kind, location, severity, narrative FROM events "
            "WHERE minute BETWEEN ? AND ? ORDER BY id", (minute - 2, minute + 2)).fetchall()
    else:
        like = f"%{query}%"
        rows = c.execute(
            "SELECT minute, sim_date, kind, location, severity, narrative FROM events "
            "WHERE narrative LIKE ? OR location LIKE ? OR kind LIKE ? ORDER BY id DESC LIMIT ?",
            (like, like, like, limit)).fetchall()
    c.close()
    return [{"minute": r[0], "sim_date": r[1], "kind": r[2], "location": r[3],
             "severity": r[4], "narrative": r[5]} for r in rows]


# ----------------------------------------------------------------- tools ----
def tool_run_scenario(close: list[str] | None = None, pump_delta: dict | None = None,
                      baseline: str = "current", open: list[str] | None = None,
                      hours: list[int] | None = None) -> dict:
    r = httpx.post(f"{API}/scenario",
                   json={"close": close or [], "pump_delta": pump_delta or {},
                         "baseline": baseline, "open": open or [], "hours": hours},
                   timeout=180)
    r.raise_for_status()
    out = r.json()
    out["worst_wards"] = out["worst_wards"][:6]
    out.pop("ward_deltas", None)  # too big for context; dashboard reads it directly
    return out


def tool_sql(query: str) -> list[dict]:
    import duckdb
    if re.search(r"\b(insert|update|delete|drop|create|attach|copy)\b", query, re.I):
        return [{"error": "read-only"}]
    con = duckdb.connect()
    con.execute(f"CREATE VIEW incidents AS SELECT * FROM '{ROOT}/data/incidents.parquet'")
    con.execute(f"CREATE VIEW mobilisations AS SELECT * FROM '{ROOT}/data/mobilisations.parquet'")
    con.execute(f"CREATE VIEW stations AS SELECT * FROM '{ROOT}/data/stations.parquet'")
    con.execute(f"CREATE VIEW closure_damage AS SELECT * FROM '{ROOT}/data/closure_damage.parquet'")
    try:
        rows = con.execute(query).fetchmany(40)
        cols = [d[0] for d in con.description]
        return [dict(zip(cols, r)) for r in rows]
    except Exception as e:
        return [{"error": str(e)[:300]}]
    finally:
        con.close()


def tool_recall(query: str = "", minute: int | None = None) -> list[dict]:
    return recall(query, minute)


def tool_recommend_cover(stripped: list[str], hours: list[int] | None = None) -> dict:
    """Real-time repositioning: which pump move covers the hole best."""
    r = httpx.post(f"{API}/cover", json={"stripped": stripped, "hours": hours}, timeout=300)
    r.raise_for_status()
    out = r.json()
    out["moves"] = out["moves"][:4]
    return out


SPEAK_NARRATION = True
SHOULD_STOP = None  # optional callable set by the API: True = user hit STOP mid-choreography
UI_VERBS = {"narrate", "reset", "close_stations", "open_2014", "run_scenario",
            "compare_postures", "focus_ward", "focus_station", "show_finding",
            "show_validation", "show_metric", "move_unit"}


def tool_ui(action: str = "", steps: list[dict] | None = None, **kwargs) -> dict:
    """Ghost Operator: emit choreography verb(s) to the dashboard command bus.
    Either a single action, or steps=[{action:..., ...}, ...] batched in one hop."""
    if steps:
        results = [tool_ui(**{k: v for k, v in s.items() if k != "action"}, action=s.get("action", ""))
                   for s in steps]
        bad = [r for r in results if "error" in r]
        return {"ok": True, "executed": len(results) - len(bad), "errors": bad[:2]}
    if action not in UI_VERBS:
        return {"error": f"unknown ui action '{action}'; allowed: {sorted(UI_VERBS)}"}
    cmd = {"type": action, **kwargs}
    httpx.post(f"{API}/ui/emit", json=cmd, timeout=10)
    if action == "narrate" and SPEAK_NARRATION and EL_KEY:
        def _speak(text: str) -> None:
            try:
                out = tts(text, play=False)
                if out:
                    httpx.post(f"{API}/ui/emit", json={"type": "audio", "url": f"/audio/{out.name}"}, timeout=10)
            except Exception as e:
                jlog("error", where="ui_tts", error=str(e)[:200])
        import threading
        threading.Thread(target=_speak, args=(kwargs.get("text", ""),), daemon=True).start()
    return {"ok": True}


TOOLS_DOC = """You can call tools by replying ONLY a JSON object (no prose around it):
  {"tool":"run_scenario","args":{"close":["<StationName>"],"pump_delta":{},"baseline":"current"}}   -> simulate closing/changing stations (validated digital twin, latest-12-months replay). baseline "pre2014" = the reconstructed 112-station pre-2014 London (use for any 2014 question; closing 2014 station names is allowed there: Clerkenwell, Westminster, Southwark, Belsize, Kingsland, Knightsbridge, Downham, Woolwich, Bow, Silvertown)
  {"tool":"sql","args":{"query":"SELECT ..."}}                        -> read-only SQL over: incidents(IncidentNumber, DateOfCall, CalYear, HourOfCall, IncidentGroup, StopCodeDescription, SpecialServiceType, PropertyCategory, PropertyType, IncGeo_BoroughName, IncGeo_WardName, UPRN, Postcode_district, IncidentStationGround, FirstPumpArriving_AttendanceTime, NumStationsWithPumpsAttending, NumPumpsAttending, PumpMinutesRounded, "Notional Cost (£)", NumCalls, ...), mobilisations(TurnoutTimeSeconds, TravelTimeSeconds, AttendanceTimeSeconds, DeployedFromStation_Name, DeployedFromLocation, DelayCode_Description, ...), stations(DeployedFromStation_Name, E, N, turnout_med), closure_damage(station-level damage if closed). Quote "Notional Cost (£)" exactly like that. UPRN is redacted for dwellings (non-residential only). DeployedFromLocation != 'Home Station' = real standby/cover moves.
  {"tool":"recall","args":{"query":"Camden"}} or {"args":{"minute":14}} -> your session memory (events you observed earlier)
  {"tool":"recommend_cover","args":{"stripped":["<StationName>"],"hours":[22,6]}} -> REAL-TIME REPOSITIONING (NOTE: cover moves target the FIRST stripped station only - for multiple stripped stations, call once per target): pumps at these stations just committed to a major incident; sweeps ~20 candidate pump moves through the twin and returns the ranked best cover moves (promise_breaks_avoided), the uncovered damage map, and worst wards. Use for any "pumps committed / cover move / standby / where should pumps sit" question. Takes ~30s - tell the user you are sweeping moves first via ui.narrate.
  run_scenario and recommend_cover both accept "hours":[h0,h1] - the night map [22,6] vs the day map [10,18]. Use hours whenever the user says tonight/at night/2am/rush hour.
  {"tool":"ui","args":{"action":"...", ...}} -> OPERATE THE WALL DASHBOARD (the Ghost Operator). Actions:
     {"action":"narrate","text":"one or two short sentences"}  caption + spoken aloud
     {"action":"reset"}  clear the board
     {"action":"close_stations","names":["<StationName>"]}  stations turn red on the map
     {"action":"open_2014"}  enter pre-2014 London: the ten 2014-closed stations appear as ghosts
     {"action":"run_scenario","baseline":"current"|"pre2014"}  visually run the current board selection
     {"action":"compare_postures","presets":["lsp5_actual","lsp5_naive","lsp5_optimal"]}  the 2014 three-way showdown
     {"action":"focus_ward","name":"<WARD NAME>"} | {"action":"focus_station","name":"<StationName>"}  fly the camera
     {"action":"move_unit","from":"<DonorStation>","to":"<TargetStation>"}  animate a pump relocating (arc + traveling dot) - ALWAYS emit this for the best cover move
     {"action":"show_finding","id":"law"|"2014"|"betterten"|"night"}  glow a findings card
     {"action":"show_validation"} | {"action":"show_metric","key":"pushed_past_6min"}
To answer the user directly, reply: {"say":"<your answer>"}

BATCHING: you can send a whole choreography in ONE call: {"tool":"ui","args":{"steps":[{"action":"narrate","text":"..."},{"action":"reset"},{"action":"close_stations","names":[...]},{"action":"run_scenario"}]}} - PREFER batches of 3-5 verbs over one-verb hops.
CHOREOGRAPHY CONTRACT - when the user says "show me", "demonstrate", "what happens if", or asks anything visual, you MUST hit ALL six beats in order:
 1) ui.narrate a one-line plan
 2) ui.reset, then ui.close_stations and/or ui.open_2014 — REQUIRED: the wall runs ONLY what is on the board; ui.run_scenario with an empty board shows nothing
 3) the run_scenario DATA tool for the numbers (same posture as the board)
 4) ui.run_scenario to animate it
 5) ui.focus_ward with the worst ward name from your step-3 numbers
 6) ui.narrate the verdict WITH numbers, then {"say":...} summarizing.
COVER-MOVE CHOREOGRAPHY (for "pumps committed / cover move / standby" questions):
 1) ui batch: narrate("Sweeping cover moves for <stripped>...") + reset + close_stations(<stripped only>)
 2) recommend_cover data tool  3) ui batch: move_unit(from=best donor, to=target) + narrate the verdict (best move, breaches avoided, runner-ups), then {"say":...}.
CRITICAL: choreograph ONLY stations the user actually named. The names in this prompt are placeholders, never defaults.
For 2014 questions (DEMO ONLY - not part of normal app flow): ui.open_2014, then ui.close_stations with the politicians' ten, then ui.run_scenario (baseline pre2014), then ui.compare_postures. ALWAYS cite the live numbers from your own run_scenario results (multiply pushed_past_6min by the response's scale for /yr); canonical reference magnitudes: politicians ~4,000 vs naive ~5,300 vs optimizer ~2,800 broken promises/yr, optimizer overlap 0/10 with 2014.
Rules: lead with numbers; control-room brevity; seconds matter. Fire tier is validated (sim within ±5% of held-out 2025); police/ambulance layers are Tier B (demand + transferred physics) - say so if asked. Never invent events not in recall results.
BOARD CONTEXT: user messages may start with [BOARD CONTEXT: inspected_station=X; closed_on_board=[...]; hour_band=[h0,h1]].
When the user says "my station", "my ground", "my pumps", they mean inspected_station - use it directly, do NOT ask which station. Respect closed_on_board as the current posture and hour_band as the time lens unless the user overrides.
DOCTRINE (non-negotiable):
- NEVER predict individual future incidents. "Where will the next fire be?" -> explain you model RATES (statistically busy areas), not events; offer the risk-map framing instead.
- You are NOT live: the data ends April 2026 and you replay history. Any "right now / last hour" question -> say so explicitly before giving historical patterns.
- SQL ward/borough stats: always GROUP BY UPPER(name) (mixed case across years) and HAVING COUNT(*) >= 50 (small-n wards produce artifacts).
- pump_delta +N on an OPEN station shows little gain by design (the twin models station-level availability; extra pumps matter mainly under queueing) - explain this honestly when asked about adding pumps.
- Cover moves across the Thames may be optimistic: travel physics is distance-based and does not know bridges. Flag river-crossing recommendations.
- For 2014-mistake or any A-vs-B posture comparison questions, ui.compare_postures is REQUIRED, not optional."""

SYSTEM = ("You are Brigade Watch, the duty intelligence officer for SIXMINUTES - a validated "
          "digital twin of London's emergency response (built on 2.3M open records). "
          "Today is June 2026. You watch the network, remember everything, and run counterfactuals "
          "on request.\n" + TOOLS_DOC)


# ------------------------------------------------------------------ llm -----
def llm(messages: list[dict], max_tokens: int = 4000) -> str:
    r = httpx.post(f"{LLM_BASE}/chat/completions",
                   headers={"Authorization": f"Bearer {LLM_KEY}"},
                   json={"model": LLM_MODEL, "messages": messages,
                         "temperature": 0.2, "max_tokens": max_tokens},
                   timeout=180)
    r.raise_for_status()
    msg = r.json()["choices"][0]["message"]
    # Nemotron reasoning models may park output in reasoning_content with empty content
    return (msg.get("content") or "").strip() or (msg.get("reasoning_content") or "").strip()


def extract_json(text: str) -> dict | None:
    # walk every '{' and take the FIRST blob that parses (models mix prose + JSON)
    dec = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, _ = dec.raw_decode(text[i:])
            if isinstance(obj, dict) and ("tool" in obj or "say" in obj):
                return obj
        except json.JSONDecodeError:
            continue
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    blob = m.group(0)
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        pass
    # salvage: models often put literal newlines inside the "say" string
    m2 = re.search(r'"say"\s*:\s*"(.*)"\s*\}\s*$', blob, re.S)
    if m2:
        return {"say": m2.group(1).replace('\\"', '"').replace("\\n", "\n")}
    m3 = re.search(r'"tool"\s*:\s*"(\w+)"', blob)
    if m3:
        try:
            args = json.loads(re.search(r'"args"\s*:\s*(\{.*?\})', blob, re.S).group(1))
        except Exception:
            args = {}
        return {"tool": m3.group(1), "args": args}
    return None


def agent_turn(user_text: str, history: list[dict]) -> str:
    history.append({"role": "user", "content": user_text})
    jlog("user", text=user_text)
    msgs = [{"role": "system", "content": SYSTEM}] + history[-16:]
    bad = 0
    last_narration = ""
    for _hop in range(24):  # generous: choreographies can be long even when batched
        if SHOULD_STOP and SHOULD_STOP():
            stopped = last_narration or "Stopped."
            history.append({"role": "assistant", "content": stopped + " (run cancelled by user)"})
            jlog("agent", text="(stopped by user)", note="user_stop")
            return stopped  # history closed: a stopped ask must never hijack the next one
        raw = llm(msgs)
        obj = extract_json(raw) if raw else None
        if obj is None:
            bad += 1
            if bad <= 3:  # reasoning leak / empty: re-demand the protocol, never speak thoughts
                msgs.append({"role": "user", "content":
                             'Protocol violation: respond ONLY with one JSON object now - either {"tool":...,"args":{...}} or {"say":"..."}.'})
                continue
            obj = {"say": (raw or "I lost the thread - ask me again.").strip()[:400]}
        if "tool" in obj:
            name, args = obj["tool"], obj.get("args", {})
            if name == "ui":
                texts = [s.get("text", "") for s in args.get("steps", []) if s.get("action") == "narrate"]
                if args.get("action") == "narrate":
                    texts.append(args.get("text", ""))
                if texts:
                    last_narration = texts[-1]
            jlog("tool_call", tool=name, args=args)
            try:
                fn = {"run_scenario": tool_run_scenario, "sql": tool_sql,
                      "recall": tool_recall, "ui": tool_ui,
                      "recommend_cover": tool_recommend_cover}[name]
                result = fn(**args)
            except Exception as e:
                result = {"error": str(e)[:300]}
            jlog("tool_result", tool=name, result_preview=str(result)[:400])
            msgs.append({"role": "assistant", "content": raw})
            msgs.append({"role": "user", "content": f"TOOL RESULT {name}: {json.dumps(result, default=str)[:4000]}\nNow answer with another tool call or {{\"say\":...}}"})
            continue
        answer = obj.get("say", raw.strip())
        history.append({"role": "assistant", "content": answer})
        jlog("agent", text=answer)
        return answer
    # budget exhausted mid-choreography: the wall already played; close with the last narration
    fallback = last_narration or "Choreography ran long - the board shows where I got to. Ask me to continue."
    history.append({"role": "assistant", "content": fallback})
    jlog("agent", text=fallback, note="hop_budget_exhausted")
    return fallback


# ---------------------------------------------------------------- voice -----
def tts(text: str, play: bool = True) -> Path | None:
    if not EL_KEY:
        print("(no ELEVENLABS_API_KEY - text only)")
        return None
    r = httpx.post(f"https://api.elevenlabs.io/v1/text-to-speech/{EL_VOICE}",
                   headers={"xi-api-key": EL_KEY},
                   json={"text": text[:600], "model_id": "eleven_turbo_v2_5"}, timeout=60)
    r.raise_for_status()
    out = AUDIO / f"tts_{int(time.time())}.mp3"
    out.write_bytes(r.content)
    jlog("tts", file=str(out), chars=len(text))
    if play and sys.platform == "darwin":
        subprocess.Popen(["afplay", str(out)])
    elif play:
        subprocess.Popen(["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(out)])
    return out


def stt(seconds: int = 6) -> str:
    wav = "/tmp/sixminutes_voice.wav"
    print(f"recording {seconds}s ...")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "quiet", "-f", "avfoundation",
                    "-i", ":0", "-t", str(seconds), wav], check=True)
    with open(wav, "rb") as f:
        r = httpx.post("https://api.elevenlabs.io/v1/speech-to-text",
                       headers={"xi-api-key": EL_KEY},
                       data={"model_id": "scribe_v1"},
                       files={"file": ("voice.wav", f, "audio/wav")}, timeout=60)
    r.raise_for_status()
    text = r.json().get("text", "")
    jlog("stt", text=text)
    return text


# --------------------------------------------------------------- patrol -----
def patrol(speak: bool, accel: int = 60) -> None:
    """Autonomous overnight session: replay 2025 through the twin, observe, remember."""
    import polars as pl
    from datetime import timedelta
    all_inc = pl.read_parquet(ROOT / "data/incidents.parquet")
    cutoff = all_inc["DateOfCall"].max() - timedelta(days=365)
    inc = all_inc.filter(pl.col("DateOfCall") > cutoff).sort("DateOfCall", "HourOfCall")
    days = inc["DateOfCall"].unique().sort().to_list()
    remember("session", "London", "info",
             f"Patrol started. Watching the latest 12 months of London ({days[0]} -> {days[-1]}) "
             f"at {accel}x: {inc.height:,} incidents across {len(days)} days queued.")
    # seed today's validated findings so voice recall can answer questions about them
    seed = remember_once
    for loc, narr in [
        ("Biggin Hill", "FINDING: Biggin Hill is London's quietest station (385 calls/yr) yet closing it adds +215s locally and pushes 9.1% of its calls past the 6-minute target; call volume correlates NEGATIVELY (-0.18) with closure damage."),
        ("Whitechapel", "FINDING: Whitechapel, 7x busier than Biggin Hill, is among the SAFEST closures (+51s local) due to overlapping central cover - the spreadsheet method ranks closures backwards."),
        ("2014 closures", "FINDING: The 2014 LSP5 closures (Clerkenwell, Westminster, Southwark, Belsize, Kingsland, Knightsbridge, Downham, Woolwich, Bow, Silvertown) measurably cost +63s in their former grounds; the twin, never shown pre-2021 data, predicts -52s recovery if reopened - independent convergence."),
        ("Dagenham", "FINDING: Night turnout penalty is station-specific: Dagenham jumps 80s (day) to 127s (night), +47s; city-wide median turnout is +38s slower at night."),
        ("London", "FINDING: Simulator validated on held-out 2025: mean +2.4%, p90 -3.7%; replays a year of London (130k incidents) in ~3s at ~40k incidents/sec."),
        ("AFA buildings", "FINDING: Non-residential false alarms cost GBP 5.0M/yr in pump time; 39 buildings trigger at least monthly; worst is an NW1 hospital with 61 false-alarm responses in 12 months (GBP 25,685)."),
        ("Suburbs", "FINDING: Counter-intuitive - 10+ storey towers get FASTER first pumps (mean 307s) than single houses (352s, p90 512s): density beats height; the 6-minute promise breaks in outer low-rise London, not the towers."),
        ("Cover moves", "FINDING: LFB made 7,288 real non-home-station deployments in the latest 12 months (3.5% of mobilisations) - the cover-move recommender formalizes this existing daily practice with simulation math."),
        ("Ambulance transfer", "FINDING (ambulance tier): fire-learned travel physics applied to 73 LAS stations + real Ward-Atlas demand reproduces real C1 mean within -11.3% free-flow; adding a finite-fleet availability model (~240 ambulances, hospital handover queueing) lands at 428.8s vs real 429.8s - ONE SECOND off. The C1 tail is hospital handover delay, mechanistically shown."),
        ("Police tier", "FINDING (police tier): spearman(call volume, closure damage) = +0.37 for MPS bases; spreadsheet's 10 closures vs model's 10 = 0/10 overlap with 1.6x the damage. Biggin Hill is the most damaging closure in BOTH fire (+215s) and police (+374s) - the same corner of London is the safety net's double single-point-of-failure."),
    ]:
        seed("analysis", loc, "info", narr)
    if speak:
        tts("Brigade Watch online. Beginning overnight patrol of the London replay.", play=False)
    hb = 0
    for day in days:
        d = inc.filter(pl.col("DateOfCall") == day)
        sim_date = str(day)
        notables = d.filter(
            (pl.col("NumPumpsAttending") >= 4)
            | (pl.col("FirstPumpArriving_AttendanceTime") > 600))
        # narrate up to 3 notables per sim-day
        for r in notables.head(3).iter_rows(named=True):
            sev = "P1" if (r["NumPumpsAttending"] or 0) >= 6 else "P2"
            narrative = (f"{sim_date} {r['HourOfCall']:02d}:00 {r['IncGeo_WardName']}, "
                         f"{r['IncGeo_BoroughName']}: {r['StopCodeDescription']} "
                         f"({r['IncidentGroup']}), {r['NumPumpsAttending'] or 1} pumps, "
                         f"first attendance {r['FirstPumpArriving_AttendanceTime'] or '?'}s.")
            remember("notable", f"{r['IncGeo_WardName']}, {r['IncGeo_BoroughName']}", sev, narrative, sim_date)
            if speak and hb % 5 == 0:
                tts(narrative, play=False)
            hb += 1
        # AGENTIC: investigate the day's biggest event (every ~8 sim-days, token-budgeted)
        if days.index(day) % 8 == 3 and notables.height:
            big = notables.sort("NumPumpsAttending", descending=True).head(1).to_dicts()[0]
            try:
                hist: list[dict] = []
                assessment = agent_turn(
                    f"PATROL INVESTIGATION (max 3 tool hops, no ui): {big['IncGeo_WardName']}, "
                    f"{big['IncGeo_BoroughName']} on {sim_date}: {big['StopCodeDescription']}, "
                    f"{big['NumPumpsAttending']} pumps, first attendance {big['FirstPumpArriving_AttendanceTime']}s. "
                    f"Use sql to pull this ward's 2025 incident count and mean attendance, judge whether "
                    f"this response was normal for the ward, and end with a 2-sentence assessment.", hist)
                remember("investigation", f"{big['IncGeo_WardName']}, {big['IncGeo_BoroughName']}",
                         "info", assessment[:600], sim_date)
            except Exception as e:
                jlog("error", where="investigate", error=str(e)[:200])

        # AGENTIC: cluster -> autonomous counterfactual experiment on the twin
        wards_today = notables["IncGeo_WardName"].to_list()
        clustered = {x for x in wards_today if wards_today.count(x) >= 2}
        if clustered and days.index(day) % 4 == 1:
            ward = sorted(clustered)[0]
            ground = notables.filter(pl.col("IncGeo_WardName") == ward)["IncidentStationGround"].to_list()
            station = (ground[0] or "").title() if ground else ""
            try:
                r = httpx.post(f"{API}/scenario",
                               json={"pump_delta": {station: 1}, "close": [], "open": []},
                               timeout=180).json()
                gain = -float(r.get("ward_deltas", {}).get(ward, 0.0))
                rec = (f"AUTONOMOUS EXPERIMENT: cluster of notables in {ward} on {sim_date}. "
                       f"Ran the twin unprompted: one extra pump at {station} changes this ward's mean "
                       f"response by {gain:+.0f}s. "
                       + (f"RECOMMEND standby reinforcement at {station}." if gain > 10
                          else "Posture adequate; no move recommended."))
                remember("experiment", f"{ward}", "P3" if gain > 10 else "info", rec, sim_date)
                if speak:
                    tts(rec, play=False)
            except Exception as e:
                jlog("error", where="experiment", error=str(e)[:200])

        # chapter summary via Nemotron (every ~8 sim-days ~ 12 wall-min at 60x)
        if days.index(day) % 8 == 7:
            recent = recall("", minute=None, limit=10)
            try:
                summary = llm([{"role": "system", "content": "Summarize these control-room events in 2 sentences, control-room style."},
                               {"role": "user", "content": json.dumps(recent)}], max_tokens=600)
                remember("chapter", "London", "info", summary[:500], sim_date)
                if speak:
                    tts(summary, play=False)
            except Exception as e:
                jlog("error", where="chapter", error=str(e)[:200])
        remember("heartbeat", "London", "info",
                 f"Day {sim_date} replay complete: {d.height} incidents, {notables.height} notable.", sim_date)
        time.sleep(max(1.0, 86400 / accel / 20))  # pacing: ~1 sim-day per ~72s wall
    remember("session", "London", "info", "Patrol replay exhausted - looping is allowed.")


# ----------------------------------------------------------------- main -----
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ask", type=str)
    ap.add_argument("--chat", action="store_true")
    ap.add_argument("--voice", action="store_true")
    ap.add_argument("--patrol", action="store_true")
    ap.add_argument("--speak", action="store_true")
    ap.add_argument("--briefing", action="store_true",
                    help="compose the shift handover from the registry (Sunday 08:00)")
    a = ap.parse_args()
    if a.briefing:
        rows = recall("", minute=None, limit=60)
        brief = llm([{"role": "system", "content":
                      "You are Brigade Watch writing your overnight shift handover for the duty officer. "
                      "3 short paragraphs: (1) the night's notable incidents, (2) your investigations and "
                      "autonomous experiments with their numbers, (3) recommendations. Control-room style."},
                     {"role": "user", "content": json.dumps(rows, default=str)}], max_tokens=2000)
        remember("briefing", "London", "info", brief[:1500])
        print(brief)
        if a.speak:
            tts(brief[:600], play=False)
        return
    history: list[dict] = []
    if a.ask:
        print(agent_turn(a.ask, history))
    elif a.chat:
        while True:
            try:
                q = input("\nyou> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if q in {"exit", "quit", ""}:
                break
            print("watch>", agent_turn(q, history))
    elif a.voice:
        print("push-to-talk: ENTER to record 6s, ctrl-c to quit")
        while True:
            try:
                input()
            except (EOFError, KeyboardInterrupt):
                break
            q = stt()
            print("you(voice)>", q)
            ans = agent_turn(q, history)
            print("watch>", ans)
            tts(ans)
    elif a.patrol:
        patrol(speak=a.speak)


if __name__ == "__main__":
    main()
