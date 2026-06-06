"""TEST 5 - police demand stability on 1km grid (same bar as fire: predictive spearman >= 0.85)."""
import numpy as np, polars as pl
from pathlib import Path
from scipy.stats import spearmanr
import glob

files = glob.glob("data/police/*/*.csv")
df = pl.concat([pl.read_csv(f, columns=["Month","Longitude","Latitude","Crime type"], infer_schema_length=0) for f in files])
df = df.drop_nulls(["Longitude","Latitude"]).with_columns(
    lon=pl.col("Longitude").cast(pl.Float64, strict=False),
    lat=pl.col("Latitude").cast(pl.Float64, strict=False),
).drop_nulls(["lon","lat"]).filter(pl.col("lat").is_between(51.2,51.8) & pl.col("lon").is_between(-0.6,0.4))
df = df.with_columns(
    gx=((pl.col("lon")*0.6225*111.320)).cast(pl.Int32),   # ~1km cells at 51.5N
    gy=((pl.col("lat")*110.574)).cast(pl.Int32),
    yr=pl.when(pl.col("Month") <= "2024-04").then(pl.lit("Y1"))
       .when(pl.col("Month") <= "2025-04").then(pl.lit("Y2"))
       .otherwise(pl.lit("Y3")),
).with_columns(cell=pl.col("gx").cast(pl.Utf8)+"_"+pl.col("gy").cast(pl.Utf8))
print(f"crime records: {df.height:,}  | 1km cells: {df['cell'].n_unique():,}  | months: {df['Month'].n_unique()}")

def stab(d, label):
    w = d.group_by(["cell","yr"]).len().pivot(values="len", index="cell", on="yr").fill_null(0)
    r12 = float(np.corrcoef(np.log1p(w["Y1"].to_numpy()), np.log1p(w["Y2"].to_numpy()))[0,1])
    r23 = float(np.corrcoef(np.log1p(w["Y2"].to_numpy()), np.log1p(w["Y3"].to_numpy()))[0,1])
    pred = (w["Y1"].to_numpy()+w["Y2"].to_numpy())/2
    sp = spearmanr(pred, w["Y3"].to_numpy()).statistic
    print(f"[{label:<28}] Y1->Y2 r={r12:.3f}  Y2->Y3 r={r23:.3f}  predict-Y3 spearman={sp:.3f}")

stab(df, "ALL crime")
stab(df.filter(pl.col("Crime type")=="Violence and sexual offences"), "Violence (I-grade proxy)")
stab(df.filter(pl.col("Crime type")=="Burglary"), "Burglary")
stab(df.filter(pl.col("Crime type")=="Robbery"), "Robbery")
