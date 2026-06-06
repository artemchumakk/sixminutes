"""Discrete-event AVAILABILITY model — fixes the 'an ambulance is always free' flaw.

The transfer experiment assumes the nearest station always has a crew ready. Reality:
each job ties a unit up for a long cycle (turnout + travel + on-scene + hospital
handover + return), so when demand is high a call must WAIT for the next free unit.
That waiting is what inflates the real p90 (734s) far above our free-flow p90 (~497s).

This module simulates a finite fleet over a week of real-shaped demand and exposes
HANDOVER time as the knob that tips the system into crisis — the A&E-queue problem.

Model (deliberately simple, documented):
  * Fleet of `total_units` ambulances, each based at a station. Units are allocated to
    stations in proportion to the real demand each station is nearest to (Voronoi share).
  * Calls arrive over `days` days; arrival times follow the LFB diurnal shape; locations
    are drawn from the real Ward-Atlas demand surface.
  * For each call we pick the unit giving the smallest RESPONSE = wait-for-free + turnout
    + Thames-aware travel. The chosen unit is then busy for
        busy = response + ON_SCENE + handover
    and becomes free again at its home station. (We fold the hospital-transport and
    return legs into ON_SCENE+handover rather than tracking hospital positions — the
    handover term dominates, and it is the lever we want to study.)

Honesty: still free of traffic-incident randomness and crew shift patterns; `total_units`
and `ON_SCENE` are calibrated so the NORMAL-handover run reproduces the real C1 mean,
then handover is raised to show the tail blow-out. The point is the *direction and
magnitude* of the availability effect, not a digit-perfect forecast.
"""
from __future__ import annotations
import numpy as np
import polars as pl
import service_ambulance as S

PROC = S.PROC
ON_SCENE = 1100.0          # seconds on scene + transport, fixed (calibration constant)
NORMAL_HANDOVER = 1500.0   # ~25 min — a functioning A&E
CRISIS_HANDOVER = 3300.0   # ~55 min — winter / corridor-care crisis
REP_HOUR = 15              # travel predicted at a representative busy hour


def _response_matrix(model, gx, gy, SE, SN):
    """turnout + Thames-aware travel from each demand cell to each station -> [n_cells, n_st]."""
    E = (gx + 0.5) * 1000.0
    N = (gy + 0.5) * 1000.0
    HR = np.full(len(E), REP_HOUR, np.float32)
    DOW = np.full(len(E), 3, np.float32); MO = np.full(len(E), 6, np.float32)
    travel = S._attendance_matrix(model, E.astype(np.float32), N.astype(np.float32),
                                  HR, DOW, MO, SE, SN)
    travel[travel > 9e8] = np.nan
    turnout = float(np.median(pl.read_parquet(S.DATA / "stations.parquet")["turnout_med"].to_numpy()))
    return travel + turnout      # response if a unit is free at its station


def _allocate_units(resp, weight, total_units):
    """Give each station a share of the fleet ∝ the demand it is the nearest station to."""
    nearest = np.nanargmin(resp, axis=1)
    n_st = resp.shape[1]
    owned = np.zeros(n_st)
    for s, w in zip(nearest, weight):
        owned[s] += w
    share = owned / owned.sum()
    units = np.maximum(1, np.round(share * total_units).astype(int))
    return units


# Calibrated so NORMAL handover reproduces the real C1 mean (~430s). ~240 double-crewed
# ambulances on shift at once is consistent with LAS's deployed-at-peak resource (the full
# roster is larger; not all are simultaneously available). This is the calibration knob.
CALIB_UNITS = 240


