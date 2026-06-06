"""TEST 2 — Is response physics learnable from mobilisation legs?
Pre-registered PASS: XGBoost travel-time model beats per-station-median baseline
on held-out 2025+ legs, with median abs error <= 75s; station coords derivable
from data alone. Saves stations.parquet + travel_xgb.json for t3.
"""
import numpy as np
import polars as pl
import xgboost as xgb
from pathlib import Path

DATA = Path(__file__).parent / "data"

mob = pl.read_parquet(DATA / "mobilisations.parquet").filter(
    (pl.col("PumpOrder") == 1)
    & (pl.col("DeployedFromLocation") == "Home Station")
    & pl.col("TravelTimeSeconds").is_between(30, 1800)
    & pl.col("TurnoutTimeSeconds").is_between(10, 600)
)
inc = pl.read_parquet(DATA / "incidents.parquet").select(
    "IncidentNumber", "Easting_rounded", "Northing_rounded", "IncGeo_BoroughName"
)
legs = mob.join(inc, on="IncidentNumber", how="inner").drop_nulls(
    ["Easting_rounded", "Northing_rounded", "DateAndTimeMobilised"]
)
print(f"usable first-pump home-station legs: {legs.height:,}")

# --- stations: median coords of fast legs (<=180s travel) ---
st = (
    legs.filter(pl.col("TravelTimeSeconds") <= 180)
    .group_by("DeployedFromStation_Name")
    .agg(
        E=pl.col("Easting_rounded").median(),
        N=pl.col("Northing_rounded").median(),
        n=pl.len(),
        turnout_med=pl.col("TurnoutTimeSeconds").median(),
    )
    .filter(pl.col("n") >= 50)
)
print(f"stations derived from data: {st.height}")
st.write_parquet(DATA / "stations.parquet")

legs = legs.join(
    st.select(pl.col("DeployedFromStation_Name"), "E", "N"),
    on="DeployedFromStation_Name", how="inner",
).with_columns(
    dist_m=((pl.col("Easting_rounded") - pl.col("E")) ** 2
            + (pl.col("Northing_rounded") - pl.col("N")) ** 2).sqrt(),
    dow=pl.col("DateAndTimeMobilised").dt.weekday(),
    month=pl.col("DateAndTimeMobilised").dt.month(),
).filter(pl.col("dist_m").is_between(50, 15000))

med_speed = (legs["dist_m"] / legs["TravelTimeSeconds"]).median()
print(f"median straight-line speed: {med_speed:.1f} m/s (sanity: urban 4-9 m/s crow-fly)")

# --- features / split ---
stations_list = st["DeployedFromStation_Name"].to_list()
sidx = {s: i for i, s in enumerate(stations_list)}
legs = legs.with_columns(
    st_idx=pl.col("DeployedFromStation_Name").replace_strict(sidx, default=-1),
)
FEATS = ["dist_m", "HourOfCall", "dow", "month", "st_idx"]
train = legs.filter(pl.col("CalYear") <= 2024)
test = legs.filter(pl.col("CalYear") >= 2025)
Xtr = train.select(FEATS).to_numpy().astype(np.float32)
ytr = train["TravelTimeSeconds"].to_numpy().astype(np.float32)
Xte = test.select(FEATS).to_numpy().astype(np.float32)
yte = test["TravelTimeSeconds"].to_numpy().astype(np.float32)
print(f"train legs (2021-24): {len(ytr):,}   test legs (2025+): {len(yte):,}")

model = xgb.XGBRegressor(
    n_estimators=400, max_depth=8, learning_rate=0.08,
    subsample=0.8, colsample_bytree=0.8, tree_method="hist", n_jobs=8,
)
model.fit(Xtr, ytr)
pred = model.predict(Xte)

# baselines
b_global = np.full_like(yte, float(np.median(ytr)))
stmed = train.group_by("st_idx").agg(m=pl.col("TravelTimeSeconds").median())
stmap = dict(zip(stmed["st_idx"].to_list(), stmed["m"].to_list()))
b_station = np.array([stmap.get(int(i), float(np.median(ytr))) for i in Xte[:, 4]], dtype=np.float32)


def report(name: str, p: np.ndarray) -> None:
    mae = float(np.mean(np.abs(p - yte)))
    med = float(np.median(np.abs(p - yte)))
    r2 = float(1 - np.sum((yte - p) ** 2) / np.sum((yte - yte.mean()) ** 2))
    print(f"  {name:<22} MAE={mae:6.1f}s  medianAE={med:6.1f}s  R2={r2:6.3f}")


print("\n[travel-time model, held-out 2025+]")
report("global-median", b_global)
report("per-station-median", b_station)
report("XGBoost", pred)

for lo, hi in [(50, 1000), (1000, 2000), (2000, 4000), (4000, 15000)]:
    m = (Xte[:, 0] >= lo) & (Xte[:, 0] < hi)
    if m.sum() > 100:
        print(f"    dist {lo:>5}-{hi:<5}m  n={m.sum():>7,}  XGB medAE={np.median(np.abs(pred[m]-yte[m])):5.1f}s  vs stn-med={np.median(np.abs(b_station[m]-yte[m])):5.1f}s")

model.save_model(str(DATA / "travel_xgb.json"))

# --- quantile models for simulation-grade uncertainty ---
q10 = xgb.XGBRegressor(n_estimators=250, max_depth=7, learning_rate=0.08,
                       objective="reg:quantileerror", quantile_alpha=0.1, tree_method="hist", n_jobs=8)
q90 = xgb.XGBRegressor(n_estimators=250, max_depth=7, learning_rate=0.08,
                       objective="reg:quantileerror", quantile_alpha=0.9, tree_method="hist", n_jobs=8)
q10.fit(Xtr, ytr); q90.fit(Xtr, ytr)
lo, hi = q10.predict(Xte), q90.predict(Xte)
cov = float(np.mean((yte >= lo) & (yte <= hi)))
print(f"\n[quantile calibration] target 80% inside [q10,q90] -> actual {cov:.1%}")

# --- insight previews (free, from the same table) ---
to = mob.group_by("HourOfCall").agg(t=pl.col("TurnoutTimeSeconds").median()).sort("HourOfCall")
night = to.filter(pl.col("HourOfCall").is_in([1, 2, 3, 4]))["t"].mean()
day = to.filter(pl.col("HourOfCall").is_in([10, 11, 14, 15]))["t"].mean()
print(f"\n[insight preview] median turnout night(1-4h)={night:.0f}s vs day={day:.0f}s -> night penalty {night-day:+.0f}s")
delay = (
    mob.group_by("DelayCode_Description").len().sort("len", descending=True).head(6)
)
print("[insight preview] top delay codes:", delay.to_dicts())
