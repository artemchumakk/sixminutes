"""ETL (ambulance tier): re-read LFB incident xlsx KEEPING SpecialServiceType.

The shipped etl.py drops SpecialServiceType; the ambulance demand proxy needs it
(door-forcing + RTC incidents). This is a separate file so we never touch etl.py.
Run once: produces data/incidents_ambulance.parquet
"""
import polars as pl
from pathlib import Path

DATA = Path(__file__).parent / "data"

# columns the ambulance demand proxy needs (superset kept deliberately small)
KEEP = [
    "IncidentNumber", "DateOfCall", "CalYear", "HourOfCall",
    "IncidentGroup", "StopCodeDescription", "SpecialServiceType",
    "PropertyCategory", "IncGeo_BoroughName",
    "Easting_rounded", "Northing_rounded",
]


def load(path: str) -> pl.DataFrame:
    df = pl.read_excel(DATA / path, engine="calamine")
    keep = [c for c in KEEP if c in df.columns]
    missing = set(KEEP) - set(keep)
    if missing:
        print(f"  WARN {path}: missing {missing}")
    return df.select(keep).with_columns(
        pl.col("IncidentNumber").cast(pl.Utf8),
        pl.col("DateOfCall").cast(pl.Date, strict=False),
        pl.col("CalYear").cast(pl.Int32, strict=False),
        pl.col("HourOfCall").cast(pl.Int32, strict=False),
        pl.col("Easting_rounded").cast(pl.Float64, strict=False),
        pl.col("Northing_rounded").cast(pl.Float64, strict=False),
    )


def main() -> None:
    parts = []
    for f in ("incidents_2018_2023.xlsx", "incidents_2024on.xlsx"):
        if (DATA / f).exists():
            print(f"== reading {f} ==")
            parts.append(load(f))
        else:
            print(f"  MISSING {f} (skipped)")
    if not parts:
        raise SystemExit("No incident xlsx found in data/ — run the download first.")
    inc = pl.concat(parts, how="vertical_relaxed")
    out = DATA / "incidents_ambulance.parquet"
    inc.write_parquet(out)
    print(inc.shape, "->", out)
    # quick peek so we know which SpecialServiceType strings to match in service_ambulance.py
    print("\nTop SpecialServiceType values:")
    print(
        inc.filter(pl.col("SpecialServiceType").is_not_null())
        .group_by("SpecialServiceType").len().sort("len", descending=True).head(15)
    )


if __name__ == "__main__":
    main()
