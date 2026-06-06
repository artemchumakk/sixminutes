"""Ambulance demand forecast with place/postcode lookup + month/day/date seasonality.

Turns "predict the load for <place> on <date>" into an answer:
  geocode(query)         place name / postcode / outcode -> BNG metres + 1km cell
  predict_load(query, date=..., month=..., dow=..., radius_km=...)

Demand is now REAL: per-cell counts come from the GLA Ward Atlas (actual LAS ambulance
incidents per ward, annualised to incidents/day). The month / weekday / time-of-day
SHAPE is borrowed from LFB 999 call timing (the Ward Atlas has no within-year timing),
so the forecast = real annual demand × seasonal shape. Units are real LAS incidents/day.
"""
from __future__ import annotations
import json, re, ssl, urllib.request, urllib.parse, datetime as dt
import numpy as np
import polars as pl
import service_ambulance as S

DATA, PROC = S.DATA, S.PROC
_POSTCODE = re.compile(r'^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$')
_OUTCODE  = re.compile(r'^[A-Za-z]{1,2}\d[A-Za-z\d]?$')
_DOW = {1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat",7:"Sun"}


# ---------------- geocoding (curl is blocked -> urllib + certifi + UA) ----------------
def _get(url):
    import certifi
    ctx = ssl.create_default_context(cafile=certifi.where())
    req = urllib.request.Request(url, headers={"User-Agent": "sixminutes-hackathon/1.0 (research)"})
    with urllib.request.urlopen(req, context=ctx, timeout=25) as r:
        return json.loads(r.read())


def geocode(query: str):
    """query -> (E, N, label, source). Postcodes/outcodes via postcodes.io (returns BNG
    directly); place names via OSM Nominatim (lat/lon -> BNG via pyproj)."""
    q = query.strip()
    if _POSTCODE.match(q):
        d = _get("https://api.postcodes.io/postcodes/" + urllib.parse.quote(q))["result"]
        return float(d["eastings"]), float(d["northings"]), f"{d['postcode']} ({d['admin_district']})", "postcodes.io"
    if _OUTCODE.match(q):
        d = _get("https://api.postcodes.io/outcodes/" + urllib.parse.quote(q))["result"]
        dist = (d.get("admin_district") or [q])
        return float(d["eastings"]), float(d["northings"]), f"{d['outcode']} ({dist[0]})", "postcodes.io"
    res = _get("https://nominatim.openstreetmap.org/search?" +
               urllib.parse.urlencode({"q": q + ", London, UK", "format": "json", "limit": 1}))
    if not res:
        raise ValueError(f"could not geocode '{query}'")
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    e, n = tr.transform(float(res[0]["lon"]), float(res[0]["lat"]))
    return float(e), float(n), res[0].get("display_name", q).split(",")[0], "nominatim"


def _cell_of(E, N):
    return int(E // 1000), int(N // 1000)


# ---------------- seasonal SHAPE (month / weekday / time-of-day multipliers) ----------------
def build_calendar():
    """City-wide seasonal multipliers from LFB 999 call timing (temporal prior only).
    month_mult[m] / dow_mult[d] = relative busyness vs the average day; bucket_share[b] =
    fraction of calls in each time-of-day window. The Ward Atlas supplies real demand
    *levels*; this supplies the within-year *shape*."""
    inc = pl.read_parquet(DATA / "incidents_ambulance.parquet").filter(
        pl.col("DateOfCall").is_not_null() & pl.col("HourOfCall").is_not_null())
    inc = inc.with_columns(
        month=pl.col("DateOfCall").dt.month(),
        dow=pl.col("DateOfCall").dt.weekday(),
        bucket=pl.when(pl.col("HourOfCall") < 6).then(pl.lit("night"))
                 .when(pl.col("HourOfCall") < 12).then(pl.lit("am"))
                 .when(pl.col("HourOfCall") < 18).then(pl.lit("pm"))
                 .otherwise(pl.lit("eve")))
    # daily totals -> month/weekday multipliers (mean day in group / overall mean day)
    per_day = inc.group_by("DateOfCall").agg(
        n=pl.len(), month=pl.col("month").first(), dow=pl.col("dow").first())
    base = float(per_day["n"].mean()) or 1.0
    mm = per_day.group_by("month").agg(mult=(pl.col("n").mean() / base)).sort("month")
    dd = per_day.group_by("dow").agg(mult=(pl.col("n").mean() / base)).sort("dow")
    bb = inc.group_by("bucket").agg(n=pl.len())
    tot = float(bb["n"].sum()) or 1.0
    shape = {
        "month_mult": {int(r["month"]): r["mult"] for r in mm.iter_rows(named=True)},
        "dow_mult":   {int(r["dow"]): r["mult"] for r in dd.iter_rows(named=True)},
        "bucket_share": {r["bucket"]: r["n"] / tot for r in bb.iter_rows(named=True)},
    }
    (PROC / "ambulance_seasonal_shape.json").write_text(json.dumps(shape))
    return shape


def _shape():
    f = PROC / "ambulance_seasonal_shape.json"
    if not f.exists():
        build_calendar()
    return json.loads(f.read_text())  # keys are strings (JSON) -> use str(month)/str(dow)


def _real_demand():
    """Real per-cell ambulance incidents/yr (Ward Atlas, proxy_all category)."""
    return pl.read_parquet(PROC / "ambulance_demand.parquet").filter(
        pl.col("category") == "proxy_all")


# ---------------- the forecast ----------------
def predict_load(query: str, date: str | None = None, month: int | None = None,
                 dow: int | None = None, radius_km: int = 0):
    """Expected REAL ambulance incidents/day for a place, optionally conditioned on a
    date (or month / weekday). radius_km>0 aggregates surrounding 1km cells."""
    E, N, label, src = geocode(query)
    gx, gy = _cell_of(E, N)
    if date:
        d = dt.date.fromisoformat(date)
        month, dow = d.month, d.isoweekday()
    dem = _real_demand()
    shape = _shape()

    # cells in scope (the point cell, optionally a square radius around it)
    if radius_km > 0:
        cells = {f"E{gx+dx}_N{gy+dy}" for dx in range(-radius_km, radius_km+1)
                 for dy in range(-radius_km, radius_km+1)}
    else:
        cells = {f"E{gx}_N{gy}"}
    scope = dem.filter(pl.col("cell").is_in(list(cells)))

    if scope.height == 0:
        return {"place": label, "query": query, "cell": f"E{gx}_N{gy}", "source": src,
                "expected_per_day": 0.0, "note": "no recorded ambulance demand in this 1km area"}

    annual = float(scope["weight"].sum())          # real incidents/yr in scope
    base_per_day = annual / 365.0
    m_mult = shape["month_mult"].get(str(month), 1.0) if month is not None else 1.0
    d_mult = shape["dow_mult"].get(str(dow), 1.0) if dow is not None else 1.0
    expected = base_per_day * m_mult * d_mult

    share = shape["bucket_share"]
    by_bucket = {b: round(expected * share.get(b, 0.0), 2) for b in ("night", "am", "pm", "eve")}

    # busyness vs the rest of London (percentile of real per-cell annual demand)
    tot_by_cell = dem.group_by("cell").agg(t=pl.col("weight").sum())
    pctile = round(100 * float((tot_by_cell["t"] <= annual).mean()), 0)

    return {
        "place": label, "query": query, "cell": f"E{gx}_N{gy}", "radius_km": radius_km,
        "source": src, "conditioned_on": {"date": date, "month": month,
            "weekday": _DOW.get(dow) if dow else None,
            "month_mult": round(m_mult, 3), "weekday_mult": round(d_mult, 3)},
        "expected_per_day": round(expected, 2),
        "cell_overall_per_day": round(base_per_day, 2),
        "by_time_of_day": by_bucket,
        "busyness_percentile": pctile,
        "unit": "real LAS incidents/day (GLA Ward Atlas annualised × LFB seasonal shape)",
    }


def main():
    import sys
    q = sys.argv[1] if len(sys.argv) > 1 else "Camden"
    date = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(predict_load(q, date=date, radius_km=1), indent=2))


if __name__ == "__main__":
    main()
