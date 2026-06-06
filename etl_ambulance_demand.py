"""Build the REAL ambulance demand surface from the GLA Ward Atlas.

This REPLACES the old fire-brigade proxy (door-forcings + RTCs). The Ward Atlas
publishes *actual London Ambulance Service incident counts per ward* (2006-2014) —
real ambulance demand, not a fire stand-in.

Pipeline:
  1. Download the GLA Ward Atlas data CSV (data.london.gov.uk, datapress).
  2. Fetch 2011 ward population-centroids in British National Grid (ONS ArcGIS).
  3. Map each ward's incident count to its centroid's 1km BNG cell.
  -> data/processed/ambulance_ward_demand.parquet  [cell, gx, gy, ambulance, assault, alcohol]

We take the mean of the three most recent years (2012-2014) to smooth single-year
noise. The "London total" pseudo-row (E12000007) is dropped so we don't double-count.
City of London (E09000001) is a LAD not a ward, so the ONS ward service has no
centroid for it — we place it manually at the Square Mile.

Honesty: ward-centroid placement means a ward's whole count sits in ONE 1km cell.
Resolution is therefore WARD-level (~600 zones) — the native resolution of the real
data. We do not fake finer resolution than the source supports. curl/requests are
blocked in this repo, so all HTTP goes through urllib (+certifi), exactly like
service_ambulance._fetch_osm_stations.
"""
from __future__ import annotations
import csv
import io
import json
import ssl
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import polars as pl

DATA = Path(__file__).parent / "data"
PROC = DATA / "processed"
PROC.mkdir(exist_ok=True)

# datapress resource URLs (resolved from the dataset API on data.london.gov.uk)
ATLAS_CSV_URL = ("https://data.london.gov.uk/download/exprl/"
                 "150584ff-3509-4e17-91d1-315ed4557419/ward-atlas-data.csv")
WARD_CENTROID_SVC = ("https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
                     "Wards_December_2011_GCB_EW_2022/FeatureServer/0/query")

# Ward Atlas column indices (verified against the published header row).
# "Ambulance; All Ambulance Incidents; <year>" -> 2012,2013,2014 = cols 769,770,771
COLS_AMBULANCE = (769, 770, 771)
COLS_ASSAULT   = (778, 779, 780)   # "Ambulance; Assault Incidents attended by Ambulance"
COLS_ALCOHOL   = (800, 801, 802)   # "Binge Drinking; Number of ambulance call outs for alcohol..."
COL_CODE = 1                       # ONS "New Code" (E05.. wards, E09.. boroughs)

# rows that are aggregates, not wards -> exclude so we don't double-count
DROP_CODES = {"E12000007"}         # "London" region total
# City of London is one LAD-row with no ward centroid; place it at the Square Mile (BNG)
CITY_CODE = "E09000001"
CITY_BNG = (532500.0, 181400.0)

HDR = {"User-Agent": "sixminutes-hackathon/1.0 (research)"}


def _get(url: str) -> bytes:
    import certifi
    ctx = ssl.create_default_context(cafile=certifi.where())
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, context=ctx, timeout=120) as r:
        return r.read()


def _download_atlas() -> Path:
    f = DATA / "ward_atlas_data.csv"
    if not f.exists():
        f.write_bytes(_get(ATLAS_CSV_URL))
    return f


def _fetch_ward_centroids() -> dict[str, tuple[float, float]]:
    """{WD11CD: (E, N)} in EPSG:27700, cached. Paginated ONS ArcGIS query."""
    cache = DATA / "ward_centroids_bng.json"
    if cache.exists():
        return {k: tuple(v) for k, v in json.loads(cache.read_text()).items()}
    cent: dict[str, tuple[float, float]] = {}
    off = 0
    while True:
        p = {"where": "1=1", "outFields": "WD11CD", "returnCentroid": "true",
             "outSR": "27700", "f": "json", "resultOffset": off, "resultRecordCount": 2000}
        d = json.loads(_get(WARD_CENTROID_SVC + "?" + urllib.parse.urlencode(p)))
        fs = d.get("features", [])
        for f in fs:
            a = f.get("attributes", {})
            code = a.get("WD11CD") or a.get("wd11cd")
            g = f.get("centroid")
            if code and g:
                cent[code] = (g["x"], g["y"])
        if not d.get("exceededTransferLimit") or not fs:
            break
        off += len(fs)
    cache.write_text(json.dumps(cent))
    return cent


def _num(x: str):
    x = (x or "").replace(",", "").strip()
    try:
        return float(x)
    except ValueError:
        return None


def _avg(row, cols):
    vals = [v for v in (_num(row[c]) for c in cols) if v is not None]
    return sum(vals) / len(vals) if vals else None


def build() -> pl.DataFrame:
    rows = list(csv.reader(io.StringIO(_download_atlas().read_bytes().decode("latin-1"))))
    data = rows[2:]                       # row0 = header, row1 = year sub-header
    cent = _fetch_ward_centroids()

    rec: dict[tuple[int, int], dict[str, float]] = {}
    matched = missing = 0
    for r in data:
        code = r[COL_CODE].strip()
        if not code or code in DROP_CODES:
            continue
        amb = _avg(r, COLS_AMBULANCE)
        if amb is None:
            continue
        g = cent.get(code) or (CITY_BNG if code == CITY_CODE else None)
        if g is None:
            missing += 1
            continue
        matched += 1
        gx, gy = int(g[0] // 1000), int(g[1] // 1000)
        d = rec.setdefault((gx, gy), {"ambulance": 0.0, "assault": 0.0, "alcohol": 0.0})
        d["ambulance"] += amb
        d["assault"] += _avg(r, COLS_ASSAULT) or 0.0
        d["alcohol"] += _avg(r, COLS_ALCOHOL) or 0.0

    gx = np.fromiter((k[0] for k in rec), int)
    gy = np.fromiter((k[1] for k in rec), int)
    df = pl.DataFrame({
        "gx": gx, "gy": gy,
        "ambulance": [rec[(int(a), int(b))]["ambulance"] for a, b in zip(gx, gy)],
        "assault":   [rec[(int(a), int(b))]["assault"]   for a, b in zip(gx, gy)],
        "alcohol":   [rec[(int(a), int(b))]["alcohol"]   for a, b in zip(gx, gy)],
    }).with_columns(cell=pl.format("E{}_N{}", pl.col("gx"), pl.col("gy")))
    df.write_parquet(PROC / "ambulance_ward_demand.parquet")
    print(f"ward demand: {matched} wards matched, {missing} unmatched -> {df.height} 1km cells; "
          f"total ambulance incidents/yr={df['ambulance'].sum():,.0f} "
          f"(assault={df['assault'].sum():,.0f} alcohol={df['alcohol'].sum():,.0f})")
    return df


if __name__ == "__main__":
    build()
