"""TEST 1b — stability on a 1km grid (immune to the May-2022 ward boundary redraw).
Same pre-registered thresholds: adjacent-year r>=0.80, predictive spearman>=0.85.
"""
import numpy as np
import polars as pl
from pathlib import Path
from scipy.stats import spearmanr

DATA = Path(__file__).parent / "data"
inc = (
    pl.read_parquet(DATA / "incidents.parquet")
    .drop_nulls(["Easting_rounded", "Northing_rounded"])
    .with_columns(
        gx=(pl.col("Easting_rounded") // 1000).cast(pl.Int32),
        gy=(pl.col("Northing_rounded") // 1000).cast(pl.Int32),
    )
    .with_columns(cell=pl.col("gx").cast(pl.Utf8) + "_" + pl.col("gy").cast(pl.Utf8))
)
print(f"incidents with coords: {inc.height:,}  | 1km cells: {inc['cell'].n_unique():,}")

FULL_YEARS = list(range(2018, 2026))


def adjacent(df: pl.DataFrame, label: str) -> None:
    wide = (
        df.group_by(["cell", "CalYear"]).len()
        .pivot(values="len", index="cell", on="CalYear").fill_null(0)
    )
    print(f"\n[{label}] cells={wide.height:,}")
    for y in FULL_YEARS[:-1]:
        a, b = str(y), str(y + 1)
        if a in wide.columns and b in wide.columns:
            r = float(np.corrcoef(np.log1p(wide[a].to_numpy()), np.log1p(wide[b].to_numpy()))[0, 1])
            print(f"  {y}->{y+1}: r = {r:.3f}")


adjacent(inc, "1km cell x year, ALL incidents")
adjacent(inc.filter(pl.col("IncidentGroup") == "Fire"), "1km cell x year, FIRES ONLY")

# predictive: 2023-24 mean -> 2025, on 1km cells
w = (
    inc.filter(pl.col("CalYear").is_in([2023, 2024, 2025]))
    .group_by(["cell", "CalYear"]).len()
    .pivot(values="len", index="cell", on="CalYear").fill_null(0)
    .with_columns(pred=(pl.col("2023") + pl.col("2024")) / 2)
)
pred, act = w["pred"].to_numpy(), w["2025"].to_numpy()
sp = spearmanr(pred, act).statistic
r2 = float(1 - np.sum((np.log1p(act) - np.log1p(pred)) ** 2) / np.sum((np.log1p(act) - np.log1p(act).mean()) ** 2))
mask = act >= 20
mape = float(np.median(np.abs(pred[mask] - act[mask]) / act[mask]))
print(f"\n[PREDICT 2025 from 2023-24, 1km cells] n={w.height:,}")
print(f"  spearman={sp:.3f}  log-R2={r2:.3f}  median APE (cells>=20/yr)={mape:.1%}")

# cell x hour-band predictive (positioning granularity)
wh = (
    inc.filter(pl.col("CalYear").is_in([2023, 2024, 2025]))
    .with_columns(hb=pl.col("HourOfCall") // 6)
    .group_by(["cell", "hb", "CalYear"]).len()
    .pivot(values="len", index=["cell", "hb"], on="CalYear").fill_null(0)
    .with_columns(pred=(pl.col("2023") + pl.col("2024")) / 2)
)
sp2 = spearmanr(wh["pred"].to_numpy(), wh["2025"].to_numpy()).statistic
print(f"  cell x 6h-band spearman = {sp2:.3f}")
