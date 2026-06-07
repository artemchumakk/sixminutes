"""POLICE — real deployment footprint by Basic Command Unit (Tier B data prep).

The model's "today" footprint used to be a fake even split of an arbitrary pool across the
124 station buildings. The Met does NOT publish how many response units sit at each station
(the per-station "based station" column on the fleet list is withheld on counter-terrorism
grounds), and it doesn't deploy by station anyway — local policing is organised into 12
Basic Command Units (BCUs), each a group of 2-4 boroughs, and officer strength is published
at that level.

So this script builds the most defensible REAL footprint we can:

    station --(point-in-polygon)--> London borough --(official grouping)--> BCU
    BCU officer strength (published) --> split across the BCU's stations by local crime

The per-station number is therefore a real per-AREA figure (the BCU total is real and
published) with only the within-BCU split modelled — weighted by the recorded crime each
station sits nearest, over a base-staffing floor so every post stays crewed. The four
City of London stations belong to a separate force, not the Met, so they're folded into
their nearest Met BCU for footprint purposes (noted in the output).

    .venv/bin/python service_police_bcu.py        # writes data/processed/police_bcu.parquet

Output columns: name, borough, bcu, bcu_officers, footprint (officers attributed to that
station = BCU total × demand-weighted share). Sum(footprint) == sum(BCU_OFFICERS).
"""
from __future__ import annotations

import json
from collections import Counter

import numpy as np
import polars as pl

from service_police import PROC, BNG_TO_WGS84

GEO = PROC / "geo"
BOROUGHS_GEOJSON = GEO / "london_boroughs.geojson"
OUT = PROC / "police_bcu.parquet"

# ── borough → BCU (the Met's 12 Basic Command Units; official borough groupings) ──────────
BOROUGH_BCU: dict[str, str] = {
    "Hammersmith and Fulham": "Central West", "Kensington and Chelsea": "Central West",
    "Westminster": "Central West",
    "Kingston upon Thames": "South West", "Merton": "South West",
    "Richmond upon Thames": "South West", "Wandsworth": "South West",
    "Bromley": "South", "Croydon": "South", "Sutton": "South",
    "Bexley": "South East", "Greenwich": "South East", "Lewisham": "South East",
    "Barking and Dagenham": "East", "Havering": "East", "Redbridge": "East",
    "Ealing": "West", "Hillingdon": "West", "Hounslow": "West",
    "Lambeth": "Central South", "Southwark": "Central South",
    "Enfield": "North", "Haringey": "North",
    "Hackney": "Central East", "Tower Hamlets": "Central East",
    "Camden": "Central North", "Islington": "Central North",
    "Barnet": "North West", "Brent": "North West", "Harrow": "North West",
    "Newham": "North East", "Waltham Forest": "North East",
}

# ── per-BCU police officer strength ───────────────────────────────────────────────────────
# Source: London Assembly / Mayor's Question Time, "BCU officer numbers" (figures as the BCU
# model was rolled out), https://www.london.gov.uk/.../find-an-answer/bcu-officer-numbers .
# This is the latest cleanly-published PER-BCU breakdown; live force-wide totals (which drift
# month to month) sit on the MOPAC Workforce dashboard. To refresh, update these 12 numbers.
BCU_OFFICERS: dict[str, int] = {
    "Central West": 1803,   # Westminster, Kensington & Chelsea, Hammersmith & Fulham
    "Central North": 1120,  # Camden, Islington
    "Central East": 1169,   # Hackney, Tower Hamlets
    "North East": 1091,     # Newham, Waltham Forest
    "East": 1248,           # Barking & Dagenham, Havering, Redbridge
    "Central South": 1312,  # Lambeth, Southwark
    "South East": 1402,     # Bexley, Greenwich, Lewisham
    "South": 1387,          # Bromley, Sutton, Croydon
    "North West": 1409,     # Barnet, Brent, Harrow
    "South West": 1344,     # Kingston, Merton, Richmond, Wandsworth
    "West": 1548,           # Ealing, Hillingdon, Hounslow
    "North": 1108,          # Enfield, Haringey
}
BCU_SOURCE = "London Assembly (Mayor's Question Time), 'BCU officer numbers'"
BCU_SOURCE_URL = (
    "https://www.london.gov.uk/who-we-are/what-london-assembly-does/"
    "questions-mayor/find-an-answer/bcu-officer-numbers"
)


def _load_boroughs() -> list[tuple[str, np.ndarray]]:
    gj = json.loads(BOROUGHS_GEOJSON.read_text())
    out: list[tuple[str, np.ndarray]] = []
    for f in gj["features"]:
        nm = f["properties"]["name"]
        geom = f["geometry"]
        rings = (geom["coordinates"] if geom["type"] == "MultiPolygon"
                 else [geom["coordinates"]])
        for poly in rings:
            out.append((nm, np.asarray(poly[0], dtype=float)))  # exterior ring, lon/lat
    return out


def _pip(x: float, y: float, ring: np.ndarray) -> bool:
    """Ray-casting point-in-polygon. ring is Nx2 (lon=x, lat=y)."""
    xs, ys = ring[:, 0], ring[:, 1]
    n = len(ring)
    inside = False
    j = n - 1
    for i in range(n):
        if ((ys[i] > y) != (ys[j] > y)) and (
            x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i]) + xs[i]
        ):
            inside = not inside
        j = i
    return inside


