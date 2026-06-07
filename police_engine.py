"""POLICE engine — the cell-reroute closure counterfactual (Tier B parallel to sim.py).

Fire replays timestamped incidents through a queueing simulator. Police open data has NO
incident timestamps and NO response times — there is nothing to replay. So the police
"simulator" is the transferred-physics closure counterfactual already proven in
service_police.closure_damage(), here generalised from one-station-at-a-time to an
ARBITRARY closed SET:

    for every 1 km demand cell, predicted attendance from its nearest OPEN station
    (the fire-trained XGBoost travel model) — baseline vs a closure posture.

Deterministic and fast: the att(cell, station) matrix is computed ONCE at load (the only
XGBoost pass). A scenario is then a column mask + per-row min, so closing any set of
stations is effectively instant — the police analogue of sim.simulate().

Tier-B honesty (see POLICE_VALIDATION.md): travel physics is transferred from fire and the
absolute scale is anchored to the published Met I-grade mean. The closure-damage RANKING
and the city DELTAS are scale-invariant (a single additive overhead cancels in a
difference), so the counterfactual is the load-bearing, defensible output.
"""
from __future__ import annotations

import numpy as np
import polars as pl
import xgboost as xgb

from service_police import (
    PROC, FIRE_STATIONS, TRAVEL_MODEL,
    TARGET_S, MET_IGRADE_MEAN_S, TRAVEL_MAX_M, STRAND_CEIL_S,
    BNG_TO_WGS84, _wquantile,
)
from service_police_bcu import BCU_OFFICERS, BCU_SOURCE, BCU_SOURCE_URL

# police street data has no time-of-day -> a fixed weekday-midday slice (matches closure_damage)
EVAL_HOUR, EVAL_DOW, EVAL_MONTH = 12, 3, 6
PAINT_MIN_DELTA_S = 3.0     # below this a cell is "unaffected" — don't paint or list it
PAINT_MAX_CELLS = 600       # cap painted cells per scenario (keeps the map responsive)
CELL_WEIGHT_FLOOR = 0.3     # /cells heatmap: drop the long tail of near-empty cells
FAR = 9e9                   # out-of-model-range sentinel (matches closure_damage)


