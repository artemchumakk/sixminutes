# Fire tier — deep-data insights (widened ETL, latest 12 months)

## 1. The £5M false-alarm tax has names and addresses
Non-residential automatic fire alarms cost **£5,021,344/yr** in pump time (LFB notional
costing). **39 buildings trigger a false alarm at least monthly.** The worst offenders are
hospitals: one NW1 hospital generated **61 false-alarm responses in 12 months (£25,685)**,
an E13 hospital 51, two NW3 hospitals 57 between them. A call-challenge policy for the
top-40 chronic UPRNs alone would free hundreds of pump-hours.
*(UPRNs are open data for non-residential buildings; dwellings are redacted by LFB.)*

## 2. The promise breaks in the suburbs, not the towers
Counter-intuitive: 10+ storey blocks get **faster** first pumps (mean 307s, p90 461s)
than single-occupancy houses (**352s mean, 512s p90, +45s**) — density puts towers near
stations; outer low-rise London carries the response-time tail. The 6-minute conversation
is usually about high-rise risk; the data says the *suburban semi* is where the promise
quietly fails.

## 3. Cover moves are real, daily LFB practice — we make them math
**7,288 mobilisations (3.5%) deployed from somewhere other than home station** in the
latest 12 months ("Other Station" standbys/move-ups). The cover-move recommender
(`/cover`) formalizes exactly this decision — today it's made by experience; the twin
ranks the options by promise-breaks avoided in ~45 seconds.
