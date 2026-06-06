# The Better Ten — was the 2014 decision optimal?

Same constraint (close 10 of pre-2014 London's 112 stations = same savings proxy),
same 2025 demand, same random draws. The twin's answer:

| | politicians' ten (actual) | optimizer's ten (twin) |
|---|---|---|
| city mean added | 8.9s | 9.9s |
| incidents made worse | 13,132/yr | 17,648/yr |
| mean damage on those | +90s | +84s |
| **pushed past 6-min promise** | **4,039/yr** | **5,286/yr** |

**The 2014 set causes 0.8x more broken 6-minute promises than an
information-equivalent alternative.** Overlap between the sets: 6/10
(Belsize, Bow, Clerkenwell, Downham, Silvertown, Westminster).

Optimizer's ten: Clerkenwell, Westminster, Bow, Dockhead, Silvertown, Leyton, Belsize, Downham, Deptford, Stratford

Caveats (state on camera): savings proxied by station count; single-pump reopenings;
2025 demand (not 2012); greedy + 3km spacing, not exhaustive search — a true optimum
would only widen the gap.


## Round 2 — set-aware sequential greedy (interactions respected)

Naive single-closure ranking LOST to the 2014 committee (1,619 vs 1,237 pushed —
closure sets interact; cheap closures cluster). Sequential greedy re-simulates the
network after each commitment:

- twin's sequential ten: Dowgate, Millwall, Dockhead, New Cross, Chelsea, Shadwell, Islington, Lewisham, Stratford, East Ham
- overlap with 2014: 0/10 ()
- broken 6-min promises/yr: politicians 4,049 vs twin 2,762 (1.47x)
- city mean: +9.0s vs +6.2s

Either reading is a finding: if the twin wins, only set-aware simulation can plan
closures; if 2014 holds up, the twin *certifies* the selection — and the measured
+63s damage (see closures_2014.md) was the price of the policy, not of the picks.
