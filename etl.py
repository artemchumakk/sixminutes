"""ETL: raw LFB downloads -> clean parquet. Run once."""
import polars as pl
from pathlib import Path

DATA = Path(__file__).parent / "data"

INC_COLS = [
    "IncidentNumber", "DateOfCall", "CalYear", "HourOfCall", "IncidentGroup",
    "StopCodeDescription", "PropertyCategory", "IncGeo_BoroughName", "IncGeo_WardName",
    "Easting_rounded", "Northing_rounded", "IncidentStationGround",
    "FirstPumpArriving_AttendanceTime", "FirstPumpArriving_DeployedFromStation",
    "SecondPumpArriving_AttendanceTime", "SecondPumpArriving_DeployedFromStation",
    "NumPumpsAttending", "PumpMinutesRounded",
]


def load_incidents(path: str) -> pl.DataFrame:
    df = pl.read_excel(DATA / path, engine="calamine")
    keep = [c for c in INC_COLS if c in df.columns]
    missing = set(INC_COLS) - set(keep)
    if missing:
        print(f"  WARN {path}: missing {missing}")
    return df.select(keep).with_columns(
        pl.col("IncidentNumber").cast(pl.Utf8),
        pl.col("DateOfCall").cast(pl.Date, strict=False),
        pl.col("FirstPumpArriving_AttendanceTime").cast(pl.Int32, strict=False),
        pl.col("SecondPumpArriving_AttendanceTime").cast(pl.Int32, strict=False),
        pl.col("Easting_rounded").cast(pl.Float64, strict=False),
        pl.col("Northing_rounded").cast(pl.Float64, strict=False),
    )


def load_mob(path: str) -> pl.DataFrame:
    df = pl.read_csv(DATA / path, infer_schema_length=50000, encoding="utf8-lossy")
    return df.with_columns(
        pl.col("IncidentNumber").cast(pl.Utf8),
        pl.col("DateAndTimeMobilised").str.to_datetime("%d/%m/%Y %H:%M:%S", strict=False),
        pl.col("TurnoutTimeSeconds").cast(pl.Int32, strict=False),
        pl.col("TravelTimeSeconds").cast(pl.Int32, strict=False),
        pl.col("AttendanceTimeSeconds").cast(pl.Int32, strict=False),
    )


def main() -> None:
    print("== incidents ==")
    inc = pl.concat(
        [load_incidents("incidents_2018_2023.xlsx"), load_incidents("incidents_2024on.xlsx")],
        how="vertical_relaxed",
    )
    inc.write_parquet(DATA / "incidents.parquet")
    print(inc.shape, inc["DateOfCall"].min(), "->", inc["DateOfCall"].max())

    print("== mobilisations ==")
    mob = pl.concat(
        [load_mob("mob_2021_2024.csv"), load_mob("mob_2025on.csv")],
        how="vertical_relaxed",
    )
    mob.write_parquet(DATA / "mobilisations.parquet")
    print(mob.shape, mob["DateAndTimeMobilised"].min(), "->", mob["DateAndTimeMobilised"].max())
    print("ETL DONE")


if __name__ == "__main__":
    main()
