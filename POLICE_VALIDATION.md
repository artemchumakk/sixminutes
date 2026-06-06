# POLICE_VALIDATION.md — Tier B honesty

The police tier is **Tier B**: London police open data has **no incident-level response
times and no time-of-day**. So we do not — and cannot — claim validated per-incident
police response times. We validate what the data *can* support, and we are explicit about
what is anchored vs. what is proven.

Scope: **3,423,275** street crimes, **36 months** (May 2023 – Apr 2026), 2 forces
(Metropolitan + City of London), on the canonical EPSG:27700 1 km grid → **49,264** demand
rows, **128** stations scored for closure damage.

---

## 1. Demand surface — VALIDATED (predicts next year)

Same bar as the fire tier: does the past two years' crime predict this year's, per 1 km
cell? Predict-Y3 = spearman( mean(Y1,Y2) , Y3 ). Threshold to pass: **≥ 0.85**.

| category  | cells | Y1→Y2 logr | Y2→Y3 logr | **predict-Y3 spearman** |
|-----------|------:|-----------:|-----------:|------------------------:|
| all       |  2666 |      0.997 |      0.997 | **0.944** |
| violence  |  2431 |      0.993 |      0.994 | **0.939** |
| burglary  |  1589 |      0.947 |      0.947 | **0.946** |
| robbery   |  1460 |      0.951 |      0.952 | **0.919** |

Every category clears 0.85. The demand surface is **signal, not noise** — last year's
hotspots are this year's hotspots. This is the load-bearing validated claim of the tier.

## 2. Travel physics — TRANSFERRED (fire-validated), not police-validated

Police has no response times, so travel is the fire team's shared XGBoost model
(`data/travel_xgb.json`, features `[dist_m, hour, dow, month, st_idx]`), which fire
validates in `t3_counterfactual.py` against **observed second-pump arrivals**. Police
stations are not in that model, so each borrows its **nearest fire station's index** as a
local travel-physics id. We evaluate a fixed weekday-midday slice (hour=12, dow=3, month=6).
This is a transfer, stated plainly — not an independent police validation.

## 3. Absolute scale — ANCHORED to published Met aggregates, not validated

We cannot check absolute police response times per incident, so the absolute scale of the
closure-damage table is **anchored** (calibrated), not validated. The anchor:

| Met I-grade (Immediate) aggregate | value | source |
|-----------------------------------|------:|--------|
| target response                   | **900 s** (15 min) | MPS / MOPAC |
| mean response                     | **≈ 801 s** (~13 m 21 s) | MPS FOI, Jan 2019 – Jul 2024 |
| % attended within 15 min          | **≈ 85 %** (target 90 %) | MOPAC Q3 2018/19 |

T3 sets one overhead constant so the crime-weighted mean modeled response equals the
published **801 s** mean. `pushed_over_target` then counts demand a closure shoves across
the 900 s line. (Persisted in `data/processed/police_response_anchors.parquet`.)

**This anchoring does not affect the headline result.** The closure-damage *ranking* and
the call-volume *thesis* (§4) are scale-invariant — a single additive overhead cannot
change a rank order or a rank correlation.

## 4. The thesis — does call volume rank closures correctly?

Pre-registered (mirrors fire): the spreadsheet method ("just close the quiet stations")
works only if spearman(call volume, closure damage) ≈ 1. It does not.

- spearman( calls , mean_added_s )       = **+0.368**
- spearman( calls , pushed_over_target )  = **+0.543**

Both far below 0.85 → **call volume is a weak predictor of closure damage.** Concrete
quiet-but-critical inversion: **Biggin Hill** — 23.7 violence crimes/month (bottom 40% by
volume) — is the single **most damaging** closure at **+374 s mean**, while the busiest
station (Edmonton, 456/month) costs only **+108 s**. Ranking by call volume would close
exactly the wrong stations.

---

### What we claim vs. what we don't
- **Claim (validated):** crime demand is spatially predictable year-to-year (spearman 0.94).
- **Claim (scale-invariant):** closure-damage ranking, and that call volume mis-ranks it.
- **Do NOT claim:** validated absolute police response times — anchored to Met aggregates only.
