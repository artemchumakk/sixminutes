# Ambulance Tier — Insights (every claim carries a number)

All findings are **Tier B**: **real** ambulance demand (GLA Ward Atlas, ~1.07M LAS incidents/yr by ward) + **transferred** fire travel physics + **real** AmbSYS response targets. Only the travel-time model and within-year timing shape are borrowed; demand and targets are real.

## 0. The demand map is now real — and it validates 🟢
Switching from the fire proxy (120k door-forcings + RTCs) to the **GLA Ward Atlas** gives **1,075,092 real LAS ambulance incidents/yr** across 584 1km cells — which matches LAS's true published volume (~1.1M/yr). The external-magnitude check passes. Re-running the transfer experiment on real demand *tightened* the C1-mean gap from −12.8% to **−11.3%**. Source: `etl_ambulance_demand.py`, `AMBULANCE_VALIDATION.md`.

## 1. Category 2 is the broken promise 🔴 (headline insight)
LAS Category-2 calls (e.g. stroke, chest pain) have an **18-minute** national mean standard.
- **Actual 2024+ mean = 33.8 minutes** (2,026s) — nearly **double** the standard.
- **Actual 2024+ p90 = 72.7 minutes** (4,360s) vs a 40-minute standard.
- Worst single month on record: **December 2022 = 83.5 minutes** mean (the winter NHS pressure crisis), followed by March 2020 (61.4 min, first COVID wave). The promise breaks hardest under seasonal pressure.
Source: `data/processed/las_targets.parquet` (AmbSYS, Org Code RRU).

## 2. The transfer gap *was* the cost of availability — now proven 🔴
A free-flow travel model (fire physics + LAS stations + real demand, zero tuning) predicts C1 mean **382s / p90 497s** vs reality **430s / 734s** — it nails the *travel* but under-shoots, because it assumes a unit is always free. The **availability model** (`ambulance_availability.py`, finite ~240-unit fleet, queueing) closes it: with **normal handover the simulated mean = 428.8s ≈ real 430s**, and **p90 reaches the real 734s only at crisis-level (~55 min) handover** (726.6s). So the entire free-flow shortfall was the availability/handover effect — now reproduced, not just asserted. The handover sweep is a **non-linear cliff**: 20→60 min handover drives p90 **572→1222s** and calls breaching the 900s C1 target **0%→16%**. Hospital handover delay is the dominant lever.
Source: `AMBULANCE_VALIDATION.md` (availability table), `ambulance_availability.py`.

## 3. Closure damage inverts the "busy = important" assumption
The most damaging C1-coverage closures are **outer/suburban** stations with sparse neighbours, not the busiest central ones — and this **holds on real demand** (re-run, barely moved):
- **Coulsdon (+228s mean), Barnehurst (+196s), New Addington (+179s), St Pauls Cray (+167s), Becontree (+166s)** — closing these most degrades response, because the next-nearest base is far. Becontree alone tips **494** simulated calls past the C1 mean standard; **20,834** calls total are pushed over standard across all closures.
- Depots / specialist bases are near-free to lose (Walton and unnamed depots, <20s added).
**Implication:** a call-volume-based closure spreadsheet would protect the wrong stations — same inversion the fire tier found, now confirmed with real ambulance demand.
Source: `data/processed/ambulance_damage.parquet`.

## 4. Predictive posture engine (`ambulance_posture.py`) — "reposition standby, not stations"
The same validated engine now drives three live scenarios. All times are free-flow (optimistic, no queueing) so we operate on the **420s C1 mean standard** and read the **deltas** as the signal.
All re-run on **real demand**. Note: real ward demand has no per-hour split, so the time-of-day signal is now driven by **travel speed (traffic) by hour**, not by demand moving — the demand map is real and stable; congestion is what shifts.
- **Standby posture:** % of demand over the 420s standard rises from **31.8% (03:00) → 43.2% (15:00)** as daytime traffic slows travel. Under-served hot cells cluster on the outer east/north-west fringe (E551/E554, ~Romford/Harrow approaches). → park idle units toward the under-covered fringe, more so at busy hours.
- **Handover drain (Royal London ties up 6 ambulances):** mean response **409→420s**, **28 cells lose the C1 standard** (61,630 real demand exposed). The single best standby relocation (→ cell E534_N184) claws back ~6 of the ~11 lost seconds. → the A&E-queue crisis, simulated.
- **Winter surge (15% of units tied up in handovers):** mean **370.3 → 382.0s**, demand-over-standard **29.1% → 34.2%**; adding **5 optimally-placed standby units** recovers to **363.4s / 28.5%**. → a quantified pre-winter posture playbook.
Source: `ambulance_posture.py`.

## Candidate follow-ups (not yet done)
- "Same street, two safety nets": cells where fire's 6-min promise holds but predicted ambulance response is worst.
- LAS stations within 500m of a fire station → joint-coverage / co-location argument.
- **Finer-than-ward resolution:** overlay STATS19 road-collision coordinates (incident-level, with Easting/Northing) to sub-divide ward demand where RTCs cluster — the one place real point data exists.
- ✅ ~~Correlate demand proxy vs GLA Ward Atlas~~ — done: the Ward Atlas *is* the demand now (replaced the proxy).
