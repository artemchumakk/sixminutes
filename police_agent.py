"""Watch Commander — the SIXMINUTES police-tier Nemotron agent (ElevenLabs bounty).

Police-tier parallel to agent.py. Same agentic loop, same memory architecture, same voice;
the brain reasons over the police demand surface + closure-damage twin instead of fire.

Modes:
  python police_agent.py --ask "close Biggin Hill - who loses cover?"   # one-shot
  python police_agent.py --chat                                         # text REPL
  python police_agent.py --voice                                        # push-to-talk: EL STT -> agent -> EL TTS
  python police_agent.py --patrol [--speak]                             # persistent autonomous session (>=1h11m)

Memory (judge-recall-proof):
  logs_police/memory.db   events(minute, wall_ts, sim_date, kind, location, severity, narrative)
  logs_police/session_<ts>.jsonl   every utterance + tool call (bounty session log)
  logs_police/audio/*.mp3          every TTS output (ElevenLabs proof artifacts)

Deterministic core, agentic shell: the LLM decides what to investigate, simulate, and say;
the physics (the closure counterfactual in police_engine) never touches the model.
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
LOGS = ROOT / "logs_police"
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
API = os.environ.get("SIXMINUTES_POLICE_API") or os.environ.get("SIXMINUTES_API", "http://localhost:8096")

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
def tool_run_scenario(close: list[str] | None = None, category: str = "all") -> dict:
    r = httpx.post(f"{API}/scenario", json={"close": close or [], "category": category}, timeout=120)
    r.raise_for_status()
    out = r.json()
    out["worst_cells"] = out.get("worst_cells", [])[:6]
    out.pop("cell_deltas", None)   # too big for context; the dashboard reads it directly
    return out


def tool_sql(query: str) -> list[dict]:
    import duckdb
    if re.search(r"\b(insert|update|delete|drop|create|attach|copy)\b", query, re.I):
        return [{"error": "read-only"}]
    proc = ROOT / "data" / "processed"
    con = duckdb.connect()
    for view, fn in (("demand", "police_demand.parquet"), ("stations", "police_stations.parquet"),
                     ("closure_damage", "police_damage.parquet"), ("anchors", "police_response_anchors.parquet")):
        p = proc / fn
        if p.exists():
            con.execute(f"CREATE VIEW {view} AS SELECT * FROM '{p}'")
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
  {"tool":"run_scenario","args":{"close":["Biggin Hill"],"category":"violence"}}  -> close a SET of stations; returns crime-weighted city impact + worst 1km cells (the transferred-physics closure counterfactual)
  {"tool":"sql","args":{"query":"SELECT ..."}}                                    -> read-only SQL over: demand(cell, gx, gy, weight, category, period), stations(name, E, N, kind), closure_damage(station, calls, mean_added_s, p90_added_s, pushed_over_target), anchors(metric, value, note)
  {"tool":"recall","args":{"query":"Biggin Hill"}} or {"args":{"minute":14}}      -> your session memory (findings/events you observed earlier)
To answer the user directly, reply: {"say":"<your answer>"}
Rules: lead with numbers; control-room brevity; seconds and crimes/month matter. category is one of all/violence/burglary/robbery/asb/vehicle/theft. This is the POLICE tier (Tier B): the demand surface is VALIDATED (predict-next-year spearman 0.94), travel physics is TRANSFERRED from the fire XGBoost model, and the absolute response scale is ANCHORED to the published Met I-grade mean (801s) and 15-min (900s) target - say so if asked. The closure RANKING and the deltas are scale-invariant. Never invent stations or events not in your tools/recall results."""

SYSTEM = ("You are Watch Commander, the duty intelligence officer for the SIXMINUTES police tier - "
          "a digital twin of London's police coverage built on 3.42M open crime records (36 months, "
          "Met + City of London) on a 1km grid. Today is June 2026. You watch the demand surface, "
          "remember everything, and run closure counterfactuals on request.\n" + TOOLS_DOC)


# ------------------------------------------------------------------ llm -----
def _strip_think(text: str) -> str:
    # Nemotron (local Nano + Nebius super) are reasoning models: they emit
    # <think>...</think> inline in content. Keep only what follows the final tag.
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[-1]
    return text.strip()


def llm(messages: list[dict], max_tokens: int = 1500) -> str:
    r = httpx.post(f"{LLM_BASE}/chat/completions",
                   headers={"Authorization": f"Bearer {LLM_KEY}"},
                   json={"model": LLM_MODEL, "messages": messages,
                         "temperature": 0.2, "max_tokens": max_tokens},
                   timeout=180)
    r.raise_for_status()
    return _strip_think(r.json()["choices"][0]["message"]["content"])


