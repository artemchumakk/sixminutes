"""TEST 1 — Are incident patterns stable enough to position against?
Pre-registered PASS: adjacent-year ward-level r(log counts) >= 0.80,
and 2021-24 mean rates predict 2025 ward counts with spearman >= 0.85.
"""
import numpy as np
import polars as pl
from pathlib import Path
from scipy.stats import spearmanr

DATA = Path(__file__).parent / "data"
inc = pl.read_parquet(DATA / "incidents.parquet").with_columns(
    ward=pl.col("IncGeo_BoroughName") + "|" + pl.col("IncGeo_WardName")
)
FULL_YEARS = list(range(2018, 2026))  # 2026 is partial -> excluded


def adjacent_year_corr(df: pl.DataFrame, keys: list[str], label: str) -> None:
    wide = (
        df.group_by(keys + ["CalYear"]).len()
        .pivot(values="len", index=keys, on="CalYear")
        .fill_null(0)
    )
    rs = []
    for y in FULL_YEARS[:-1]:
        a, b = str(y), str(y + 1)
        if a in wide.columns and b in wide.columns:
            va, vb = np.log1p(wide[a].to_numpy()), np.log1p(wide[b].to_numpy())
            r = float(np.corrcoef(va, vb)[0, 1])
            rs.append((y, r))
    print(f"\n[{label}] n_cells={wide.height}")
    for y, r in rs:
        print(f"  {y}->{y+1}: pearson(log1p) = {r:.3f}")
    recent = [r for y, r in rs if y >= 2021]
    print(f"  mean r (2021+): {np.mean(recent):.3f}   min: {np.min(recent):.3f}")


# 1. Ward-level, all incidents
adjacent_year_corr(inc, ["ward"], "ward x year, ALL incidents")

# 2. Ward x hour-band (the actual positioning granularity)
inc_hb = inc.with_columns(hourband=(pl.col("HourOfCall") // 6))
adjacent_year_corr(inc_hb, ["ward", "hourband"], "ward x 6h-band x year, ALL")

# 3. Fires only (rarer => harder test)
fires = inc.filter(pl.col("IncidentGroup") == "Fire")
adjacent_year_corr(fires, ["ward"], "ward x year, FIRES ONLY")

# 4. Borough x hour-of-day demand surface: 2021-23 mean vs 2024
surf = (
    inc.filter(pl.col("CalYear").is_in([2021, 2022, 2023, 2024]))
    .group_by(["IncGeo_BoroughName", "HourOfCall", "CalYear"]).len()
    .pivot(values="len", index=["IncGeo_BoroughName", "HourOfCall"], on="CalYear")
    .fill_null(0)
    .with_columns(hist=(pl.col("2021") + pl.col("2022") + pl.col("2023")) / 3)
)
r = float(np.corrcoef(np.log1p(surf["hist"].to_numpy()), np.log1p(surf["2024"].to_numpy()))[0, 1])
print(f"\n[borough x hour surface] 2021-23 mean vs 2024: pearson(log1p) = {r:.3f}")

# 5. THE predictive test: 2021-24 mean -> predict 2025 ward counts
w = (
    inc.filter(pl.col("CalYear").is_in([2021, 2022, 2023, 2024, 2025]))
    .group_by(["ward", "CalYear"]).len()
    .pivot(values="len", index="ward", on="CalYear")
    .fill_null(0)
    .with_columns(pred=(pl.col("2021") + pl.col("2022") + pl.col("2023") + pl.col("2024")) / 4)
    .filter(pl.col("2025") >= 0)
)
pred, act = w["pred"].to_numpy(), w["2025"].to_numpy()
sp = spearmanr(pred, act).statistic
mask = act >= 20
mape = float(np.median(np.abs(pred[mask] - act[mask]) / act[mask]))
r2 = float(1 - np.sum((np.log1p(act) - np.log1p(pred)) ** 2) / np.sum((np.log1p(act) - np.log1p(act).mean()) ** 2))
print(f"\n[PREDICT 2025 from 2021-24 mean] wards={w.height}")
print(f"  spearman = {sp:.3f}   log-R2 = {r2:.3f}   median APE (wards>=20) = {mape:.1%}")

# same predictive test, fires only
wf = (
    fires.filter(pl.col("CalYear").is_in([2021, 2022, 2023, 2024, 2025]))
    .group_by(["ward", "CalYear"]).len()
    .pivot(values="len", index="ward", on="CalYear").fill_null(0)
    .with_columns(pred=(pl.col("2021") + pl.col("2022") + pl.col("2023") + pl.col("2024")) / 4)
)
spf = spearmanr(wf["pred"].to_numpy(), wf["2025"].to_numpy()).statistic
print(f"  fires-only spearman = {spf:.3f}")

print("\nVERDICT hints: PASS needs adjacent-year ward r>=0.80 and predictive spearman>=0.85")
