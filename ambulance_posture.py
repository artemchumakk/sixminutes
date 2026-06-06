"""Ambulance predictive-posture engine (the playbook, built out).

Three capabilities, all on the SAME validated engine (borrowed fire physics +
demand proxy + station list). Everything is Tier B-: modeled proxy, not live data.

  1. standby_posture(bucket)  — where idle units should wait, BY TIME OF DAY
  2. handover_drain(...)      — "Hospital X swallowed N ambulances" → who loses C1, best patch
  3. winter_surge(...)        — chronic handover backlog → coverage hit + posture recovery

Reuses service_ambulance internals (model loader, attendance matrix, conventions).
"""
from __future__ import annotations
import numpy as np
import polars as pl
import service_ambulance as S

PROC = S.PROC
# Operate at the 420s C1 MEAN standard. The free-flow sim tops out ~675s, so the 900s p90
# target is never reached — the real signals are (a) breaches of the 420s mean standard and
# (b) the mean/p90 *deltas* a scenario causes (those are robust regardless of absolute level).
TARGET = S.C1_TARGET_MEAN  # 420s

# hour-of-day buckets and a representative hour for each
BUCKETS = {"night": (0, 6), "am": (6, 12), "pm": (12, 18), "eve": (18, 24)}
BUCKET_HOUR = {"night": 3, "am": 9, "pm": 15, "eve": 21}

# major London A&Es (handover hotspots), WGS84 lon/lat
HOSPITALS = {
    "Royal London (Whitechapel)": (-0.0590, 51.5190),
    "St Thomas' (Lambeth)":       (-0.1188, 51.4989),
    "King's College (Denmark Hill)": (-0.0942, 51.4685),
    "St George's (Tooting)":      (-0.1750, 51.4267),
    "Northwick Park (Harrow)":    (-0.3210, 51.5790),
    "Queen's (Romford)":          (0.1790, 51.5690),
}


# ---------- shared helpers ----------
def _model():
    return S._load_travel_model()

def _stations():
    st = pl.read_parquet(PROC / "ambulance_stations.parquet")
    return st["name"].to_list(), st["E"].to_numpy(), st["N"].to_numpy()

def _turnout_const() -> float:
    fs = pl.read_parquet(S.DATA / "stations.parquet")
    return float(np.median(fs["turnout_med"].to_numpy()))

def _hospital_bng(name):
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    lon, lat = HOSPITALS[name]
    e, n = tr.transform(lon, lat)
    return float(e), float(n)

def _wpct(vals, w, q):
    o = np.argsort(vals); v = vals[o]; cw = np.cumsum(w[o])
    return float(v[np.searchsorted(cw, q * cw[-1])])

def _cells(df):
    """cell df (gx,gy,weight) -> centroid points + weights (BNG metres)."""
    gx = df["gx"].to_numpy(); gy = df["gy"].to_numpy(); w = df["weight"].to_numpy().astype(float)
    E = (gx + 0.5) * 1000.0; N = (gy + 0.5) * 1000.0
    return E.astype(np.float32), N.astype(np.float32), w, gx, gy


# ---------- core coverage engine ----------
def coverage(E, N, w, SEa, SNa, hour, model, turnout):
    """Demand-weighted response if only stations (SEa,SNa) are active at `hour`."""
    n = len(E)
    HR = np.full(n, hour, np.float32); DOW = np.full(n, 3, np.float32); MO = np.full(n, 6, np.float32)
    att = S._attendance_matrix(model, E, N, HR, DOW, MO, SEa, SNa)
    att[att > 9e8] = np.nan
    best = np.nanmin(att, axis=1) + turnout
    fin = np.isfinite(best)
    bb, ww = best[fin], w[fin]
    return {
        "mean_s": round(float(np.sum(bb * ww) / np.sum(ww)), 1),
        "p90_s": round(_wpct(bb, ww, 0.9), 1),
        "pct_over_target": round(100 * float(np.sum(ww[bb > TARGET]) / np.sum(ww)), 1),
    }, best