def extract_json(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    blob = m.group(0)
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        pass
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
    wav = "/tmp/sixminutes_police_voice.wav"
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
# Validated police-tier findings, seeded so voice recall can answer about them (POLICE_VALIDATION.md / insights_police.md).
FINDINGS = [
    ("thesis", "London",
     "FINDING: spearman(call volume, closure damage) = +0.37 - far below the 0.85 you'd need for 'just close the quiet stations' to be safe. Call volume points at the wrong end of the list."),
    ("Biggin Hill", "Biggin Hill",
     "FINDING: Biggin Hill handles only 23.7 violence crimes/mo (bottom 40% by volume) yet is the SINGLE MOST DAMAGING closure in London at +374s mean added response - the cleanest quiet-but-critical inversion."),
    ("Edmonton", "Edmonton",
     "FINDING: Edmonton is the BUSIEST station at 456 violence crimes/mo but costs only +108s to close. 3.5x less per-incident damage than Biggin Hill, which handles one-twentieth the volume."),
    ("the wrong ten", "London",
     "FINDING: Closing the 10 quietest stations (the spreadsheet cut) vs the 10 lowest-damage (our model): 464 vs 287 crime-min/mo added, 59.5 vs 1.4 crimes/mo pushed past 15 min. The two lists agree on 0 of 10 stations; the naive cut would wrongly close Biggin Hill, Albany Street and Sudbury."),
    ("concentration", "Soho / West End",
     "FINDING: Violence is extremely concentrated - top 10% of 1km cells hold 47.5% of all violence, top 20% hold 70.4%. The peak cell E529_N180 (Soho/West End) runs 153 violence crimes/month."),
    ("stability", "London",
     "FINDING: The demand surface is VALIDATED - predict-next-year spearman = 0.94 for violence (year-over-year cell log-correlation 0.99). Last year's crime map is next year's map; this is the load-bearing claim of the tier."),
    ("tier B honesty", "London",
     "FINDING: Tier B - police open data has no incident-level response times and no time-of-day. Travel physics is TRANSFERRED from the fire XGBoost model; absolute scale is ANCHORED to the Met I-grade mean (801s) and 900s target. The closure ranking and deltas are scale-invariant, so the counterfactual stands."),
    ("scope", "London",
     "FINDING: Coverage = 3,423,275 street crimes over 36 months (May 2023-Apr 2026), Met + City of London, on the EPSG:27700 1km grid -> 49,264 demand rows and 128 stations scored for closure damage."),
]


def patrol(speak: bool, accel: int = 60) -> None:
    """Autonomous session: walk the closure-damage ranking, narrate the costly closures, remember.

    Police has no incident stream to replay, so the watch is over the ESTATE: the agent
    surveys each station's closure damage (real numbers from the twin), flags the
    quiet-but-critical ones, and writes Nemotron chapter summaries. Self-contained and
    crash-safe (journal-backed SQLite); the live API is used only as a best-effort confirm.
    """
    import polars as pl
    dmg = (pl.read_parquet(ROOT / "data/processed/police_damage.parquet")
           .sort("mean_added_s", descending=True))
    remember("session", "London", "info",
             f"Watch Commander online. Surveying closure damage across {dmg.height} police stations "
             f"on the London crime-demand twin.")
    for kind, loc, narr in FINDINGS:
        remember("analysis", loc, "info", narr)
    if speak:
        tts("Watch Commander online. Beginning the overnight survey of London's police coverage.", play=False)

    # quiet-but-critical = bottom 40% by call volume but high closure damage (the thesis in motion)
    thresh = dmg.select(pl.col("calls").quantile(0.4)).item()
    hb = 0
    for r in dmg.iter_rows(named=True):
        quiet = r["calls"] <= thresh
        sev = "P1" if (quiet and r["mean_added_s"] >= 200) else "P2" if r["mean_added_s"] >= 120 else "info"
        tag = "QUIET-BUT-CRITICAL" if (quiet and r["mean_added_s"] >= 200) else "closure"
        narrative = (f"{tag}: closing {r['station']} adds +{r['mean_added_s']:.0f}s mean "
                     f"(+{r['p90_added_s']:.0f}s p90) and pushes {r['pushed_over_target']:.1f} "
                     f"violence crimes/mo past the 15-min target; it handles {r['calls']:.0f} crimes/mo"
                     f"{' (bottom 40% by volume)' if quiet else ''}.")
        remember("notable", r["station"], sev, narrative)
        if speak and hb % 5 == 0:
            tts(narrative, play=False)
        # autonomous counterfactual: best-effort live confirm via the API (no-op if it's down)
        if hb % 12 == 0:
            try:
                res = tool_run_scenario(close=[r["station"]], category="violence")
                remember("counterfactual", r["station"], "info",
                         f"Live twin confirms closing {r['station']}: city +{res['city']['mean_delta_s']}s mean, "
                         f"{res['city']['crimes_pushed_over_target']}/mo pushed past target.")
            except Exception as e:
                jlog("error", where="patrol_scenario", error=str(e)[:200])
        # Nemotron chapter summary every ~8 stations
        if hb % 8 == 7 and LLM_KEY:
            try:
                recent = recall("", minute=None, limit=10)
                summary = llm([{"role": "system", "content": "Summarize these police control-room findings in 2 sentences, control-room style, lead with numbers."},
                               {"role": "user", "content": json.dumps(recent)}], max_tokens=160)
                remember("chapter", "London", "info", summary)
                if speak:
                    tts(summary, play=False)
            except Exception as e:
                jlog("error", where="chapter", error=str(e)[:200])
        hb += 1
        time.sleep(max(1.0, 1800 / accel))   # ~30s/station at accel=60 -> ~1h per full sweep
    remember("session", "London", "info", "Survey complete - looping is allowed.")


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
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