class PoliceWorld:
    """Loads the demand surface + estate once, precomputes attendance physics.

    Mirrors sim.World: build it at API startup, then answer scenarios cheaply.
    """

    def __init__(self) -> None:
        demand = pl.read_parquet(PROC / "police_demand.parquet").filter(pl.col("period") == "all")
        stn = (pl.read_parquet(PROC / "police_stations.parquet")
               .unique(subset="name", keep="first").sort("name"))
        if stn.height < 2:
            raise RuntimeError("need >=2 police stations (run service_police.py first)")

        # master cell list = the 'all' category (a superset of every category's cells)
        master = demand.filter(pl.col("category") == "all").sort("cell")
        if master.height == 0:
            raise RuntimeError("empty demand surface (run service_police.py first)")
        self.cells = master["cell"].to_list()
        self.gx = master["gx"].to_numpy(); self.gy = master["gy"].to_numpy()
        self.cx = self.gx.astype(np.float64) * 1000 + 500
        self.cy = self.gy.astype(np.float64) * 1000 + 500
        clon, clat = BNG_TO_WGS84.transform(self.cx, self.cy)
        self.clat = np.asarray(clat); self.clon = np.asarray(clon)
        n_cell = len(self.cells)

        # per-category crime weight (crimes/month) aligned to the master cell order; missing -> 0
        self.categories = demand["category"].unique().sort().to_list()
        pos = {c: i for i, c in enumerate(self.cells)}
        self.weights: dict[str, np.ndarray] = {}
        for cat in self.categories:
            w = np.zeros(n_cell, dtype=np.float64)
            sub = demand.filter(pl.col("category") == cat)
            for c, val in zip(sub["cell"].to_list(), sub["weight"].to_list()):
                j = pos.get(c)
                if j is not None:
                    w[j] = float(val)
            self.weights[cat] = w

        # per-period weights (Y1,Y2,Y3 yearly monthly-rates) for trend forecasting,
        # aligned to the master cell order; cells absent in a year -> 0 that year.
        full = pl.read_parquet(PROC / "police_demand.parquet")
        self.periods = ["Y1", "Y2", "Y3"]
        self.wperiod: dict[str, dict[str, np.ndarray]] = {}
        for cat in self.categories:
            per: dict[str, np.ndarray] = {}
            for p in self.periods:
                arr = np.zeros(n_cell, dtype=np.float64)
                sub = full.filter((pl.col("category") == cat) & (pl.col("period") == p))
                for c, val in zip(sub["cell"].to_list(), sub["weight"].to_list()):
                    j = pos.get(c)
                    if j is not None:
                        arr[j] = float(val)
                per[p] = arr
            self.wperiod[cat] = per

        # stations
        self.names = stn["name"].to_list()
        self.kind = stn["kind"].to_list()
        self.SE = stn["E"].to_numpy(); self.SN = stn["N"].to_numpy()
        self.sidx = {n: i for i, n in enumerate(self.names)}
        slon, slat = BNG_TO_WGS84.transform(self.SE, self.SN)
        self.slat = np.asarray(slat); self.slon = np.asarray(slon)
        n_st = len(self.names)

        # real deployment footprint by Basic Command Unit (built by service_police_bcu.py).
        # Replaces the old fake even split: "today" is anchored to each area's PUBLISHED Met
        # officer strength (12 BCUs); only the within-BCU split across stations is modelled.
        bcu_df = pl.read_parquet(PROC / "police_bcu.parquet")
        fp = {n: (f, b, bo) for n, f, b, bo in zip(bcu_df["name"].to_list(),
                                                   bcu_df["footprint"].to_list(),
                                                   bcu_df["bcu"].to_list(),
                                                   bcu_df["borough"].to_list())}
        missing = [n for n in self.names if n not in fp]
        if missing:
            raise RuntimeError(f"police_bcu.parquet missing {len(missing)} stations "
                               f"(e.g. {missing[:3]}); re-run service_police_bcu.py")
        self.footprint = np.array([fp[n][0] for n in self.names], dtype=np.float64)
        self.bcu = [fp[n][1] for n in self.names]
        self.borough = [fp[n][2] for n in self.names]
        self.footprint_total = float(self.footprint.sum())
        self.bcu_officers = dict(BCU_OFFICERS)
        self.n_bcus = len(BCU_OFFICERS)
        self.footprint_source = BCU_SOURCE
        self.footprint_source_url = BCU_SOURCE_URL

        # each police station borrows its nearest fire station's index (a valid model st_idx)
        fire = pl.read_parquet(FIRE_STATIONS)
        FE = fire["E"].to_numpy(); FN = fire["N"].to_numpy()
        borrow = (np.sqrt((self.SE[:, None] - FE[None, :]) ** 2 + (self.SN[:, None] - FN[None, :]) ** 2)
                  .argmin(axis=1).astype(np.float32))

        # the ONLY XGBoost pass: predicted attendance for every (cell, station); gate by range
        model = xgb.XGBRegressor(); model.load_model(str(TRAVEL_MODEL))
        att = np.full((n_cell, n_st), FAR, dtype=np.float64)
        CHUNK = 4000
        for c0 in range(0, n_cell, CHUNK):
            c1 = min(c0 + CHUNK, n_cell); m = c1 - c0
            d = np.sqrt((self.cx[c0:c1, None] - self.SE[None, :]) ** 2
                        + (self.cy[c0:c1, None] - self.SN[None, :]) ** 2)
            feats = np.empty((m * n_st, 5), dtype=np.float32)
            feats[:, 0] = d.ravel()
            feats[:, 1] = EVAL_HOUR; feats[:, 2] = EVAL_DOW; feats[:, 3] = EVAL_MONTH
            feats[:, 4] = np.tile(borrow, m)
            pred = model.predict(feats).reshape(m, n_st).astype(np.float64)
            pred[d > TRAVEL_MAX_M] = FAR
            att[c0:c1] = pred
        self.att = att

        # baseline: nearest station over the whole open estate
        self.home = att.argmin(axis=1)
        self.t_home = att.min(axis=1)
        self.base_reach = self.t_home < (FAR / 10)

        # absolute-scale anchor: one overhead so crime-weighted mean modeled response == Met 801s.
        # Additive -> cancels in every delta; only used to place the 900s target line.
        w_all = self.weights["all"]; m = self.base_reach
        self.overhead = (MET_IGRADE_MEAN_S - float(np.average(self.t_home[m], weights=w_all[m]))
                         if m.any() else 0.0)

    # -------------------------------------------------------------- payloads --
    def baseline_stats(self) -> dict:
        w = self.weights["all"]; m = self.base_reach
        mean_abs = float(np.average((self.t_home + self.overhead)[m], weights=w[m])) if m.any() else 0.0
        return {
            "cells": len(self.cells),
            "stations": len(self.names),
            "crimes_per_mo": round(float(w.sum()), 1),
            "mean_response_s": round(mean_abs, 1),
            "target_s": TARGET_S,
            "overhead_s": round(self.overhead, 1),
            "eval_slice": {"hour": EVAL_HOUR, "dow": EVAL_DOW, "month": EVAL_MONTH},
        }

    def cells_payload(self, category: str = "all") -> list[dict]:
        w = self.weights.get(category, self.weights["all"])
        out = []
        for i in range(len(self.cells)):
            if w[i] < CELL_WEIGHT_FLOOR:
                continue
            out.append({"cell": self.cells[i], "lat": round(float(self.clat[i]), 5),
                        "lon": round(float(self.clon[i]), 5), "weight": round(float(w[i]), 2)})
        return out

    def predict(self, lat: float, lon: float, radius_km: float = 2.0, top: int = 8) -> dict:
        """Area crime profile + naive trend forecast around (lat,lon).

        Aggregates every 1 km demand cell within radius_km; per category reports the
        current monthly rate (most recent year Y3), the 3-year trend, and a damped
        one-step projection of next month's rate. Tier-B honest: a linear extrapolation
        of 36 months of recorded street-crime counts, not a validated predictor.
        """
        R = 6371.0
        dlat = np.radians(self.clat - lat)
        dlon = np.radians(self.clon - lon)
        a = (np.sin(dlat / 2) ** 2
             + np.cos(np.radians(lat)) * np.cos(np.radians(self.clat)) * np.sin(dlon / 2) ** 2)
        dist_km = 2 * R * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))
        mask = dist_km <= radius_km
        n_cells = int(mask.sum())

        xs = np.array([1.0, 2.0, 3.0]); xc = xs - xs.mean()
        cats: list[dict] = []
        total_now = total_proj = total_36mo = 0.0
        for cat in self.categories:
            if cat == "all":
                continue
            per = self.wperiod.get(cat)
            if per is None:
                continue
            y1 = float(per["Y1"][mask].sum())
            y2 = float(per["Y2"][mask].sum())
            y3 = float(per["Y3"][mask].sum())
            if y1 + y2 + y3 <= 0:
                continue
            ys = np.array([y1, y2, y3])
            slope = float((xc * (ys - ys.mean())).sum() / (xc ** 2).sum())   # per-year change
            now = y3                                                          # latest 12-mo rate
            proj = max(0.0, now + 0.5 * slope)                               # damped, clamped
            trend_pct = (100.0 * (y3 - y1) / y1) if y1 > 0 else 0.0
            cats.append({"category": cat, "now_per_mo": round(now, 1),
                         "proj_next_mo": round(proj, 1), "trend_3y_pct": round(trend_pct, 1)})
            total_now += now; total_proj += proj
            total_36mo += (y1 + y2 + y3) * 12.0                              # monthly-rate -> 36-mo count

        cats.sort(key=lambda c: c["now_per_mo"], reverse=True)
        tot = sum(c["now_per_mo"] for c in cats) or 1.0
        for c in cats:
            c["share_pct"] = round(100.0 * c["now_per_mo"] / tot, 1)
        return {
            "center": {"lat": round(lat, 5), "lon": round(lon, 5)},
            "radius_km": round(radius_km, 2),
            "cells": n_cells,
            "sample_incidents_36mo": int(round(total_36mo)),
            "total_now_per_mo": round(total_now, 1),
            "total_proj_next_mo": round(total_proj, 1),
            "categories": cats[:top],
        }

    def allocate(self, units: int = 600) -> dict:
        """Distribute `units` response units across the estate to match crime demand.

        Each station owns the cells for which it is the baseline nearest open station
        (self.home). Two postures are compared:
          • 'today'  — the pool distributed by each area's REAL Met strength (BCU officer
                       shares). Per-station fleet counts aren't public, so only the split
                       within each BCU is modelled.
          • 'demand' — units in proportion to each catchment's crimes/month.
        Travel-time physics doesn't change with unit count, so the load-bearing metric
        is WORKLOAD BALANCE (crimes/mo per unit): today's BCU shape starves the hotspots;
        demand-weighting equalises it. Tier-B — a resourcing model, not an MPS plan.
        """
        units = int(units)
        w = self.weights["all"]; m = self.base_reach
        n_st = len(self.names)

        dem = np.zeros(n_st, dtype=np.float64)
        np.add.at(dem, self.home[m].astype(int), w[m])      # catchment crimes/mo per station
        total = float(dem.sum()) or 1.0
        # today: the pool distributed by each area's REAL Met strength (BCU shares), not a flat
        # split — the honest "current" shape to weigh demand-matching against.
        share = self.footprint / (self.footprint_total or 1.0)
        cur = units * share
        opt = units * dem / total
        cur_wl = np.where(cur > 0, dem / cur, 0.0)           # crimes/mo per unit, today's shape
        served = dem > 0
        sv = served & (cur > 0)
        imbalance = (float(cur_wl[sv].max() / max(cur_wl[sv].min(), 1e-9))
                     if sv.any() else 0.0)

        rows = [{
            "name": self.names[i], "kind": self.kind[i], "bcu": self.bcu[i],
            "borough": self.borough[i],
            "lat": round(float(self.slat[i]), 5), "lon": round(float(self.slon[i]), 5),
            "demand_per_mo": round(float(dem[i]), 1),
            "cur_units": round(float(cur[i]), 2),
            "opt_units": round(float(opt[i]), 2),
            "delta": round(float(opt[i] - cur[i]), 2),
            "cur_workload": round(float(cur_wl[i]), 1),
        } for i in range(n_st)]

        served_rows = sorted((r for r in rows if r["demand_per_mo"] > 0), key=lambda r: r["delta"])
        under = [{"name": r["name"], "add": round(r["delta"], 1),
                  "demand_per_mo": r["demand_per_mo"], "cur_workload": r["cur_workload"]}
                 for r in reversed(served_rows[-5:])]
        over = [{"name": r["name"], "spare": round(-r["delta"], 1),
                 "demand_per_mo": r["demand_per_mo"], "cur_workload": r["cur_workload"]}
                for r in served_rows[:5]]
        return {
            "units": units,
            "n_stations": n_st,
            "total_demand_per_mo": round(total, 1),
            "even_per_station": round(units / n_st, 2),
            "worst_workload_now": round(float(cur_wl[served].max()) if served.any() else 0.0, 1),
            "workload_balanced": round(total / units, 1),
            "imbalance_now": round(imbalance, 1),
            "stations": rows,
            "under_resourced": under,
            "over_resourced": over,
        }

    # ------------------------------------------------------------ next-month plan --
    def _project_cell(self, cat: str) -> tuple[np.ndarray, np.ndarray]:
        """Per-cell (now, next-month) crime rate for a category.

        now  = latest 12-month rate (Y3); next = damped one-step linear projection
        of the 3-year trend (same maths as predict(), vectorised over all cells).
        Cells with no per-year history fall back to the flat 'all'-period weight.
        """
        per = self.wperiod.get(cat)
        base = self.weights.get(cat, self.weights["all"])
        if per is None:
            return base, base
        ys = np.stack([per["Y1"], per["Y2"], per["Y3"]])          # (3, n_cell)
        xc = np.array([-1.0, 0.0, 1.0])                            # centred [1,2,3]
        slope = (xc[:, None] * (ys - ys.mean(axis=0))).sum(axis=0) / float((xc ** 2).sum())
        now = ys[2].copy()
        nxt = np.maximum(0.0, now + 0.5 * slope)                  # damped, clamped
        have = ys.sum(axis=0) > 0
        return np.where(have, now, base), np.where(have, nxt, base)

    def plan(self, units: int = 0) -> dict:
        """Plain-language redeployment plan: today's footprint vs next month's forecast.

        • today  — the REAL deployment: each area's published Met officer strength (the 12
                   Basic Command Units), spread across that BCU's stations. Per-station fleet
                   counts aren't public, so only the within-BCU split is modelled.
        • next   — the SAME total officers re-matched to each catchment's PROJECTED next-month
                   crime, rolled up per station from the 1 km cells via the nearest assignment.
        The per-station difference is the transfer: trim the over-served, reinforce the
        rising hotspots. `units` is ignored — the total is the real BCU strength. Tier-B.
        """
        m = self.base_reach
        home_m = self.home[m].astype(int)
        n_st = len(self.names)

        def rollup(cell_vals: np.ndarray) -> np.ndarray:
            out = np.zeros(n_st, dtype=np.float64)
            np.add.at(out, home_m, cell_vals[m])
            return out

        now_cell, next_cell = self._project_cell("all")
        dem_now = rollup(now_cell)
        dem_next = rollup(next_cell)

        # per-category station demand (now/next) → the dominant rising "why" per base
        cat_now: dict[str, np.ndarray] = {}
        cat_next: dict[str, np.ndarray] = {}
        for cat in self.categories:
            if cat == "all":
                continue
            nc, xc = self._project_cell(cat)
            cat_now[cat] = rollup(nc)
            cat_next[cat] = rollup(xc)

        tot_now = float(dem_now.sum()) or 1.0
        tot_next = float(dem_next.sum()) or 1.0
        units_now = self.footprint.copy()                         # today: real BCU footprint
        total_units = float(units_now.sum())                      # real total (~15,941 officers)
        units_next = total_units * dem_next / tot_next            # next: same total, demand-matched
        move = units_next - units_now

        # ---- per-BCU rollup: the FULLY-real layer. BCU officer totals are published; crime is
        # real; nothing within-BCU is modelled here. The headline imbalance and the moves the
        # panel shows live at THIS level (officers are managed per BCU, not per building).
        bcu_names = sorted(self.bcu_officers)
        bidx = {b: k for k, b in enumerate(bcu_names)}
        st_bcu = np.array([bidx[b] for b in self.bcu])
        nb = len(bcu_names)
        b_now = np.zeros(nb); b_next = np.zeros(nb)
        np.add.at(b_now, st_bcu, dem_now)
        np.add.at(b_next, st_bcu, dem_next)
        b_off_now = np.array([self.bcu_officers[b] for b in bcu_names], dtype=np.float64)
        b_off_next = total_units * b_next / tot_next
        b_move = b_off_next - b_off_now
        b_wl = np.where(b_off_now > 0, b_next / b_off_now, 0.0)    # crimes/mo per officer, by BCU
        b_served = b_next > 0
        imb_before = (float(b_wl[b_served].max() / max(b_wl[b_served].min(), 1e-9))
                      if b_served.any() else 0.0)

        def reason(i: int) -> tuple[str, float]:
            # the honest "why" is the dominant crime TYPE by volume in this catchment
            # (level, not trend — month-over-month growth is tiny and would mislead).
            if not cat_next:
                return "all", 0.0
            best = max(cat_next, key=lambda c: cat_next[c][i])
            n0, n1 = cat_now[best][i], cat_next[best][i]
            return best, round(100.0 * (n1 - n0) / n0, 1) if n0 > 0 else 0.0

        rows = []
        for i in range(n_st):
            cat, tr = reason(i)
            rows.append({
                "name": self.names[i], "kind": self.kind[i], "bcu": self.bcu[i],
                "borough": self.borough[i],
                "lat": round(float(self.slat[i]), 5), "lon": round(float(self.slon[i]), 5),
                "demand_now": round(float(dem_now[i]), 1),
                "demand_next": round(float(dem_next[i]), 1),
                "growth_pct": (round(100.0 * (dem_next[i] - dem_now[i]) / dem_now[i], 1)
                               if dem_now[i] > 0 else 0.0),
                "units_now": round(float(units_now[i]), 1),
                "units_next": round(float(units_next[i]), 1),
                "move": int(round(float(move[i]))),
                "move_raw": round(float(move[i]), 2),
                "top_category": cat,
                "top_trend_pct": tr,
            })

        movers = [r for r in rows if r["demand_next"] > 0]
        to = sorted((r for r in movers if r["move"] > 0), key=lambda r: r["move"], reverse=True)[:6]
        frm = sorted((r for r in movers if r["move"] < 0), key=lambda r: r["move"])[:6]

        # dominant crime type per BCU (the "why" behind each area's move)
        b_cat: dict[str, np.ndarray] = {}
        for cat in cat_next:
            arr = np.zeros(nb)
            np.add.at(arr, st_bcu, cat_next[cat])
            b_cat[cat] = arr
        bcus = [{
            "bcu": b,
            "officers_now": int(round(b_off_now[k])),
            "officers_next": int(round(b_off_next[k])),
            "move": int(round(b_move[k])),
            "demand_now": round(float(b_now[k]), 1),
            "demand_next": round(float(b_next[k]), 1),
            "share_pct": round(100.0 * b_next[k] / tot_next, 1),
            "growth_pct": (round(100.0 * (b_next[k] - b_now[k]) / b_now[k], 1)
                           if b_now[k] > 0 else 0.0),
            "crimes_per_officer": round(float(b_wl[k]), 1),
            "top_category": (max(b_cat, key=lambda c: b_cat[c][k]) if b_cat else "all"),
        } for k, b in enumerate(bcu_names)]
        bcus.sort(key=lambda r: r["move"], reverse=True)
        total_moved = int(sum(r["move"] for r in bcus if r["move"] > 0))

        return {
            "units": int(round(total_units)),
            "n_stations": n_st,
            "n_bcus": self.n_bcus,
            "even_per_station": round(total_units / n_st, 1),  # mean officers per base
            "total_now_per_mo": round(tot_now, 1),
            "total_next_per_mo": round(tot_next, 1),
            "growth_pct": round(100.0 * (tot_next - tot_now) / tot_now, 1) if tot_now else 0.0,
            "total_moved": total_moved,
            "imbalance_before": round(imb_before, 1),
            "footprint_real": True,
            "source": self.footprint_source,
            "source_url": self.footprint_source_url,
            "bcus": bcus,
            "stations": rows,
            "moves_to": to,
            "moves_from": frm,
        }


