# Demo Video Script — 4m30s, shot in RUBRIC ORDER

> Rule: every sentence either shows the system working or lands a number.
> Record screen at 1080p+, voice calm, cursor deliberate. Cut nothing that moves; cut everything that talks.

## 0:00–0:25 — HOOK
*Dark dashboard, map of London, station dots breathing.*
> "London promises a fire engine in six minutes. This is SIXMINUTES — a validated digital
> twin of the city's emergency response, built this weekend from 2.3 million open records
> on a DGX Spark. It answers the questions you can't A/B test on real emergencies."

## 0:25–1:10 — THE WORKING LOOP (Completeness, 15 pts)
*Click Soho. Click RUN. Choropleth flips in ~1.3s.*
> "Click a station, close it — the twin re-dispatches a year of real 2025 incidents,
> 130,000 calls, in about a second. West End +52s, St James's +41s, 248 incidents
> pushed past the six-minute promise."
*Voice clip: ask the agent "what happens if Croydon loses a pump on Friday night?" — it speaks back.*
> "And you can just… ask it. ElevenLabs in, Nemotron reasons, the simulator answers."

## 1:10–1:50 — NVIDIA STACK + SPARK STORY (30 pts)
*nvidia-smi screenshot; terminal: the 1.8s training line.*
> "Everything heavy is NVIDIA: the travel-time physics — learned from 600,000 timed
> fire-engine runs — trains on the Spark's GB10 in 1.8 seconds. The agent is Nemotron,
> resident on the box; Nemotron-Super-120B on Nebius is our overnight analyst that mined
> tonight's findings. The whole control room — simulator state, 2.3M-row store, agent,
> memory — lives in one 128GB unified address space. Emergency data never leaves the room."

## 1:50–2:30 — TRUST (Technical Depth, 15 pts)
*docs/validation.md table on screen.*
> "Is the twin right? We calibrated on 2024 and tested blind on 2025: mean within 2.4%,
> tail within 3.7%. And then we tested it against history itself —"

## 2:30–3:30 — THE 2014 ACT (Insight, 10 + Creativity, 10)
*closures_2014.md, the two-witness table.*
> "In 2014, London closed ten fire stations. We never typed their names — the data
> remembered them: dispatching through 2013, silent forever after. The public record
> shows their neighbourhoods got 63 seconds slower. Our twin — which has never seen a
> single pre-2021 record — predicts 52. Two witnesses, eleven years apart, same verdict."
*Better Ten slide.*
> "Then we tried to beat the 2014 committee with an optimizer — and the twin caught US:
> closure sets interact; ten individually-cheap closures cluster and compound. [Per
> betterten2 result: 'Our set-aware optimizer finally beat them by X%' / 'Even set-aware
> optimization barely improves on 2014 — the twin certifies the selection; the damage was
> the policy's price.'] Either way: this is why cities need simulators, not spreadsheets —
> call volume correlates NEGATIVELY, minus 0.18, with what closing a station actually costs.
> Biggin Hill: quietest station in London, second-most-damaging closure. Whitechapel:
> seven times busier, nearly free."

## 3:30–4:10 — THE PERSISTENT AGENT (ElevenLabs bounty)
*Session log scrolling; memory.db query; live recall.*
> "Brigade Watch has been on duty since 18:20 yesterday — a 13-hour logged session,
> narrating a 60× replay of 2025, remembering every notable event in a structured
> registry plus its voice log. Ask it what happened at minute fourteen — it knows.
> Ask it about Dagenham — it tells you night turnout there jumps 47 seconds."

## 4:10–4:30 — CLOSE (Usability, 10)
*Scenario brief output.*
> "Every answer is a decision: which pump to move tonight, which closure survives a
> budget round, which ward silently loses the promise at 2 AM. City Hall could have
> known in 2014. Now it can. SIXMINUTES — fire today; the same engine already maps
> police and ambulance. One twin, every blue light."

## Shot checklist
- [ ] dashboard closure run (screen) — [ ] voice round-trip (screen+audio)
- [ ] nvidia-smi + 1.8s train line — [ ] validation table — [ ] 2014 tables
- [ ] session log + recall answer — [ ] police/ambulance layer toggle (if landed)
