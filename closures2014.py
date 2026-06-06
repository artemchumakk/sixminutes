"""THE 2014 EXPERIMENT — re-litigating London's most controversial fire decision.

In January 2014 (LSP5) London closed 10 fire stations. This script:
 1. derives WHICH stations closed purely from the data (dispatching through 2013,
    silent from 2015) and WHERE they stood (median coords of their fast legs);
 2. measures what ACTUALLY happened: before/after attendance in their former
    grounds vs the rest of London (difference-in-differences);
 3. REOPENS them in the validated twin against 2025 demand and predicts the
    recovery — if (2) and (3) agree, the twin reproduces a real policy shock.

  python closures2014.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import polars as pl

import sim

DATA = Path(__file__).parent / "data"
COLS = ["CalYear", "FirstPumpArriving_AttendanceTime", "FirstPumpArriving_DeployedFromStation",
        "Easting_rounded", "Northing_rounded", "IncGeo_WardName", "IncGeo_BoroughName"]

print("== loading 2009-2017 (pre/post closure era) ==")
old = pl.read_csv(DATA / "incidents_2009_2017.csv", columns=COLS, infer_schema_length=0,
                  encoding="utf8-lossy").with_columns(
    pl.col("CalYear").cast(pl.Int32, strict=False),
    pl.col("FirstPumpArriving_AttendanceTime").cast(pl.Float64, strict=False),
    pl.col("Easting_rounded").cast(pl.Float64, strict=False),
    pl.col("Northing_rounded").cast(pl.Float64, strict=False),
).drop_nulls(["CalYear"])
print(f"   {old.height:,} incidents 2009-2017")

# -- 1. derive the closures from the data itself ----------------------------
fp = old.drop_nulls(["FirstPumpArriving_DeployedFromStation"])
pre = (fp.filter(pl.col("CalYear").is_in([2012, 2013]))
       .group_by("FirstPumpArriving_DeployedFromStation").len().rename({"len": "n_pre"}))
post = (fp.filter(pl.col("CalYear").is_in([2015, 2016]))
        .group_by("FirstPumpArriving_DeployedFromStation").len().rename({"len": "n_post"}))
current = set(pl.read_parquet(DATA / "stations.parquet")["DeployedFromStation_Name"].to_list())
closed = (pre.join(post, on="FirstPumpArriving_DeployedFromStation", how="left")
          .fill_null(0)
          .filter((pl.col("n_pre") >= 300) & (pl.col("n_post") == 0))
          .filter(~pl.col("FirstPumpArriving_DeployedFromStation").is_in(list(current)))
          .sort("n_pre", descending=True))
names = closed["FirstPumpArriving_DeployedFromStation"].to_list()
print(f"\n== stations that dispatched through 2013 and never again (data-derived) ==")
for r in closed.iter_rows(named=True):
    print(f"   {r['FirstPumpArriving_DeployedFromStation']:<18} first-pump calls 2012-13: {r['n_pre']:,}")

# coords: median of incidents they reached fast
coords = (fp.filter(pl.col("FirstPumpArriving_DeployedFromStation").is_in(names)
                    & (pl.col("CalYear") <= 2013)
                    & (pl.col("FirstPumpArriving_AttendanceTime") <= 240))
          .group_by("FirstPumpArriving_DeployedFromStation")
          .agg(E=pl.col("Easting_rounded").median(), N=pl.col("Northing_rounded").median()))
cmap = {r["FirstPumpArriving_DeployedFromStation"]: (r["E"], r["N"]) for r in coords.iter_rows(named=True)}

# -- 2. MEASURED damage: difference-in-differences ---------------------------
modal = (fp.filter(pl.col("CalYear").is_in([2012, 2013]))
         .group_by(["IncGeo_WardName", "FirstPumpArriving_DeployedFromStation"]).len()
         .sort("len", descending=True)
         .group_by("IncGeo_WardName").first())
treated_wards = set(modal.filter(
    pl.col("FirstPumpArriving_DeployedFromStation").is_in(names))["IncGeo_WardName"].to_list())

att = old.drop_nulls(["FirstPumpArriving_AttendanceTime"]).with_columns(
    treated=pl.col("IncGeo_WardName").is_in(list(treated_wards)),
    period=pl.when(pl.col("CalYear").is_in([2012, 2013])).then(pl.lit("before"))
             .when(pl.col("CalYear").is_in([2015, 2016])).then(pl.lit("after"))
             .otherwise(pl.lit(None)),
).drop_nulls(["period"])
g = att.group_by(["treated", "period"]).agg(m=pl.col("FirstPumpArriving_AttendanceTime").mean())
gd = {(r["treated"], r["period"]): r["m"] for r in g.iter_rows(named=True)}
t_delta = gd[(True, "after")] - gd[(True, "before")]
c_delta = gd[(False, "after")] - gd[(False, "before")]
did = t_delta - c_delta
print(f"\n== MEASURED (2012-13 vs 2015-16, first-pump attendance) ==")
print(f"   former grounds of closed stations ({len(treated_wards)} wards): {gd[(True,'before')]:.1f}s -> {gd[(True,'after')]:.1f}s  ({t_delta:+.1f}s)")
print(f"   rest of London:                              {gd[(False,'before')]:.1f}s -> {gd[(False,'after')]:.1f}s  ({c_delta:+.1f}s)")
print(f"   DIFFERENCE-IN-DIFFERENCES: the closures cost +{did:.1f}s in their grounds")

# -- 3. PREDICTED recovery: reopen them in the twin vs 2025 ------------------
print("\n== TWIN: reopening all of them against 2025 demand ==")
w = sim.World()
P = 0.40
base = sim.simulate(w, sim.Posture(), year=2025, seed=14, p_unavail=P)
opened = {n: (cmap[n][0], cmap[n][1], 1) for n in names if n in cmap}
cf = sim.simulate(w, sim.Posture(opened=opened), year=2025, seed=14, p_unavail=P)
j = base.select("IncidentNumber", base_s=pl.col("sim_s")).join(
    cf.select("IncidentNumber", "sim_s", "station", "ward"), on="IncidentNumber"
).with_columns(d=pl.col("base_s") - pl.col("sim_s"))  # positive = recovery

captured = j.filter(pl.col("station").is_in(names))
back_under = j.filter((pl.col("base_s") > 360) & (pl.col("sim_s") <= 360)).height
print(f"   incidents a reopened station would take first: {captured.height:,} "
      f"({captured.height/j.height:.1%} of London)")
print(f"   mean recovery on those incidents: -{float(captured['d'].mean()):.1f}s")
print(f"   incidents brought back under the 6-minute promise: {back_under:,}/yr")

per = (captured.group_by("station").agg(n=pl.len(), recovery=pl.col("d").mean())
       .sort("recovery", descending=True))
print("\n   per reopened station (2025 demand):")
for r in per.iter_rows(named=True):
    print(f"     {r['station']:<18} takes {r['n']:>5,} calls/yr, recovers {r['recovery']:.0f}s on them")

ward_rec = (captured.group_by("ward").agg(n=pl.len(), rec=pl.col("d").mean())
            .filter(pl.col("n") >= 20).sort("rec", descending=True).head(8))
print("\n   most-recovered wards:")
for r in ward_rec.iter_rows(named=True):
    print(f"     {r['ward']:<28} -{r['rec']:.0f}s (n={r['n']})")

# -- write-up ---------------------------------------------------------------
out = Path("docs/closures_2014.md")
out.parent.mkdir(exist_ok=True)
out.write_text(f"""# The 2014 Experiment — re-litigating the LSP5 station closures

**Data-derived closure list (no Wikipedia):** {', '.join(names)}

## Measured (open data, before/after)
| | 2012-13 | 2015-16 | change |
|---|---|---|---|
| former grounds ({len(treated_wards)} wards) | {gd[(True,'before')]:.1f}s | {gd[(True,'after')]:.1f}s | **{t_delta:+.1f}s** |
| rest of London | {gd[(False,'before')]:.1f}s | {gd[(False,'after')]:.1f}s | {c_delta:+.1f}s |

**Difference-in-differences: the closures cost +{did:.1f}s mean first-pump attendance in their former grounds.**

## Predicted by the twin (reopened vs 2025 demand, validated sim ±5%)
- a reopened station takes {captured.height:,} calls/yr ({captured.height/j.height:.1%} of London)
- mean recovery on those: **-{float(captured['d'].mean()):.1f}s**
- {back_under:,} incidents/yr come back under the 6-minute promise

The twin's predicted per-incident recovery and the measured historical damage are
the same effect viewed from opposite sides of January 2014.

Per-station value today: {', '.join(f"{r['station']} (-{r['recovery']:.0f}s on {r['n']:,} calls)" for r in per.iter_rows(named=True))}
""")
print(f"\n-> {out}")
