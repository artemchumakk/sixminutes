# 🎬 The 2014 Film — Speaker Notes

## ⚡ THE NARRATION (~50s — story arc: necessity → choice → result → could we do better → technical → results)
*(calm map)* "2014, austerity: forty-five million has to come out of London's fire
budget — and the maths said ten stations had to go. The only question was: which
ten?"
*(red stations appear)* "They scored stations one at a time — activity, cost — and
said response targets would hold. Here's what they chose."
*(heat blooms + 63s / 4,049 / +9.3s counters)* "And here's the result. Diff-in-diff
against the rest of London as control: sixty-three seconds slower in those
neighbourhoods — four thousand missed six-minute responses a year. Our twin, never
shown pre-2014 data, prices the same wound at fifty-two. Two independent methods,
one answer."
*(search HUD — the technical beat)* "So: could we do better? We ran a set-aware
sequential greedy. Objective: annual misses of the six-minute standard. Every
candidate set gets a discrete-event replay of a full year — a hundred and
thirty-three thousand incidents — under common random numbers, so the deltas are
pure signal, not seed noise. Ten rounds, three hundred simulated years, and a full
network re-score after every lock — because closures interact."
*(teal ten + 2,762 / ×1.47 / 0-10 counters)* "Ten different stations. Zero overlap.
Twenty-seven hundred misses instead of four thousand — a third less damage, same
savings."
*(hold)* "Counting calls is easy. Coverage is a network."

*To hit 40s: cut "Two independent methods, one answer" sentence pair (the 52s
convergence) — or keep it and trim "under common random numbers… seed noise."*
*Evidence for "said response targets would hold": LFB's 2013 savings publication —
"savings worth £28.8m over the next two years while maintaining existing response
time targets" (london-fire.gov.uk, 2013 news).*

---

`localhost:8095/2014` · full-screen · **→** advances, **←** rewinds (Space also works).
On-screen captions are OFF — you are the narration. Each beat: what the screen does,
what you say, and the depth to reach for if a judge probes.

Total runtime ~90s if you keep pace. The search beat is ~6s of animation — start
talking before it ends.

---

## Beat 1 — TITLE · *"Ten fire stations closed."*
**Screen:** calm London, title card.
**Say:** "January 2014. London closed ten fire stations — the largest cut in the
Brigade's modern history. This is the story of that decision, told by a simulator
that wasn't there."

## Beat 2 — THE RATIONALE (→)
**Screen:** three counters tick up: £45M · 14 appliances · −50% fires.
**Say:** "The why was austerity: £45 million of savings over two years. And there was
a real argument — fires had *halved* in a decade. The Fifth London Safety Plan offered
ten stations, fourteen engines, five hundred and fifty-two posts. Its own modelling
asserted response targets would be maintained. Hold that thought."
**If probed:** LSP5 delivered £28.8M of the £45M directive; passed Sept 2013 on the
chairman's casting vote (8–8) after the Mayor overrode the Authority's rejection.

## Beat 3 — THE TEN (→)
**Screen:** camera dives to central London; the ten turn red one-by-one with name cards.
**Say:** "These are the ten — Clerkenwell had served since 1872. They were selected
station-by-station: activity per house, cost per house. The flaw is methodological:
stations were scored *in isolation*, and the plan optimised *city-wide averages*.
Averages conceal which neighbourhoods pay."
**If probed:** call volume correlates *negatively* with closure damage in our data
(Spearman −0.18) — the quietest station can be the least replaceable. Counting calls
ranks closures backwards.

## Beat 4 — THE IMPACT (→)
**Screen:** ward heat blooms from a live twin run (Knightsbridge & Belgravia glows
hottest, +143s); counters: **+63s · 4,049/yr · +9.3s**.
**Say:** "One year later, the damage is measurable. Difference-in-differences against
the rest of London as control: first engines in those ten grounds arrived
*sixty-three seconds* slower. The twin prices the same selection at four thousand
missed six-minute responses a year. The 'targets maintained' assertion did not
survive contact with the data."
**If probed:** DiD isolates the closure effect from city-wide trends; 4,049 =
annualised exceedances of the 360s first-appliance standard from a 132,860-incident
replay. The heat you see is the model's per-ward attendance delta, not an artist's
impression.

## Beat 5 — THE QUESTION (→)
**Screen:** heat fades; title card: *"Same ten closures. Could London have lost less?"*
**Say:** "So we asked a harder question: keep the savings, keep ten closures — was
there a better ten? To answer that you need a simulator you can trust."
**The credibility line (say it):** "Ours is blind-validated: trained only on 2021
onwards, it reproduces held-out 2025 within two and a half percent — and it
re-discovers the 2014 damage it was never shown: it predicts a 52-second recovery
if you reopen those stations. Reality recorded 63. Two independent methods, same
wound."

## Beat 6 — THE SEARCH (→) ⚡ ~6s of animation — talk over it
**Screen:** HUD top-left (round counter, sim-years odometer racing to 300, lock feed);
stations flicker in waves as candidate networks are trialled; ten teal picks lock in
sequence, each lock ripples the network.
**Say:** "This is the actual algorithm, compressed. It's a sequential greedy search
over *sets*, because closures interact — every flicker you see is a candidate
*network* being scored by replaying a full simulated year of London, a hundred and
thirty-three thousand incidents per trial. Ten rounds, three hundred simulated
years. After each lock, everything re-scores."
**If probed:** objective = annualised 360s exceedances; candidates compared under
common random numbers so deltas are pure signal, not seed noise; the objective is
non-additive — the marginal damage of the 10th closure runs 4.7× the 1st — which is
exactly why a sorted list (the naive method) scores 5,290/yr, *worse than the
politicians*. Feasible only because the twin replays a year in ~3s (~40k incidents/s).

## Beat 7 — THE RESULT (→)
**Screen:** the teal ten on the map, red ghosts dimmed; heat repaints visibly cooler
(fewer, paler wards); counters: **2,762/yr · ×1.47 · 0/10**.
**Say:** "Ten *different* closures. Same budget, same station count: two thousand
seven hundred missed responses instead of four thousand — a third less harm, thirteen
hundred promises kept every year. And the optimum shares *not one station* with the
2014 list."
**If probed:** the heat maps are the same renderer, same thresholds, CRN-paired runs —
the visual cooling IS the data. Optimizer's ten: Dowgate, Millwall, Dockhead,
New Cross, Chelsea, Shadwell, Islington, Lewisham, Stratford, East Ham.

## Beat 8 — THE VERDICT (→)
**Screen:** both tens visible, closing card: *"Counting calls is easy. Coverage is a
network."*
**Say:** "The 2014 decision wasn't malicious — it was made with a spreadsheet view of
a network problem. WARDEN exists so the next committee doesn't have to choose blind."
*(beat)* "And everything you just saw runs live — ask it anything."

---

### Numbers you must not fumble
£45M directive · £28.8M from LSP5 · 10 stations / 14 appliances / 552 posts ·
fires −50%/decade · **+63s measured** vs **−52s predicted blind** · **4,049 → 2,762**
(−31.8%, ×1.47) · naive method 5,290 (worse than politicians) · **0/10 overlap** ·
300 sim-years · 132,860 incidents/replay · validation: mean +2.4%, p90 −3.7%.
