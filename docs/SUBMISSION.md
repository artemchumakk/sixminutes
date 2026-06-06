# Submission — paste-ready

**Project name:** WARDEN — London's Blue-Light Digital Twin
**Track:** Urban Operations
**Repo:** https://github.com/artemchumakk/sixminutes
**Demo video:** [LINK — add Sunday morning]

## Description (form field)

London promises a fire engine within six minutes. WARDEN is a validated digital
twin of the city's emergency response network that shows exactly where that promise
holds, where it silently breaks, and what any intervention — closing a station,
moving a pump, a strike, a storm — would do, before reality runs the experiment.

We ingest 2.3M open records (every LFB incident since 2018, every timed pump
mobilisation since 2021, 3.4M police records, NHS ambulance series), learn London's
blue-light "physics" (turnout + travel-time distributions) from 600,000 real
fire-engine runs, and replay real incident history through a discrete-event simulator
under counterfactual postures. The simulator is validated three independent ways:
(1) blind holdout — calibrated on 2024, it reproduces 2025 attendance within 2.4%
(mean) / 3.7% (p90); (2) against history — it reproduces the measured +63s damage of
the real 2014 station closures (predicting 52s, never having seen pre-2021 data);
(3) quantile-calibrated uncertainty (78.8% vs 80% target).

Headline findings, all computed this weekend from open data:
- Call volume — the heuristic cities actually use for closures — correlates
  NEGATIVELY (ρ=−0.18) with true closure damage. Biggin Hill, London's quietest
  station, is among its most critical; Whitechapel, 7× busier, is nearly redundant.
- The 2014 LSP5 closures measurably cost +63s in their former grounds (DiD on open
  data); reopening them today would bring 4,670 incidents/yr back under the promise.
- Closure SETS interact: a naive per-station ranking loses to the 2014 committee's
  selection (politicians beat the spreadsheet) — but a set-aware sequential optimizer
  (~300 simulated years of London) finds a zero-overlap alternative ten with **47%
  fewer broken 6-minute promises for identical savings** (docs/better_ten.md).
- Night turnout penalty is station-specific (Dagenham +47s); 44.8% of incidents are
  false alarms consuming ~684k pump-minutes/yr in non-residential AFAs alone.

Beyond planning, the twin does real-time repositioning: tell it "Croydon's pumps
just committed — best cover move?" and it sweeps ~20 candidate pump moves through
the simulator (night-map aware via hour-band replay) and answers in ~45 seconds:
"Bromley to Croydon — 153 of 171 promise-breaks avoided tonight." Cover moves are
how LFB actually operates daily; today they're made by gut feel.

The interface is an operations dashboard (close stations on a map, watch a year of
London re-dispatch in ~1 second) and "Brigade Watch" — a Nemotron agent with
ElevenLabs voice in/out that operates the simulator AND the dashboard itself by
conversation (the Ghost Operator: ask it something and the wall choreographs),
runs SQL over the full archive, and patrols autonomously with a structured event
memory — investigating anomalies and running unprompted counterfactual experiments.
[SUNDAY: insert live session stats — start time, hours logged, event count]

## NVIDIA / Spark story (form field)

Local-first by design: emergency operations data shouldn't transit consumer clouds.
The DGX Spark's 128GB unified memory holds the resident Nemotron agent, the
simulator state, the full 2.3M-record Arrow store and the agent's memory in one
address space — the travel-physics model trains on the GB10 in 1.8 seconds (598k
legs), and the validated simulator replays a year of London at ~40,000 incidents/sec,
which let us run ~300 full-year counterfactuals in minutes for set-aware closure
optimization. Nemotron-3 Super-120B on Nebius is the overnight analyst that mined
the findings; nvidia/parakeet is the offline STT fallback. No OpenAI/Anthropic
anywhere in the path.

## Bounty (ElevenLabs / Nemotron)

Brigade Watch: Nemotron agent, ElevenLabs STT+TTS both directions, persistent session logs (logs/session_*.jsonl + audio artifacts) — [SUNDAY: real stats],
structured anomaly registry → exact recall of any earlier minute on live questioning.

## Run it

```bash
git clone https://github.com/artemchumakk/sixminutes && cd sixminutes
uv venv && uv pip install -r <(echo "polars fastexcel pyarrow numpy scikit-learn xgboost scipy fastapi uvicorn httpx duckdb pyproj")
bash download_data.sh && .venv/bin/python etl.py      # ~10 min, all open data
.venv/bin/python sim.py --validate                     # the trust table
./run_api.sh                                           # dashboard on :8095
python agent.py --voice                                # talk to it
```
