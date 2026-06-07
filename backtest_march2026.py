"""Backtest the police demand model on a held-out month (March 2026).

Out-of-sample: the prediction uses ONLY months strictly before 2026-03 (a forecaster
standing at the end of Feb 2026). We then score that prediction against the ACTUAL
March 2026 crime counts per 1km cell. Same cleaning/grid as service_police.load_demand.
"""
import glob
import numpy as np
import polars as pl
from pathlib import Path
from pyproj import Transformer

DATA = Path(__file__).parent / "data"
WGS84_TO_BNG = Transformer.from_crs(4326, 27700, always_xy=True)
LON_MIN, LON_MAX, LAT_MIN, LAT_MAX = -0.62, 0.40, 51.20, 51.80
TARGET = "2026-03"


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra = np.argsort(np.argsort(a)); rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


# --- load + clean raw street crime (identical to load_demand) ---
files = sorted(glob.glob(str(DATA / "police" / "*" / "*.csv")))
raw = pl.concat([pl.read_csv(f, columns=["Month", "Longitude", "Latitude", "Crime type"],
                             infer_schema_length=0) for f in files])
df = (raw.with_columns(lon=pl.col("Longitude").cast(pl.Float64, strict=False),
                       lat=pl.col("Latitude").cast(pl.Float64, strict=False))
      .drop_nulls(["lon", "lat"])
      .filter((pl.col("lon") != 0) | (pl.col("lat") != 0))
      .filter(pl.col("lon").is_between(LON_MIN, LON_MAX) & pl.col("lat").is_between(LAT_MIN, LAT_MAX)))
E, N = WGS84_TO_BNG.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
df = df.with_columns(gx=(pl.Series(E) // 1000).cast(pl.Int32),
                     gy=(pl.Series(N) // 1000).cast(pl.Int32)
                     ).with_columns(cell=pl.format("E{}_N{}", "gx", "gy"))

months = sorted(df["Month"].unique().to_list())
print(f"data spans {months[0]} -> {months[-1]}  ({len(months)} months)")
print("last 4 monthly totals (sanity-check target month is complete):")
for m in months[-4:]:
    print(f"  {m}: {df.filter(pl.col('Month') == m).height:>7,} crimes")

prior = [m for m in months if m < TARGET]
trail24 = prior[-24:]
seasonal = [m for m in ("2024-03", "2025-03") if m in months]
print(f"\nTARGET held out: {TARGET}   (training pool: {prior[0]}..{prior[-1]}, {len(prior)} months)")


def run(label: str, category: str | None, train_months: list[str], win: str) -> None:
    dd = df if category is None else df.filter(pl.col("Crime type") == category)
    n_m = len(train_months)
    pred = (dd.filter(pl.col("Month").is_in(train_months))
            .group_by("cell").len().with_columns(pred=pl.col("len") / n_m).select("cell", "pred"))
    act = (dd.filter(pl.col("Month") == TARGET)
           .group_by("cell").len().rename({"len": "actual"}).select("cell", "actual"))
    j = pred.join(act, on="cell", how="full", coalesce=True).fill_null(0.0)
    p = j["pred"].to_numpy(); a = j["actual"].to_numpy().astype(float)

    sp = _spearman(p, a)
    pr = float(np.corrcoef(np.log1p(p), np.log1p(a))[0, 1])
    mae = float(np.mean(np.abs(p - a)))
    tot_p, tot_a = float(p.sum()), float(a.sum())
    vol = 100 * (tot_p - tot_a) / tot_a if tot_a else float("nan")
    K = 50
    top_p = set(j.sort("pred", descending=True).head(K)["cell"].to_list())
    top_a = set(j.sort("actual", descending=True).head(K)["cell"].to_list())
    hit = len(top_p & top_a) / K
    print(f"\n[{label}: {win}]  cells={j.height:,}  train_months={n_m}")
    print(f"  spearman(pred, actual) = {sp:.3f}   pearson(log1p) = {pr:.3f}")
    print(f"  predicted total = {tot_p:,.0f}   actual = {tot_a:,.0f}   volume error = {vol:+.1f}%")
    print(f"  MAE = {mae:.2f} crimes/cell   top-{K} hotspot hit = {hit*100:.0f}% ({len(top_p & top_a)}/{K})")


print("\n" + "=" * 64)
run("ALL crime", None, trail24, "24-mo trailing mean (the model)")
run("ALL crime", None, prior, "all-history mean")
if seasonal:
    run("ALL crime", None, seasonal, f"seasonal mean of {seasonal}")
print("\n" + "=" * 64)
run("Violence", "Violence and sexual offences", trail24, "24-mo trailing mean")
run("Burglary", "Burglary", trail24, "24-mo trailing mean")
run("Robbery", "Robbery", trail24, "24-mo trailing mean")
