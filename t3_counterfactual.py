"""TEST 3 — THE THESIS: does call-volume ranking diverge from true closure damage?
Method: for every 2024+ incident first-attended by station S, estimate the
counterfactual response without S = best alternative station (its median turnout
+ XGB-predicted travel). Damage(S) = added seconds across S's incidents.
Honesty check: model counterfactual validated against OBSERVED second pumps.
Pre-registered: thesis proven if rankings diverge materially (spearman < 0.85)
with concrete quiet-but-critical inversions.
"""
import numpy as np
import polars as pl
import xgboost as xgb
from pathlib import Path
from scipy.stats import spearmanr

DATA = Path(__file__).parent / "data"
st = pl.read_parquet(DATA / "stations.parquet")
model = xgb.XGBRegressor(); model.load_model(str(DATA / "travel_xgb.json"))
stations = st["DeployedFromStation_Name"].to_list()
sidx = {s: i for i, s in enumerate(stations)}
SE = st["E"].to_numpy(); SN = st["N"].to_numpy()
TURNOUT = st["turnout_med"].to_numpy().astype(np.float32)

inc = (
    pl.read_parquet(DATA / "incidents.parquet")
    .filter(
        (pl.col("CalYear") >= 2024)
        & pl.col("FirstPumpArriving_AttendanceTime").is_not_null()
        & pl.col("FirstPumpArriving_DeployedFromStation").is_in(stations)
        & pl.col("Easting_rounded").is_not_null()
    )
    .with_columns(
        dow=pl.col("DateOfCall").dt.weekday(),
        month=pl.col("DateOfCall").dt.month(),
        fs_idx=pl.col("FirstPumpArriving_DeployedFromStation").replace_strict(sidx, default=-1),
    )
)
print(f"2024+ incidents with first-pump ground truth: {inc.height:,}")

E = inc["Easting_rounded"].to_numpy(); N = inc["Northing_rounded"].to_numpy()
HR = inc["HourOfCall"].to_numpy(); DOW = inc["dow"].to_numpy(); MO = inc["month"].to_numpy()
FS = inc["fs_idx"].to_numpy(); ACT = inc["FirstPumpArriving_AttendanceTime"].to_numpy().astype(np.float32)

n_inc, n_st = len(E), len(stations)
print(f"computing {n_inc:,} x {n_st} counterfactual attendance matrix...")

# distance matrix in chunks -> predicted attendance from EVERY station
CHUNK = 40_000
cf_best = np.empty(n_inc, dtype=np.float32)        # best alternative attendance
for s0 in range(0, n_inc, CHUNK):
    s1 = min(s0 + CHUNK, n_inc)
    d = np.sqrt((E[s0:s1, None] - SE[None, :]) ** 2 + (N[s0:s1, None] - SN[None, :]) ** 2)
    m = s1 - s0
    feats = np.empty((m * n_st, 5), dtype=np.float32)
    feats[:, 0] = d.ravel()
    feats[:, 1] = np.repeat(HR[s0:s1], n_st)
    feats[:, 2] = np.repeat(DOW[s0:s1], n_st)
    feats[:, 3] = np.repeat(MO[s0:s1], n_st)
    feats[:, 4] = np.tile(np.arange(n_st, dtype=np.float32), m)
    att = model.predict(feats).reshape(m, n_st) + TURNOUT[None, :]
    att[d > 15000] = 9e9                       # outside model validity
    att[np.arange(m), FS[s0:s1]] = 9e9         # closure: own station unavailable
    cf_best[s0:s1] = att.min(axis=1)

delta = np.maximum(cf_best - ACT, 0)           # added seconds if home station gone

df = inc.with_columns(delta=pl.Series(delta), cf=pl.Series(cf_best))
per = (
    df.group_by("FirstPumpArriving_DeployedFromStation")
    .agg(
        calls=pl.len(),
        mean_added=pl.col("delta").mean(),
        added_p90=pl.col("delta").quantile(0.9),
        pushed_600=( (pl.col("cf") > 600) & (pl.col("FirstPumpArriving_AttendanceTime") <= 600) ).sum(),
    )
    .with_columns(total_added_h=pl.col("calls") * pl.col("mean_added") / 3600)
    .sort("mean_added", descending=True)
)

sp = spearmanr(per["calls"].to_numpy(), per["mean_added"].to_numpy()).statistic
print(f"\n[THESIS] spearman(call volume, closure damage) = {sp:.3f}  (1.0 would mean the spreadsheet method works)")

# quiet-but-critical inversions
calls_rank = per.sort("calls").with_row_index("quiet_rank")
qmap = dict(zip(calls_rank["FirstPumpArriving_DeployedFromStation"], calls_rank["quiet_rank"]))
per = per.with_columns(
    quiet_rank=pl.col("FirstPumpArriving_DeployedFromStation").replace_strict(qmap, default=None)
)
quiet_threshold = int(per.height * 0.4)
inversions = per.filter(pl.col("quiet_rank") < quiet_threshold).head(8)
print("\n[QUIET-BUT-CRITICAL] bottom-40% by calls, ranked by damage if closed:")
for r in inversions.iter_rows(named=True):
    print(f"  {r['FirstPumpArriving_DeployedFromStation']:<18} calls={r['calls']:>5,}  +{r['mean_added']:.0f}s mean  +{r['added_p90']:.0f}s p90  {r['pushed_600']:,} incidents pushed past 10min")

# the two ends for the pitch
busiest_safe = per.sort("mean_added").head(3)
print("\n[SAFEST closures by damage] (note their call volumes!):")
for r in busiest_safe.iter_rows(named=True):
    print(f"  {r['FirstPumpArriving_DeployedFromStation']:<18} calls={r['calls']:>5,}  +{r['mean_added']:.0f}s mean")

# honesty check: model counterfactual vs OBSERVED second pumps from other stations
obs = (
    df.filter(
        pl.col("SecondPumpArriving_AttendanceTime").is_not_null()
        & (pl.col("SecondPumpArriving_DeployedFromStation") != pl.col("FirstPumpArriving_DeployedFromStation"))
        & pl.col("SecondPumpArriving_DeployedFromStation").is_in(stations)
    )
    .with_columns(obs_delta=(pl.col("SecondPumpArriving_AttendanceTime") - pl.col("FirstPumpArriving_AttendanceTime")).clip(0))
)
per_obs = obs.group_by("FirstPumpArriving_DeployedFromStation").agg(
    n=pl.len(), model_d=pl.col("delta").mean(), obs_d=pl.col("obs_delta").mean()
).filter(pl.col("n") >= 100)
r_val = float(np.corrcoef(per_obs["model_d"].to_numpy(), per_obs["obs_d"].to_numpy())[0, 1])
bias = float((per_obs["model_d"] - per_obs["obs_d"]).mean())
print(f"\n[VALIDATION vs observed 2nd pumps] stations={per_obs.height}  pearson={r_val:.3f}  mean bias={bias:+.0f}s")
print("(model counterfactual is conservative if bias<0: second pumps are dispatched later, not at t=0)")

per.write_parquet(DATA / "closure_damage.parquet")