# ---------- 1. time-of-day demand + standby posture ----------
def _lfb_hour_shares() -> dict:
    """City-wide fraction of emergencies in each time-of-day bucket, from LFB call hours.
    Used as a TEMPORAL prior only — the WHERE is now real ambulance demand (Ward Atlas),
    but the Ward Atlas has no hour-of-day, so we borrow the diurnal SHAPE from LFB."""
    inc = pl.read_parquet(S.DATA / "incidents_ambulance.parquet").filter(
        pl.col("HourOfCall").is_not_null())
    bucket_expr = (
        pl.when(pl.col("HourOfCall") < 6).then(pl.lit("night"))
        .when(pl.col("HourOfCall") < 12).then(pl.lit("am"))
        .when(pl.col("HourOfCall") < 18).then(pl.lit("pm"))
        .otherwise(pl.lit("eve")))
    g = inc.with_columns(bucket=bucket_expr).group_by("bucket").agg(n=pl.len())
    tot = float(g["n"].sum()) or 1.0
    return {r["bucket"]: r["n"] / tot for r in g.iter_rows(named=True)}


def demand_by_hour() -> pl.DataFrame:
    """REAL per-cell ambulance demand split into time-of-day buckets.
    Spatial weights = Ward Atlas real incidents (proxy_all); the night/am/pm/eve split
    applies the city-wide LFB diurnal shape (documented temporal prior)."""
    dem = pl.read_parquet(PROC / "ambulance_demand.parquet").filter(
        pl.col("category") == "proxy_all")
    share = _lfb_hour_shares()
    frames = []
    for b in ("night", "am", "pm", "eve"):
        frames.append(dem.select(
            bucket=pl.lit(b), gx="gx", gy="gy",
            weight=(pl.col("weight") * share.get(b, 0.0)),
            cell="cell"))
    out = pl.concat(frames).filter(pl.col("weight") > 0)
    out.write_parquet(PROC / "ambulance_demand_by_hour.parquet")
    return out


def standby_posture(bucket="pm", top=8):
    """Where idle ambulances should wait at this time of day: hot demand that is
    currently *under-served* (far from the nearest base) → park a spare unit there."""
    dbh = demand_by_hour().filter(pl.col("bucket") == bucket)
    E, N, w, gx, gy = _cells(dbh)
    names, SE, SN = _stations(); model = _model(); turn = _turnout_const()
    stats, best = coverage(E, N, w, SE, SN, BUCKET_HOUR[bucket], model, turn)
    shortfall = np.maximum(best - TARGET, 0)            # seconds over the 15-min C1 standard
    score = w * shortfall                               # under-served demand
    order = np.argsort(score)[::-1][:top]
    recs = [{"cell": f"E{int(gx[i])}_N{int(gy[i])}", "demand": int(w[i]),
             "cur_response_s": round(float(best[i]), 0)} for i in order if score[i] > 0]
    return {"bucket": bucket, "rep_hour": BUCKET_HOUR[bucket], "coverage": stats,
            "total_demand": int(w.sum()), "standby_here": recs}


# ---------- 2. handover-drain scenario ----------
def handover_drain(hospital="Royal London (Whitechapel)", n_units=6, bucket="pm"):
    """Hospital A&E ties up N ambulances → which cells lose their C1 promise, and
    the single best standby relocation to patch the worst hole."""
    dem = pl.read_parquet(PROC / "ambulance_demand.parquet").filter(pl.col("category") == "proxy_all")
    E, N, w, gx, gy = _cells(dem)
    names, SE, SN = _stations(); model = _model(); turn = _turnout_const()
    hour = BUCKET_HOUR[bucket]
    base, best0 = coverage(E, N, w, SE, SN, hour, model, turn)

    hx, hy = _hospital_bng(hospital)
    dist = np.sqrt((SE - hx) ** 2 + (SN - hy) ** 2)
    drained = np.argsort(dist)[:n_units]               # nearest N stations "stuck at A&E"
    keep = np.array([i for i in range(len(SE)) if i not in set(drained.tolist())])
    after, best1 = coverage(E, N, w, SE[keep], SN[keep], hour, model, turn)

    newly = (best0 <= TARGET) & (best1 > TARGET)        # cells that lose the promise
    exposed_demand = int(w[newly].sum())
    # best patch: add ONE standby unit at the exposed cell that most lowers the post-drain mean
    cand = np.argsort(w * newly)[::-1][:25]
    best_patch, best_mean = None, after["mean_s"]
    for i in cand:
        if not newly[i]:
            continue
        SEp = np.append(SE[keep], E[i]); SNp = np.append(SN[keep], N[i])
        st, _ = coverage(E, N, w, SEp, SNp, hour, model, turn)
        if st["mean_s"] < best_mean:
            best_mean, best_patch = st["mean_s"], f"E{int(gx[i])}_N{int(gy[i])}"
    return {"hospital": hospital, "units_stuck": n_units, "bucket": bucket,
            "baseline": base, "during_drain": after,
            "newly_exposed_cells": int(newly.sum()), "exposed_demand": exposed_demand,
            "best_patch_cell": best_patch, "patched_mean_s": round(best_mean, 1)}


