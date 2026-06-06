"""SIXMINUTES discrete-event simulator.

Replays real London incidents (2024+) through a counterfactual station posture:
sampled turnout (empirical, per station x hour-band) + predicted travel (fire-learned
XGBoost) + residual noise (empirical, per distance band) + pump busy-tracking
(queueing). Fleet sizes and job durations are derived from the data itself.

Usage:
  python sim.py --validate                 # real posture vs actual 2025 ground truth
  python sim.py --close "Biggin Hill"      # closure counterfactual vs baseline
  python sim.py --sweep                    # all-station closure sweep -> parquet
"""
from __future__ import annotations

import argparse
import heapq
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import polars as pl
import xgboost as xgb

DATA = Path(__file__).parent / "data"
METRICS: dict[str, float] = {"rate": 0.0, "secs": 0.0}
RNG = np.random.default_rng(14)
CAND = 8            # candidate stations considered per incident
MAX_DIST = 15_000   # travel-model validity radius (m)


@dataclass(frozen=True)
class Posture:
    closed: frozenset[str] = field(default_factory=frozenset)
    pump_delta: dict[str, int] = field(default_factory=dict)  # station -> +/- pumps


class World:
    """Immutable calibration state loaded once; simulations are cheap after."""

    def __init__(self) -> None:
        t0 = time.time()
        self.stations = pl.read_parquet(DATA / "stations.parquet").sort("DeployedFromStation_Name")
        self.names: list[str] = self.stations["DeployedFromStation_Name"].to_list()
        self.sidx = {s: i for i, s in enumerate(self.names)}
        self.SE = self.stations["E"].to_numpy()
        self.SN = self.stations["N"].to_numpy()

        self.model = xgb.XGBRegressor()
        self.model.load_model(str(DATA / "travel_xgb.json"))

        mob = pl.read_parquet(DATA / "mobilisations.parquet")
        first = mob.filter(
            (pl.col("PumpOrder") == 1) & pl.col("DateAndTimeMobilised").is_not_null()
        )

        # --- incident universe: 2024+ with coords, joined to exact mobilised ts ---
        ts = first.group_by("IncidentNumber").agg(
            t0=pl.col("DateAndTimeMobilised").min()
        )
        inc = (
            pl.read_parquet(DATA / "incidents.parquet")
            .filter((pl.col("CalYear") >= 2024) & pl.col("Easting_rounded").is_not_null())
            .join(ts, on="IncidentNumber", how="inner")
            .sort("t0")
            .with_columns(
                dow=pl.col("t0").dt.weekday(),
                month=pl.col("t0").dt.month(),
                hour=pl.col("t0").dt.hour(),
                epoch=(pl.col("t0").cast(pl.Int64) // 1_000_000),  # seconds
                job_s=(
                    (pl.col("PumpMinutesRounded") / pl.col("NumPumpsAttending"))
                    .clip(10, 240) * 60
                ).fill_null(45 * 60),
            )
        )
        self.inc = inc
        n = inc.height

        # --- empirical turnout pools: (station, hourband) -> samples ---
        tb = (
            first.filter(pl.col("TurnoutTimeSeconds").is_between(10, 600))
            .with_columns(hb=pl.col("HourOfCall") // 6)
            .group_by(["DeployedFromStation_Name", "hb"])
            .agg(pool=pl.col("TurnoutTimeSeconds"))
        )
        self.turnout: dict[tuple[int, int], np.ndarray] = {}
        for r in tb.iter_rows(named=True):
            i = self.sidx.get(r["DeployedFromStation_Name"])
            if i is not None:
                self.turnout[(i, r["hb"])] = np.asarray(r["pool"], dtype=np.float32)
        self._turnout_global = first["TurnoutTimeSeconds"].drop_nulls().to_numpy().astype(np.float32)

        # --- fleet size: distinct pump callsigns per home station (data-derived) ---
        fleet = (
            first.filter(pl.col("DeployedFromLocation") == "Home Station")
            .group_by("DeployedFromStation_Name")
            .agg(k=pl.col("Resource_Code").n_unique())
        )
        self.pumps = np.ones(len(self.names), dtype=np.int32)
        for r in fleet.iter_rows(named=True):
            i = self.sidx.get(r["DeployedFromStation_Name"])
            if i is not None:
                self.pumps[i] = int(np.clip(r["k"], 1, 3))

        # --- predicted travel matrix M[n, n_st] (chunked, like t3) ---
        E = inc["Easting_rounded"].to_numpy()
        N = inc["Northing_rounded"].to_numpy()
        HR, DW, MO = (inc[c].to_numpy() for c in ("hour", "dow", "month"))
        n_st = len(self.names)
        self.M = np.empty((n, n_st), dtype=np.float32)
        for s0 in range(0, n, 50_000):
            s1 = min(s0 + 50_000, n)
            d = np.sqrt((E[s0:s1, None] - self.SE[None, :]) ** 2 + (N[s0:s1, None] - self.SN[None, :]) ** 2)
            m = s1 - s0
            f = np.empty((m * n_st, 5), dtype=np.float32)
            f[:, 0] = d.ravel()
            f[:, 1] = np.repeat(HR[s0:s1], n_st)
            f[:, 2] = np.repeat(DW[s0:s1], n_st)
            f[:, 3] = np.repeat(MO[s0:s1], n_st)
            f[:, 4] = np.tile(np.arange(n_st, dtype=np.float32), m)
            pred = self.model.predict(f).reshape(m, n_st)
            pred[d > MAX_DIST] = np.float32(9e9)
            self.M[s0:s1] = pred
        self.cand = np.argsort(self.M, axis=1)[:, :CAND].astype(np.int32)

        # --- residual pools per distance band (travel noise, empirical) ---
        legs = (
            first.filter(
                (pl.col("DeployedFromLocation") == "Home Station")
                & pl.col("TravelTimeSeconds").is_between(30, 1800)
            )
            .join(pl.read_parquet(DATA / "incidents.parquet").select(
                "IncidentNumber", "Easting_rounded", "Northing_rounded"), on="IncidentNumber")
            .drop_nulls(["Easting_rounded", "Northing_rounded"])
            .sample(n=120_000, seed=7, shuffle=True)
        )
        st_lookup = self.stations.select(
            pl.col("DeployedFromStation_Name"), pl.col("E").alias("SE"), pl.col("N").alias("SN"))
        legs = legs.join(st_lookup, on="DeployedFromStation_Name", how="inner").with_columns(
            dist_m=((pl.col("Easting_rounded") - pl.col("SE")) ** 2
                    + (pl.col("Northing_rounded") - pl.col("SN")) ** 2).sqrt(),
            dow=pl.col("DateAndTimeMobilised").dt.weekday(),
            month=pl.col("DateAndTimeMobilised").dt.month(),
        ).filter(pl.col("dist_m").is_between(50, MAX_DIST)).with_columns(
            st_i=pl.col("DeployedFromStation_Name").replace_strict(self.sidx, default=-1))
        Xl = legs.select("dist_m", "HourOfCall", "dow", "month", "st_i").to_numpy().astype(np.float32)
        res = legs["TravelTimeSeconds"].to_numpy().astype(np.float32) - self.model.predict(Xl)
        self.res_pools: list[np.ndarray] = []
        self.res_edges = np.array([0, 1000, 2000, 4000, MAX_DIST], dtype=np.float32)
        for lo, hi in zip(self.res_edges[:-1], self.res_edges[1:]):
            m = (Xl[:, 0] >= lo) & (Xl[:, 0] < hi)
            self.res_pools.append(res[m] if m.sum() > 500 else res)

        print(f"[world] {n:,} incidents · {n_st} stations · {int(self.pumps.sum())} pumps "
              f"· loaded in {time.time()-t0:.1f}s")

    # ---- common-random-number sampling ------------------------------------
    # Draws are a pure function of (incident, station, salt, seed): closing a
    # station leaves every other draw bit-identical, so counterfactual deltas
    # are pure signal (any distant nonzero delta = a REAL queueing knock-on).
    @staticmethod
    def u01(a: int, b: int, salt: int, seed: int) -> float:
        x = (a * 0x9E3779B1 ^ b * 0x85EBCA77 ^ salt * 0xC2B2AE3D ^ seed * 0x27D4EB2F) & 0xFFFFFFFF
        x ^= x >> 16; x = (x * 0x7FEB352D) & 0xFFFFFFFF
        x ^= x >> 15; x = (x * 0x846CA68B) & 0xFFFFFFFF
        x ^= x >> 16
        return x / 4294967296.0

    def sample_turnout(self, st_i: int, hour: int, gi: int, seed: int) -> float:
        pool = self.turnout.get((st_i, hour // 6))
        if pool is None or len(pool) < 30:
            pool = self._turnout_global
        return float(pool[int(self.u01(gi, st_i, 1, seed) * len(pool))])

    def sample_residual(self, dist: float, st_i: int, gi: int, seed: int) -> float:
        b = int(np.searchsorted(self.res_edges[1:-1], dist))
        pool = self.res_pools[b]
        return float(pool[int(self.u01(gi, st_i, 2, seed) * len(pool))])


def simulate(w: World, posture: Posture, year: int | None = None,
             sample: int | None = None, seed: int = 14,
             p_unavail: float = 0.0) -> pl.DataFrame:
    """Event-driven replay. Returns [IncidentNumber, sim_att_s, waited_s, station].

    p_unavail: prob a candidate station can't take the call (training, standby
    moves, out-positioning) — the single calibration knob, fit on 2024 only.
    """
    rng = np.random.default_rng(seed)
    inc = w.inc if year is None else w.inc.filter(pl.col("t0").dt.year() == year)
    idxs = np.arange(w.inc.height)
    if year is not None:
        idxs = idxs[(w.inc["t0"].dt.year() == year).to_numpy()]
    if sample is not None and len(idxs) > sample:
        keep = np.sort(rng.choice(len(idxs), sample, replace=False))
        idxs = idxs[keep]
        inc = w.inc[idxs.tolist()]

    closed = np.zeros(len(w.names), dtype=bool)
    for s in posture.closed:
        if s in w.sidx:
            closed[w.sidx[s]] = True
    pumps = w.pumps.copy()
    for s, d in posture.pump_delta.items():
        if s in w.sidx:
            pumps[w.sidx[s]] = max(0, pumps[w.sidx[s]] + d)
    pumps[closed] = 0

    # per-station min-heap of pump-free-at epochs
    free: list[list[float]] = [[0.0] * int(k) for k in pumps]
    for f in free:
        heapq.heapify(f)

    epochs = inc["epoch"].to_numpy()
    hours = inc["hour"].to_numpy()
    jobs = inc["job_s"].to_numpy()
    out_att = np.empty(len(idxs), dtype=np.float32)
    out_wait = np.zeros(len(idxs), dtype=np.float32)
    out_st = np.empty(len(idxs), dtype=np.int32)

    t_start = time.time()
    for k in range(len(idxs)):
        gi = idxs[k]
        t = float(epochs[k])
        best_att, best_j, best_wait = np.float32(9e9), -1, 0.0
        for attempt in (0, 1):  # pass 0: with outages; pass 1: everyone out -> ignore outages
            for j in w.cand[gi]:
                if pumps[j] == 0:
                    continue
                base = w.M[gi, j]
                if base > 8e8:
                    continue
                if attempt == 0 and p_unavail > 0.0 and w.u01(gi, int(j), 3, seed) < p_unavail:
                    continue  # candidate out: training / standby move / out-positioned
                wait = max(0.0, free[j][0] - t)
                turnout = w.sample_turnout(int(j), int(hours[k]), int(gi), seed)
                travel = max(30.0, float(base) + w.sample_residual(float(base), int(j), int(gi), seed))
                att = wait + turnout + travel
                if att < best_att:
                    best_att, best_j, best_wait = att, int(j), wait
            if best_j >= 0:
                break
        if best_j < 0:  # nothing within validity radius (rare) -> worst candidate anyway
            j = int(w.cand[gi][0])
            best_j, best_att, best_wait = j, float(w.M[gi].min()) + 120.0, 0.0
        # pump busy until: arrival (t + wait + turnout + travel = t + att) + job time
        heapq.heapreplace(free[best_j], t + best_att + float(jobs[k]))
        out_att[k] = best_att
        out_wait[k] = best_wait
        out_st[k] = best_j
    dt = time.time() - t_start

    res = pl.DataFrame({
        "IncidentNumber": inc["IncidentNumber"],
        "actual_s": inc["FirstPumpArriving_AttendanceTime"],
        "sim_s": out_att,
        "waited_s": out_wait,
        "station": [w.names[i] for i in out_st],
        "ward": inc["IncGeo_WardName"],
        "borough": inc["IncGeo_BoroughName"],
    })
    METRICS["rate"] = len(idxs) / dt
    METRICS["secs"] = dt
    print(f"[sim] {len(idxs):,} incidents in {dt:.2f}s = {len(idxs)/dt:,.0f} incidents/sec "
          f"(queued waits on {(out_wait>0).mean():.1%} of calls)")
    return res


def stats(df: pl.DataFrame, col: str) -> tuple[float, float, float]:
    s = df[col].drop_nulls()
    return float(s.mean()), float(s.median()), float(s.quantile(0.9))


def calibrate(w: World) -> float:
    """Fit p_unavail on 2024 (train year) to close the mean gap. 2025 stays held out."""
    best_p, best_gap = 0.0, 9e9
    for p in (0.0, 0.1, 0.2, 0.3, 0.4):
        r = simulate(w, Posture(), year=2024, sample=60_000, seed=7, p_unavail=p)
        b = r.drop_nulls(["actual_s"])
        gap = abs(float(b["sim_s"].mean()) - float(b["actual_s"].mean()))
        print(f"  [calib 2024] p_unavail={p:.2f} -> mean gap {gap:5.1f}s")
        if gap < best_gap:
            best_p, best_gap = p, gap
    print(f"  [calib] chosen p_unavail={best_p:.2f}")
    return best_p


def cmd_validate(w: World) -> None:
    p = calibrate(w)
    res = simulate(w, Posture(), year=2025, p_unavail=p)
    both = res.drop_nulls(["actual_s"])
    am, ap50, ap90 = stats(both, "actual_s")
    sm, sp50, sp90 = stats(both, "sim_s")
    print("\n== VALIDATION: simulated real posture vs ACTUAL first-pump, 2025 ==")
    print(f"  n = {both.height:,}")
    print(f"  mean   actual {am:6.1f}s | sim {sm:6.1f}s | gap {100*(sm-am)/am:+.1f}%")
    print(f"  median actual {ap50:6.1f}s | sim {sp50:6.1f}s | gap {100*(sp50-ap50)/ap50:+.1f}%")
    print(f"  p90    actual {ap90:6.1f}s | sim {sp90:6.1f}s | gap {100*(sp90-ap90)/ap90:+.1f}%")
    within = float((both["sim_s"] - both["actual_s"]).abs().le(120).mean())
    print(f"  |sim-actual| <= 120s on {within:.1%} of incidents")
    Path("docs").mkdir(exist_ok=True)
    Path("docs/validation.md").write_text(
        f"# Simulator validation (2025 replay, real posture)\n\n"
        f"| metric | actual | simulated | gap |\n|---|---|---|---|\n"
        f"| mean | {am:.1f}s | {sm:.1f}s | {100*(sm-am)/am:+.1f}% |\n"
        f"| median | {ap50:.1f}s | {sp50:.1f}s | {100*(sp50-ap50)/ap50:+.1f}% |\n"
        f"| p90 | {ap90:.1f}s | {sp90:.1f}s | {100*(sp90-ap90)/ap90:+.1f}% |\n\n"
        f"n={both.height:,} · throughput {METRICS['rate']:,.0f} incidents/sec\n")
    print("  -> docs/validation.md written")


def cmd_close(w: World, names: list[str]) -> None:
    base = simulate(w, Posture(), year=2025, seed=14)
    cf = simulate(w, Posture(closed=frozenset(names)), year=2025, seed=14)
    j = base.select("IncidentNumber", base_s=pl.col("sim_s")).join(
        cf.select("IncidentNumber", "sim_s", "ward"), on="IncidentNumber")
    delta = j.with_columns(d=pl.col("sim_s") - pl.col("base_s"))
    print(f"\n== CLOSURE {names} (vs baseline, same seed) ==")
    print(f"  city mean +{float(delta['d'].mean()):.1f}s | p90 +{float(delta['d'].quantile(0.9)):.1f}s")
    worst = (delta.group_by("ward").agg(d=pl.col("d").mean(), n=pl.len())
             .filter(pl.col("n") >= 30).sort("d", descending=True).head(8))
    for r in worst.iter_rows(named=True):
        print(f"    {r['ward']:<28} +{r['d']:6.1f}s  (n={r['n']})")


def cmd_sweep(w: World) -> None:
    base = simulate(w, Posture(), year=2025, sample=40_000, seed=14)
    rows = []
    for s in w.names:
        cf = simulate(w, Posture(closed=frozenset([s])), year=2025, sample=40_000, seed=14)
        delta = (cf["sim_s"] - base["sim_s"]).to_numpy()
        mine = (base["station"] == s).to_numpy()          # incidents this station served at baseline
        local = float(delta[mine].mean()) if mine.any() else 0.0
        pushed = int(((cf["sim_s"] > 360) & (base["sim_s"] <= 360)).sum())
        rows.append({
            "station": s,
            "served_baseline": int(mine.sum()),
            "local_added_s": local,                        # damage where it actually lands
            "city_added_s": float(delta.mean()),           # context
            "pushed_past_6min": pushed,
        })
        print(f"  {s:<22} local +{local:6.1f}s  city +{float(delta.mean()):4.1f}s  pushed {pushed}")
    out = pl.DataFrame(rows).sort("local_added_s", descending=True)
    Path("data/processed").mkdir(parents=True, exist_ok=True)
    out.write_parquet("data/processed/fire_damage_v2.parquet")
    print("-> data/processed/fire_damage_v2.parquet")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--close", type=str, default=None, help="comma-separated station names")
    ap.add_argument("--sweep", action="store_true")
    a = ap.parse_args()
    world = World()
    if a.validate:
        cmd_validate(world)
    if a.close:
        cmd_close(world, [s.strip() for s in a.close.split(",")])
    if a.sweep:
        cmd_sweep(world)
    if not (a.validate or a.close or a.sweep):
        cmd_validate(world)
