"""THE BETTER TEN, round 2 — proper set-aware sequential greedy.

Round-1 ranking failed (interactions!). Now: commit one closure, re-simulate the
network, choose the next on the UPDATED world, x10. Candidates pruned to the 30
cheapest singles (from sweep_112) for tractability.

  python betterten2.py
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
base112 = sim.simulate(w, sim.Posture(opened=OPEN_ALL), year=2025, sample=SAMPLE,
                       seed=SEED, p_unavail=P)
base_s = base112["sim_s"].to_numpy()

sweep = pl.read_parquet(DATA / "processed/sweep_112.parquet").sort("local_added_s")
CANDS = sweep["station"].to_list()[:30]
print(f"candidate pool (30 cheapest singles): {CANDS[:10]} ...")


def posture_for(closed_set: list[str]) -> sim.Posture:
    return sim.Posture(
        closed=frozenset(n for n in closed_set if n in w.sidx),
        opened={k: v for k, v in OPEN_ALL.items() if k not in closed_set})


def score(closed_set: list[str]) -> tuple[float, int, float]:
    cf = sim.simulate(w, posture_for(closed_set), year=2025, sample=SAMPLE,
                      seed=SEED, p_unavail=P)
    s = cf["sim_s"].to_numpy()
    pushed = int(((s > 360) & (base_s <= 360)).sum())
    return pushed * 1000.0 + float((s - base_s).mean()), pushed, float((s - base_s).mean())


chosen: list[str] = []
for rnd in range(10):
    best = None
    for c in CANDS:
        if c in chosen:
            continue
        sc, pushed, mean = score(chosen + [c])
        if best is None or sc < best[0]:
            best = (sc, c, pushed, mean)
    chosen.append(best[1])
    print(f"round {rnd+1}: +{best[1]:<16} cumulative pushed={best[2]:,}  city mean=+{best[3]:.1f}s")

_, pushed_opt, mean_opt = score(chosen)
_, pushed_pol, mean_pol = score(LSP5)
scale = 130_602 / SAMPLE
overlap = sorted(set(chosen) & set(LSP5))

print(f"\nSEQUENTIAL-GREEDY TEN: {chosen}")
print(f"POLITICIANS' TEN:      {LSP5}")
print(f"overlap {len(overlap)}/10: {overlap}")
print(f"\npushed past 6min/yr:  politicians {pushed_pol*scale:,.0f}  vs  twin-sequential {pushed_opt*scale:,.0f}")
print(f"city mean added:      politicians +{mean_pol:.1f}s  vs  twin-sequential +{mean_opt:.1f}s")
verdict = pushed_pol / max(1, pushed_opt)
print(f"VERDICT: politicians/twin broken-promise ratio = {verdict:.2f}x "
      f"({'twin wins' if verdict > 1.02 else 'politicians hold up' if verdict > 0.98 else 'politicians win'})")

with open("docs/better_ten.md", "a") as f:
    f.write(f"""

## Round 2 — set-aware sequential greedy (interactions respected)

Naive single-closure ranking LOST to the 2014 committee (1,619 vs 1,237 pushed —
closure sets interact; cheap closures cluster). Sequential greedy re-simulates the
network after each commitment:

- twin's sequential ten: {', '.join(chosen)}
- overlap with 2014: {len(overlap)}/10 ({', '.join(overlap)})
- broken 6-min promises/yr: politicians {pushed_pol*scale:,.0f} vs twin {pushed_opt*scale:,.0f} ({verdict:.2f}x)
- city mean: +{mean_pol:.1f}s vs +{mean_opt:.1f}s

Either reading is a finding: if the twin wins, only set-aware simulation can plan
closures; if 2014 holds up, the twin *certifies* the selection — and the measured
+63s damage (see closures_2014.md) was the price of the policy, not of the picks.
""")
print("-> docs/better_ten.md (appended)")