def scenario(world: PoliceWorld, close: list[str], category: str = "all") -> dict:
    """Close a SET of stations -> per-cell nearest-open reroute -> crime-weighted city impact.

    Returns the same SHAPE as the fire /scenario (city stats + worst list + paint set),
    but police-native: the unit is a 1 km demand cell, weighting is crimes/month, and the
    promise line is the 15-minute (900 s) Met I-grade target.
    """
    if category not in world.weights:
        category = "all"
    w = world.weights[category]
    n_st = len(world.names)

    closed_idx = [world.sidx[n] for n in close if n in world.sidx]
    open_mask = np.ones(n_st, dtype=bool)
    open_mask[closed_idx] = False

    if open_mask.all():
        t_cf = world.t_home.copy(); cf_home = world.home.copy()
    else:
        att_open = np.where(open_mask[None, :], world.att, FAR)
        cf_home = att_open.argmin(axis=1)
        t_cf = att_open.min(axis=1)

    cf_reach = t_cf < (FAR / 10)
    base_reach = world.base_reach
    t_cf_eff = np.where(cf_reach, t_cf, STRAND_CEIL_S)            # no open station in range -> stranded ceiling
    delta = np.where(base_reach, np.clip(t_cf_eff - world.t_home, 0.0, STRAND_CEIL_S), 0.0)

    oh = world.overhead
    pushed = base_reach & ((world.t_home + oh) <= TARGET_S) & ((t_cf_eff + oh) > TARGET_S)

    # crime-weighted city aggregates (weight = crimes/mo of the chosen category)
    sel = w > 0
    if sel.any() and w[sel].sum() > 0:
        mean_delta = float(np.average(delta[sel], weights=w[sel]))
        p90_delta = _wquantile(delta[sel], w[sel], 0.9)
    else:
        mean_delta = p90_delta = 0.0

    impact = delta * w                                           # crime-weighted harm per cell
    affected = np.where((delta >= PAINT_MIN_DELTA_S) & (w > 0))[0]

    worst = []
    for i in affected[np.argsort(impact[affected])[::-1]][:12]:
        near = world.names[int(cf_home[i])] if cf_reach[i] else "stranded (>15 km)"
        worst.append({
            "cell": world.cells[i],
            "lat": round(float(world.clat[i]), 5),
            "lon": round(float(world.clon[i]), 5),
            "delta_s": round(float(delta[i]), 1),
            "crimes_per_mo": round(float(w[i]), 1),
            "impact": round(float(impact[i]), 1),
            "near": near,
        })

    paint = affected[np.argsort(delta[affected])[::-1]][:PAINT_MAX_CELLS]
    cell_deltas = [{"cell": world.cells[i], "lat": round(float(world.clat[i]), 5),
                    "lon": round(float(world.clon[i]), 5), "delta_s": round(float(delta[i]), 1)}
                   for i in paint]

    return {
        "posture": {"close": list(close), "category": category},
        "city": {
            "mean_delta_s": round(mean_delta, 1),
            "p90_delta_s": round(p90_delta, 1),
            "crimes_pushed_over_target": round(float(w[pushed].sum()), 1),
            "cells_pushed_over_target": int(pushed.sum()),
            "category": category,
        },
        "worst_cells": worst,
        "cell_deltas": cell_deltas,
    }


if __name__ == "__main__":
    import time
    t0 = time.time()
    W = PoliceWorld()
    print(f"PoliceWorld loaded in {time.time()-t0:.2f}s  "
          f"({len(W.cells):,} cells x {len(W.names)} stations)")
    print("baseline:", W.baseline_stats())
    for stn in ("Biggin Hill", "Edmonton"):
        if stn in W.sidx:
            t1 = time.time()
            r = scenario(W, [stn], "violence")
            print(f"\nclose [{stn}] (violence) in {1000*(time.time()-t1):.1f}ms -> {r['city']}")
            for c in r["worst_cells"][:3]:
                print(f"    {c['cell']} near {c['near']}: +{c['delta_s']}s  ({c['crimes_per_mo']}/mo)")
