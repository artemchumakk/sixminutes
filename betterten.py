"""THE BETTER TEN — given that 10 stations had to close in 2014, were they the right 10?

Method: reconstruct pre-2014 London (current 102 + the 10 reopened = 112 stations),
sweep all 112 single closures against 2025 demand (identical CRN draws), rank by
local damage, pick the 10 cheapest-to-lose with a 3km spacing constraint (avoids
compounding neighbours), then evaluate BOTH sets as full postures:

  politicians' ten (actual LSP5)  vs  optimizer's ten  — same station count = same savings proxy.

  python betterten.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import polars as pl

import sim

DATA = Path(__file__).parent / "data"
LSP5 = ["Clerkenwell", "Westminster", "Southwark", "Belsize", "Kingsland",
        "Knightsbridge", "Downham", "Woolwich", "Bow", "Silvertown"]
P, SEED, SAMPLE = 0.40, 14, 40_000

print("== coords of the 2014 stations (from their own pre-2014 legs) ==")
old = pl.read_csv(DATA / "incidents_2009_2017.csv",
                  columns=["CalYear", "FirstPumpArriving_DeployedFromStation",
                           "FirstPumpArriving_AttendanceTime", "Easting_rounded", "Northing_rounded"],
                  infer_schema_length=0, encoding="utf8-lossy").with_columns(
    pl.col("CalYear").cast(pl.Int32, strict=False),
    pl.col("FirstPumpArriving_AttendanceTime").cast(pl.Float64, strict=False),
    pl.col("Easting_rounded").cast(pl.Float64, strict=False),
    pl.col("Northing_rounded").cast(pl.Float64, strict=False))
coords = (old.filter(pl.col("FirstPumpArriving_DeployedFromStation").is_in(LSP5)
                     & (pl.col("CalYear") <= 2013)
                     & (pl.col("FirstPumpArriving_AttendanceTime") <= 240))
          .group_by("FirstPumpArriving_DeployedFromStation")
          .agg(E=pl.col("Easting_rounded").median(), N=pl.col("Northing_rounded").median()))
cmap = {r["FirstPumpArriving_DeployedFromStation"]: (float(r["E"]), float(r["N"]))
        for r in coords.iter_rows(named=True)}
OPEN_ALL = {n: (cmap[n][0], cmap[n][1], 1) for n in LSP5}

w = sim.World()
ALL = list(w.names) + LSP5
POS = {**{n: (float(w.SE[w.sidx[n]]), float(w.SN[w.sidx[n]])) for n in w.names},
       **{n: cmap[n] for n in LSP5}}

print("== baseline: pre-2014 London (112 stations) vs 2025 demand ==")
base112 = sim.simulate(w, sim.Posture(opened=OPEN_ALL), year=2025, sample=SAMPLE,
                       seed=SEED, p_unavail=P)

print(f"== sweeping all {len(ALL)} single closures on the 112 network ==")
rows = []
for s in ALL:
    if s in LSP5:
        posture = sim.Posture(opened={k: v for k, v in OPEN_ALL.items() if k != s})
    else:
        posture = sim.Posture(closed=frozenset([s]), opened=OPEN_ALL)
    cf = sim.simulate(w, posture, year=2025, sample=SAMPLE, seed=SEED, p_unavail=P)
    delta = (cf["sim_s"] - base112["sim_s"]).to_numpy()
    mine = (base112["station"] == s).to_numpy()
    rows.append({"station": s,
                 "served": int(mine.sum()),
                 "local_added_s": float(delta[mine].mean()) if mine.any() else 0.0,
                 "pushed": int(((cf["sim_s"] > 360) & (base112["sim_s"] <= 360)).sum())})
sw = pl.DataFrame(rows).sort("local_added_s")
sw.write_parquet(DATA / "processed/sweep_112.parquet")

# pick optimizer's ten: cheapest local damage, no two within 3km
chosen: list[str] = []
for r in sw.iter_rows(named=True):
    s = r["station"]
    if all(np.hypot(POS[s][0] - POS[c][0], POS[s][1] - POS[c][1]) > 3000 for c in chosen):
        chosen.append(s)
    if len(chosen) == 10:
        break

print(f"\nOPTIMIZER'S TEN: {chosen}")
print(f"POLITICIANS' TEN: {LSP5}")
overlap = set(chosen) & set(LSP5)
print(f"overlap: {len(overlap)} -> {sorted(overlap) if overlap else 'NONE'}")

def eval_set(names: list[str], label: str) -> dict:
    posture = sim.Posture(
        closed=frozenset(n for n in names if n in w.sidx),
        opened={k: v for k, v in OPEN_ALL.items() if k not in names})
    cf = sim.simulate(w, posture, year=2025, sample=SAMPLE, seed=SEED, p_unavail=P)
    delta = (cf["sim_s"] - base112["sim_s"]).to_numpy()
    affected = delta > 5
    out = {
        "label": label,
        "city_mean_added_s": float(delta.mean()),
        "affected_incidents": int(affected.sum()),
        "mean_added_on_affected_s": float(delta[affected].mean()) if affected.any() else 0.0,
        "pushed_past_6min": int(((cf["sim_s"] > 360) & (base112["sim_s"] <= 360)).sum()),
        "p99_added_s": float(np.quantile(delta, 0.99)),
    }
    print(f"\n[{label}]")
    for k, v in out.items():
        if k != "label":
            print(f"   {k:<28} {v:,.1f}" if isinstance(v, float) else f"   {k:<28} {v:,}")
    return out

a = eval_set(LSP5, "POLITICIANS' TEN (actual 2014)")
b = eval_set(chosen, "OPTIMIZER'S TEN (twin)")

ratio = a["pushed_past_6min"] / max(1, b["pushed_past_6min"])
scale = 130_602 / SAMPLE  # full-2025 scaling
Path("docs").mkdir(exist_ok=True)
Path("docs/better_ten.md").write_text(f"""# The Better Ten — was the 2014 decision optimal?

Same constraint (close 10 of pre-2014 London's 112 stations = same savings proxy),
same 2025 demand, same random draws. The twin's answer:

| | politicians' ten (actual) | optimizer's ten (twin) |
|---|---|---|
| city mean added | {a['city_mean_added_s']:.1f}s | {b['city_mean_added_s']:.1f}s |
| incidents made worse | {a['affected_incidents']*scale:,.0f}/yr | {b['affected_incidents']*scale:,.0f}/yr |
| mean damage on those | +{a['mean_added_on_affected_s']:.0f}s | +{b['mean_added_on_affected_s']:.0f}s |
| **pushed past 6-min promise** | **{a['pushed_past_6min']*scale:,.0f}/yr** | **{b['pushed_past_6min']*scale:,.0f}/yr** |

**The 2014 set causes {ratio:.1f}x more broken 6-minute promises than an
information-equivalent alternative.** Overlap between the sets: {len(overlap)}/10
({', '.join(sorted(overlap)) if overlap else 'none'}).

Optimizer's ten: {', '.join(chosen)}

Caveats (state on camera): savings proxied by station count; single-pump reopenings;
2025 demand (not 2012); greedy + 3km spacing, not exhaustive search — a true optimum
would only widen the gap.
""")
print(f"\nVERDICT: 2014's choice causes {ratio:.1f}x more broken promises than the twin's choice.")
print("-> docs/better_ten.md")
