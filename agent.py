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
def tool_run_scenario(close: list[str] | None = None, pump_delta: dict | None = None) -> dict:
    r = httpx.post(f"{API}/scenario", json={"close": close or [], "pump_delta": pump_delta or {}},
                   timeout=120)
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


TOOLS_DOC = """You can call tools by replying ONLY a JSON object (no prose around it):
  {"tool":"run_scenario","args":{"close":["Soho"],"pump_delta":{}}}   -> simulate closing/changing stations (validated digital twin, 2025 replay)
  {"tool":"sql","args":{"query":"SELECT ..."}}                        -> read-only SQL over: incidents(IncidentNumber, DateOfCall, CalYear, HourOfCall, IncidentGroup, StopCodeDescription, PropertyCategory, IncGeo_BoroughName, IncGeo_WardName, FirstPumpArriving_AttendanceTime, NumPumpsAttending, ...), mobilisations(TurnoutTimeSeconds, TravelTimeSeconds, AttendanceTimeSeconds, DeployedFromStation_Name, DelayCode_Description, ...), stations(DeployedFromStation_Name, E, N, turnout_med), closure_damage(station-level damage if closed)
  {"tool":"recall","args":{"query":"Camden"}} or {"args":{"minute":14}} -> your session memory (events you observed earlier)
To answer the user directly, reply: {"say":"<your answer>"}
Rules: lead with numbers; control-room brevity; seconds matter. Fire tier is validated (sim within ±5% of held-out 2025); police/ambulance layers are Tier B (demand + transferred physics) - say so if asked. Never invent events not in recall results."""

SYSTEM = ("You are Brigade Watch, the duty intelligence officer for SIXMINUTES - a validated "
          "digital twin of London's emergency response (built on 2.3M open records). "
          "Today is June 2026. You watch the network, remember everything, and run counterfactuals "
          "on request.\n" + TOOLS_DOC)


# ------------------------------------------------------------------ llm -----
def llm(messages: list[dict], max_tokens: int = 700) -> str:
    r = httpx.post(f"{LLM_BASE}/chat/completions",
                   headers={"Authorization": f"Bearer {LLM_KEY}"},
                   json={"model": LLM_MODEL, "messages": messages,
                         "temperature": 0.2, "max_tokens": max_tokens},
                   timeout=180)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def extract_json(text: str) -> dict | None:
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
    for _hop in range(5):
        raw = llm(msgs)
        obj = extract_json(raw) or {"say": raw.strip()}
        if "tool" in obj:
            name, args = obj["tool"], obj.get("args", {})
            jlog("tool_call", tool=name, args=args)
            try:
                fn = {"run_scenario": tool_run_scenario, "sql": tool_sql, "recall": tool_recall}[name]
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
    return "Tool budget exhausted - try a simpler question."


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
    inc = (pl.read_parquet(ROOT / "data/incidents.parquet")
           .filter(pl.col("CalYear") == 2025)
           .sort("DateOfCall", "HourOfCall"))
    days = inc["DateOfCall"].unique().sort().to_list()
    remember("session", "London", "info", f"Patrol started. Watching 2025 replay at {accel}x. "
             f"{inc.height:,} incidents across {len(days)} days queued.")
    # seed today's validated findings so voice recall can answer questions about them
    for loc, narr in [
        ("Biggin Hill", "FINDING: Biggin Hill is London's quietest station (385 calls/yr) yet closing it adds +215s locally and pushes 9.1% of its calls past the 6-minute target; call volume correlates NEGATIVELY (-0.18) with closure damage."),
        ("Whitechapel", "FINDING: Whitechapel, 7x busier than Biggin Hill, is among the SAFEST closures (+51s local) due to overlapping central cover - the spreadsheet method ranks closures backwards."),
        ("2014 closures", "FINDING: The 2014 LSP5 closures (Clerkenwell, Westminster, Southwark, Belsize, Kingsland, Knightsbridge, Downham, Woolwich, Bow, Silvertown) measurably cost +63s in their former grounds; the twin, never shown pre-2021 data, predicts -52s recovery if reopened - independent convergence."),
        ("Dagenham", "FINDING: Night turnout penalty is station-specific: Dagenham jumps 80s (day) to 127s (night), +47s; city-wide median turnout is +38s slower at night."),
        ("London", "FINDING: Simulator validated on held-out 2025: mean +2.4%, p90 -3.7%; replays a year of London (130k incidents) in ~3s at ~40k incidents/sec."),
    ]:
        remember("analysis", loc, "info", narr)
    if speak:
        tts("Brigade Watch online. Beginning overnight patrol of the London replay.", play=False)
    hb = 0
    for day in days:
        d = inc.filter(pl.col("DateOfCall") == day)
        sim_date = str(day)
        notables = d.filter(
            (pl.col("NumPumpsAttending") >= 4)
            | (pl.col("FirstPumpArriving_AttendanceTime") > 600)
            | (pl.col("NumCalls") >= 5))
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
        # hourly-ish chapter summary via Nemotron (every ~8 sim-days ~ 12 wall-min at 60x)
        if days.index(day) % 8 == 7:
            recent = recall("", minute=None, limit=10)
            try:
                summary = llm([{"role": "system", "content": "Summarize these control-room events in 2 sentences, control-room style."},
                               {"role": "user", "content": json.dumps(recent)}], max_tokens=160)
                remember("chapter", "London", "info", summary, sim_date)
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
    a = ap.parse_args()
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