def build() -> pl.DataFrame:
    # stations exactly as PoliceWorld builds them (dedup by name, sorted)
    stn = (pl.read_parquet(PROC / "police_stations.parquet")
           .unique(subset="name", keep="first").sort("name"))
    names = stn["name"].to_list()
    E, N = stn["E"].to_numpy(), stn["N"].to_numpy()
    lon, lat = BNG_TO_WGS84.transform(E, N)

    polys = _load_boroughs()
    boxes = [(r[:, 0].min(), r[:, 0].max(), r[:, 1].min(), r[:, 1].max()) for _, r in polys]
    met_centroids = {nm: (r[:, 0].mean(), r[:, 1].mean())
                     for nm, r in polys if nm in BOROUGH_BCU}

    boroughs: list[str] = []
    folded: list[str] = []
    for x, y in zip(lon, lat):
        hit = None
        for (nm, ring), (x0, x1, y0, y1) in zip(polys, boxes):
            if x0 <= x <= x1 and y0 <= y <= y1 and _pip(x, y, ring):
                hit = nm
                break
        if hit is None or hit not in BOROUGH_BCU:
            # outside any borough, or in City of London (a separate force): fold into the
            # nearest *Met* borough so every real station still carries a footprint.
            hit = min(met_centroids, key=lambda b: (met_centroids[b][0] - x) ** 2
                      + (met_centroids[b][1] - y) ** 2)
            folded.append(hit)
        boroughs.append(hit)

    bcu = [BOROUGH_BCU[b] for b in boroughs]
    per_bcu_n = Counter(bcu)
    officers = [BCU_OFFICERS[c] for c in bcu]

    # ── within-BCU split: by WORKLOAD, not evenly ────────────────────────────────────────
    # The BCU officer total is real/published; per-station counts are withheld. The most
    # defensible split is to weight each station's slice of its BCU's officers by the local
    # recorded crime it sits nearest to — busy stations carry more crews. A base-staffing
    # floor (EVEN_FLOOR) keeps every post meaningfully crewed so nowhere reads as empty.
    dem = (pl.read_parquet(PROC / "police_demand.parquet")
           .filter((pl.col("period") == "all") & (pl.col("category") == "all")))
    cx = dem["gx"].to_numpy().astype(float) * 1000.0 + 500.0   # cell centroids, BNG metres
    cy = dem["gy"].to_numpy().astype(float) * 1000.0 + 500.0
    cw = dem["weight"].to_numpy().astype(float)                # crimes / month
    Ef, Nf = E.astype(float), N.astype(float)
    nearest = (np.subtract.outer(cx, Ef) ** 2 + np.subtract.outer(cy, Nf) ** 2).argmin(axis=1)
    station_demand = np.zeros(len(names))
    np.add.at(station_demand, nearest, cw)                     # crimes/mo nearest each station

    EVEN_FLOOR = 0.35  # 35% of a BCU's officers spread evenly; 65% follow local crime
    bcu_arr = np.asarray(bcu)
    fp = np.zeros(len(names))
    for c in per_bcu_n:
        idx = np.where(bcu_arr == c)[0]
        d = station_demand[idx]
        dem_share = (d / d.sum()) if d.sum() > 0 else np.full(idx.size, 1.0 / idx.size)
        even_share = np.full(idx.size, 1.0 / idx.size)
        share = EVEN_FLOOR * even_share + (1.0 - EVEN_FLOOR) * dem_share
        fp[idx] = BCU_OFFICERS[c] * share / share.sum()       # sums to the BCU total exactly
    footprint = fp.tolist()

    df = pl.DataFrame({
        "name": names,
        "borough": boroughs,
        "bcu": bcu,
        "bcu_officers": officers,
        "footprint": [round(f, 3) for f in footprint],
    })
    df._folded = folded  # type: ignore[attr-defined]
    df._per_bcu_n = per_bcu_n  # type: ignore[attr-defined]
    return df


def main() -> None:
    df = build()
    df.write_parquet(OUT)
    per_bcu_n = df._per_bcu_n  # type: ignore[attr-defined]
    folded = df._folded  # type: ignore[attr-defined]

    print(f"stations: {df.height}   BCUs: {len(per_bcu_n)}")
    print(f"total real BCU officers: {sum(BCU_OFFICERS.values()):,}")
    print(f"sum(footprint): {df['footprint'].sum():,.0f}  (should match total)")
    if folded:
        print(f"City-of-London stations folded into nearest Met BCU: {len(folded)} "
              f"-> {sorted(set(folded))}")
    print("\n  BCU            stations  officers   per-station (min–max, demand-weighted)")
    for c in sorted(per_bcu_n):
        n = per_bcu_n[c]
        sub = df.filter(pl.col("bcu") == c)["footprint"]
        print(f"  {c:14s} {n:>6d}  {BCU_OFFICERS[c]:>8,d}   {sub.min():>5.0f} – {sub.max():<6.0f}")
    print(f"\nwrote {OUT}")
    print(f"source: {BCU_SOURCE}\n        {BCU_SOURCE_URL}")


if __name__ == "__main__":
    main()
