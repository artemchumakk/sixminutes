"""Borough-level holdout: predict Southwark's March 2026 crime COUNT from prior history.

For an AREA total (not the per-cell map), the honest accuracy metric is volume error:
predicted count vs actual count. We also report the trailing month-to-month standard
deviation, because even a perfect expected-value model can only get within the natural
monthly noise on a single month.
"""
import glob
import numpy as np
import polars as pl
from pathlib import Path

DATA = Path(__file__).parent / "data"
TARGET = "2026-03"

files = sorted(glob.glob(str(DATA / "police" / "*" / "*.csv")))
df = pl.concat([pl.read_csv(f, columns=["Month", "LSOA name", "Crime type"], infer_schema_length=0)
                for f in files]).drop_nulls(["LSOA name"])

months = sorted(df["Month"].unique().to_list())
prior = [m for m in months if m < TARGET]
trail = prior[-24:]
print(f"data {months[0]}..{months[-1]}  | holding out {TARGET}  | trailing window {trail[0]}..{trail[-1]}")


def report(d: pl.DataFrame, label: str) -> None:
    g = d.group_by("Month").len()
    counts = dict(zip(g["Month"].to_list(), g["len"].to_list()))  # Month -> count
    tr = np.array([counts.get(mo, 0) for mo in trail], dtype=float)
    pred = float(tr.mean()); std = float(tr.std()); actual = float(counts.get(TARGET, 0))
    err = 100 * (pred - actual) / actual if actual else float("nan")
    print(f"\n[{label}]")
    print(f"  predicted (24-mo mean) = {pred:,.0f}   actual {TARGET} = {actual:,.0f}   error = {err:+.1f}%")
    print(f"  natural monthly noise  = ±{std:,.0f} crimes (±{100*std/pred:.0f}%) — the floor on single-month accuracy")
    print(f"  last 4 actual months   = " + ", ".join(f"{mo}:{int(counts.get(mo,0)):,}" for mo in prior[-3:] + [TARGET]))


sw = df.filter(pl.col("LSOA name").str.starts_with("Southwark"))
print(f"\nSouthwark rows: {sw.height:,}  | sample LSOA names: {sw['LSOA name'].unique().to_list()[:3]}")
report(sw, "Southwark — ALL crime")
report(sw.filter(pl.col("Crime type") == "Violence and sexual offences"), "Southwark — Violence")
report(sw.filter(pl.col("Crime type") == "Burglary"), "Southwark — Burglary")
