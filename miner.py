"""Insight miner — feeds the twin's outputs to Nemotron-Super-120B (Nebius) and
gets back ranked, numbered insight candidates for the demo.

  python miner.py          # needs fire_damage_v2.parquet (run sim.py --sweep first)
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import polars as pl

ROOT = Path(__file__).parent
LLM_BASE = os.environ.get("SIXMINUTES_LLM_BASE_URL") or os.environ.get(
    "CITYWARDEN_LLM_BASE_URL", "https://api.studio.nebius.ai/v1")
LLM_KEY = os.environ.get("SIXMINUTES_LLM_API_KEY") or os.environ.get("CITYWARDEN_LLM_API_KEY", "")
MODEL = "nvidia/nemotron-3-super-120b-a12b"


def gather() -> dict:
    inc = pl.read_parquet(ROOT / "data/incidents.parquet")
    mob = pl.read_parquet(ROOT / "data/mobilisations.parquet")
    facts: dict = {}

    sweep_p = ROOT / "data/processed/fire_damage_v2.parquet"
    if sweep_p.exists():
        sweep = pl.read_parquet(sweep_p)
        calls = (inc.filter(pl.col("CalYear") >= 2024)
                 .group_by("FirstPumpArriving_DeployedFromStation").len()
                 .rename({"FirstPumpArriving_DeployedFromStation": "station", "len": "calls"}))
        joined = sweep.join(calls, on="station", how="left")
        facts["closure_sweep_with_queueing"] = (
            joined.sort("local_added_s", descending=True).head(15).to_dicts())
        facts["safest_closures"] = joined.sort("local_added_s").head(5).to_dicts()
        try:
            from scipy.stats import spearmanr
            facts["spearman_calls_vs_local_damage"] = round(float(
                spearmanr(joined["calls"].fill_null(0).to_numpy(),
                          joined["local_added_s"].to_numpy()).statistic), 3)
        except Exception:
            pass

    to = (mob.filter(pl.col("TurnoutTimeSeconds").is_between(10, 600))
          .group_by(pl.col("HourOfCall")).agg(med=pl.col("TurnoutTimeSeconds").median())
          .sort("HourOfCall"))
    facts["turnout_by_hour"] = to.to_dicts()

    night = (mob.filter(pl.col("TurnoutTimeSeconds").is_between(10, 600))
             .with_columns(night=pl.col("HourOfCall").is_in([0, 1, 2, 3, 4, 5]))
             .group_by(["DeployedFromStation_Name", "night"])
             .agg(med=pl.col("TurnoutTimeSeconds").median(), n=pl.len())
             .filter(pl.col("n") >= 200)
             .pivot(values="med", index="DeployedFromStation_Name", on="night")
             .drop_nulls().with_columns(delta=pl.col("true") - pl.col("false"))
             .sort("delta", descending=True))
    facts["worst_night_turnout_stations"] = night.head(10).to_dicts()

    facts["delay_codes"] = (
        mob.filter(pl.col("DelayCode_Description").is_not_null()
                   & (pl.col("DelayCode_Description") != "Not held up")
                   & (pl.col("DelayCode_Description") != "NULL"))
        .group_by(["DelayCode_Description"]).len().sort("len", descending=True).head(8).to_dicts())

    afa = inc.filter(pl.col("CalYear") == 2025)
    facts["false_alarm_load_2025"] = {
        "false_alarm_share": round(afa.filter(pl.col("IncidentGroup") == "False Alarm").height / afa.height, 3),
        "afa_nonres_pump_minutes": int(
            afa.filter((pl.col("StopCodeDescription") == "AFA")
                       & (pl.col("PropertyCategory") == "Non Residential"))["PumpMinutesRounded"].sum() or 0),
    }

    slow = (inc.filter((pl.col("CalYear") == 2025) & pl.col("FirstPumpArriving_AttendanceTime").is_not_null())
            .group_by(["IncGeo_WardName", "IncGeo_BoroughName"])
            .agg(mean_att=pl.col("FirstPumpArriving_AttendanceTime").mean(), n=pl.len())
            .filter(pl.col("n") >= 50).sort("mean_att", descending=True))
    facts["slowest_wards_2025"] = slow.head(10).to_dicts()
    facts["over_6min_share_2025"] = round(
        inc.filter((pl.col("CalYear") == 2025) & (pl.col("FirstPumpArriving_AttendanceTime") > 360)).height
        / max(1, inc.filter((pl.col("CalYear") == 2025) & pl.col("FirstPumpArriving_AttendanceTime").is_not_null()).height), 3)
    return facts


PROMPT = """You are the analyst for a hackathon team that built a VALIDATED digital twin of London Fire Brigade response (sim within ±5% of held-out 2025; call-volume vs closure-damage correlation is -0.18).
Below are aggregate FACTS computed from 2.3M open records and full closure sweep simulations.

Produce the TOP 5 INSIGHT CANDIDATES for the demo, ranked. Each must be:
- non-obvious (would surprise a fire planner), concrete (numbers from the facts, no invention),
- one sentence headline + 2-3 sentences of support + which chart to show.
Mark your #1 with WINNER. Penalize anything a planner already knows (e.g., 'nights are slower' alone is weak; a SPECIFIC station/ward consequence is strong).

FACTS:
"""


def ask(model: str, facts: dict, max_tokens: int) -> str:
    r = httpx.post(f"{LLM_BASE}/chat/completions",
                   headers={"Authorization": f"Bearer {LLM_KEY}"},
                   json={"model": model, "temperature": 0.4, "max_tokens": max_tokens,
                         "messages": [{"role": "user", "content": PROMPT + json.dumps(facts, default=str)}]},
                   timeout=300)
    r.raise_for_status()
    msg = r.json()["choices"][0]["message"]
    return ((msg.get("content") or "").strip()
            or (msg.get("reasoning_content") or "").strip())


def main() -> None:
    facts = gather()
    out = ask(MODEL, facts, 6000)  # reasoning models need headroom before content
    if not out:
        out = ask("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", facts, 4000)
    Path(ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs/insight_candidates.md").write_text(
        "# Insight candidates (Nemotron-Super-120B over twin outputs)\n\n" + out + "\n\n## Raw facts\n```json\n"
        + json.dumps(facts, indent=1, default=str)[:6000] + "\n```\n")
    print(out[:2000])
    print("\n-> docs/insight_candidates.md")


if __name__ == "__main__":
    main()