# ---------- 3. winter surge playbook ----------
def winter_surge(stuck_frac=0.15, n_standby=5, bucket="eve"):
    """Winter = chronic handover backlog ties up a fraction of units citywide.
    Show the coverage hit, then how many standby units claw back the most."""
    dem = pl.read_parquet(PROC / "ambulance_demand.parquet").filter(pl.col("category") == "proxy_all")
    E, N, w, gx, gy = _cells(dem)
    names, SE, SN = _stations(); model = _model(); turn = _turnout_const()
    hour = BUCKET_HOUR[bucket]
    base, _ = coverage(E, N, w, SE, SN, hour, model, turn)

    rng = np.random.default_rng(42)
    n_stuck = max(1, int(len(SE) * stuck_frac))
    stuck = rng.choice(len(SE), n_stuck, replace=False)
    keep = np.array([i for i in range(len(SE)) if i not in set(stuck.tolist())])
    surge_peak, best1 = coverage(E, N, w, SE[keep], SN[keep], hour, model, turn)

    # greedily add standby units where they help the weighted mean most
    SEk, SNk = SE[keep].copy(), SN[keep].copy()
    recovered, added = surge_peak, []
    for _ in range(n_standby):
        shortfall = np.maximum(best1 - TARGET, 0); score = w * shortfall
        cand = np.argsort(score)[::-1][:20]; bestm, pick = recovered["mean_s"], None
        for i in cand:
            st, _ = coverage(E, N, w, np.append(SEk, E[i]), np.append(SNk, N[i]), hour, model, turn)
            if st["mean_s"] < bestm:
                bestm, pick = st["mean_s"], i
        if pick is None:
            break
        SEk, SNk = np.append(SEk, E[pick]), np.append(SNk, N[pick])
        added.append(f"E{int(gx[pick])}_N{int(gy[pick])}")
        recovered, best1 = coverage(E, N, w, SEk, SNk, hour, model, turn)
    return {"bucket": bucket, "stuck_fraction_pct": int(stuck_frac * 100), "units_stuck": int(n_stuck),
            "normal": base, "surge_peak": surge_peak, "standby_added": added,
            "recovered_to": recovered}


def main():
    print("== 1. STANDBY POSTURE (night vs midday) ==")
    for b in ("night", "pm"):
        r = standby_posture(b)
        print(f"  {b:5} hour~{r['rep_hour']:>2}  demand={r['total_demand']:>5}  "
              f"mean={r['coverage']['mean_s']}s  over-target={r['coverage']['pct_over_target']}%  "
              f"top standby cells: {[x['cell'] for x in r['standby_here'][:3]]}")
    print("\n== 2. HANDOVER DRAIN (Royal London, 6 units) ==")
    h = handover_drain()
    print(f"  baseline mean={h['baseline']['mean_s']}s p90={h['baseline']['p90_s']}s  "
          f"-> during drain mean={h['during_drain']['mean_s']}s p90={h['during_drain']['p90_s']}s")
    print(f"  cells losing C1 promise: {h['newly_exposed_cells']} ({h['exposed_demand']} demand)  "
          f"best patch -> {h['best_patch_cell']} (mean back to {h['patched_mean_s']}s)")
    print("\n== 3. WINTER SURGE (15% of units stuck) ==")
    w = winter_surge()
    print(f"  normal     mean={w['normal']['mean_s']}s over={w['normal']['pct_over_target']}%")
    print(f"  surge peak mean={w['surge_peak']['mean_s']}s over={w['surge_peak']['pct_over_target']}%  (15% of units tied up)")
    print(f"  recovered  mean={w['recovered_to']['mean_s']}s over={w['recovered_to']['pct_over_target']}%  "
          f"(+{len(w['standby_added'])} standby units)")
    print("DONE")


if __name__ == "__main__":
    main()