def simulate(total_units=CALIB_UNITS, handover=NORMAL_HANDOVER, days=7, seed=7, daily_calls=2945):
    """Run the fleet over `days` days. Returns mean/p90/over-target on REAL demand."""
    dem = pl.read_parquet(PROC / "ambulance_demand.parquet").filter(pl.col("category") == "proxy_all")
    gx = dem["gx"].to_numpy(); gy = dem["gy"].to_numpy(); w = dem["weight"].to_numpy().astype(float)
    model = S._load_travel_model()
    SE = pl.read_parquet(PROC / "ambulance_stations.parquet")["E"].to_numpy()
    SN = pl.read_parquet(PROC / "ambulance_stations.parquet")["N"].to_numpy()

    resp = _response_matrix(model, gx, gy, SE, SN)        # [n_cells, n_st]
    resp_filled = np.where(np.isfinite(resp), resp, 9e9)  # unreachable = huge
    units_per_st = _allocate_units(resp, w, total_units)

    # build a per-unit home-station index and a free-at clock
    unit_station = np.repeat(np.arange(len(SE)), units_per_st)
    free_at = np.zeros(len(unit_station))                 # seconds; 0 = free at t=0

    # generate calls: count, arrival times (diurnal shape), cell of each
    rng = np.random.default_rng(seed)
    n_calls = int(daily_calls * days)
    inc = pl.read_parquet(S.DATA / "incidents_ambulance.parquet").filter(pl.col("HourOfCall").is_not_null())
    hc = inc.group_by("HourOfCall").len().sort("HourOfCall")
    hrs = hc["HourOfCall"].to_numpy(); hp = hc["len"].to_numpy().astype(float)
    call_hour = rng.choice(hrs, size=n_calls, p=hp / hp.sum())
    call_day = rng.integers(0, days, n_calls)
    arrival = call_day * 86400.0 + call_hour * 3600.0 + rng.random(n_calls) * 3600.0
    call_cell = rng.choice(len(w), size=n_calls, p=w / w.sum())
    order = np.argsort(arrival)
    arrival = arrival[order]; call_cell = call_cell[order]

    responses = np.empty(n_calls)
    for k in range(n_calls):
        a = arrival[k]; c = call_cell[k]
        base = resp_filled[c, unit_station]               # station travel+turnout per unit
        wait = np.maximum(free_at - a, 0.0)               # how long until that unit is free
        total = wait + base                               # response if we pick this unit
        u = int(np.argmin(total))
        r = total[u]
        responses[k] = r
        free_at[u] = a + r + ON_SCENE + handover          # unit busy, then free at home base

    valid = responses < 9e8
    r = responses[valid]
    return {
        "total_units": int(total_units), "handover_min": round(handover / 60),
        "calls": int(valid.sum()),
        "mean_s": round(float(r.mean()), 1),
        "p90_s": round(float(np.percentile(r, 90)), 1),
        "pct_over_420": round(100 * float((r > S.C1_TARGET_MEAN).mean()), 1),
        "pct_over_900": round(100 * float((r > S.C1_TARGET_P90).mean()), 1),
    }


def main():
    print("== AVAILABILITY MODEL (finite fleet, real demand, Thames-aware travel) ==")
    print("Free-flow reference (always a unit free): mean≈382s p90≈497s | reality 430/734\n")
    for hv, label in [(NORMAL_HANDOVER, "NORMAL  (~25 min handover)"),
                      (CRISIS_HANDOVER, "CRISIS  (~55 min handover)")]:
        rr = simulate(handover=hv)
        print(f"  {label}: mean={rr['mean_s']}s  p90={rr['p90_s']}s  "
              f"over-420={rr['pct_over_420']}%  over-900(C1 target)={rr['pct_over_900']}%")
    print("\n== HANDOVER SWEEP (the A&E-queue lever) ==")
    for hv in (1200, 1800, 2400, 3000, 3600):
        rr = simulate(handover=float(hv))
        print(f"  handover={hv//60:>2} min -> mean={rr['mean_s']:>6}s  p90={rr['p90_s']:>6}s  "
              f"over-900={rr['pct_over_900']}%")
    print("DONE")


if __name__ == "__main__":
    main()
