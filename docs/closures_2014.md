# The 2014 Experiment — re-litigating the LSP5 station closures

**Data-derived closure list (no Wikipedia):** Clerkenwell, Westminster, Southwark, Belsize, Kingsland, Knightsbridge, Downham, Woolwich, Bow, Silvertown

## Measured (open data, before/after)
| | 2012-13 | 2015-16 | change |
|---|---|---|---|
| former grounds (37 wards) | 274.4s | 346.4s | **+72.1s** |
| rest of London | 318.0s | 326.9s | +9.0s |

**Difference-in-differences: the closures cost +63.1s mean first-pump attendance in their former grounds.**

## Predicted by the twin (reopened vs 2025 demand, validated sim ±5%)
- a reopened station takes 13,120 calls/yr (10.0% of London)
- mean recovery on those: **-103.7s**
- 4,670 incidents/yr come back under the 6-minute promise

The twin's predicted per-incident recovery and the measured historical damage are
the same effect viewed from opposite sides of January 2014.

Per-station value today: Woolwich (-134s on 849 calls), Downham (-115s on 778 calls), Westminster (-109s on 1,784 calls), Kingsland (-108s on 1,390 calls), Southwark (-105s on 842 calls), Clerkenwell (-103s on 1,602 calls), Belsize (-100s on 1,493 calls), Bow (-99s on 1,615 calls), Knightsbridge (-92s on 1,123 calls), Silvertown (-89s on 1,644 calls)

## THE CONVERGENCE (apples-to-apples, same-denominator)

Treated area defined as 1km grid cells whose modal 2012-13 first attender was a closed
station (grid = immune to the May-2022 ward redraw):

| Witness | Method | Result |
|---|---|---|
| History (measured) | DiD on open data across Jan 2014 | **+63.1s** in treated areas |
| Twin (predicted) | reopen all 10 vs 2025 demand, n=9,108 treated-cell incidents | **−52.4s** recovery |

The twin was calibrated exclusively on 2021+ data — it has never seen the pre-closure
world — yet reproduces the measured effect of the 2014 intervention to first order.
Residual gap is expected and directionally correct: the 2014 package also removed 27
pumps from surviving stations (not restored in this experiment), and demand drifted
2012→2025.
