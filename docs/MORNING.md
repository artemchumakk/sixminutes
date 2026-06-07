# ☀️ MORNING REPORT — Sunday, 7 June 2026

> **09:55 final update — the 120B verdict.** The box never crashed overnight (uptime
> intact — it OOM-thrashed and self-recovered). Rebuilt at 09:38 with full access:
> tunnel restored (`alien-argued-crafts-truck`, published to ntfy), 120B relaunched
> with ninja+nvcc and 0.80 util. **It died a third time, identically: silent
> EngineCore death in Mamba2 SSD Triton warmup, with 24GB free** — memory ruled out;
> this vLLM build's Mamba2 Triton kernels are incompatible with GB10/sm_121.
> Fallback executed: **Nano-30B-FP8 serving on the box** (the honest "Nemotron runs
> locally on the Spark" artifact); **runtime stays Nebius Super-120B**. Submission
> language: Spark = training + local Nemotron serving; 120B-NVFP4 serve = documented
> negative result (three reproducible kernel-level failures — that's research, say it
> proudly).

*Written by the overnight session. Read this first, then SUNDAY.md for the runbook.*

## TL;DR

- **Product: flawless.** Battery 22/22 green ×2 (incl. final post-patrol run), adversarial retest 6/6, judge drill 6/6 in 110s, all fixes pushed.
- **Bounty patrol: DONE — 1h 23m 58s continuous voice session, 318 logged events.**
- **Spark: froze ~01:45 during the 120B Triton warmup — needs the power button at 08:00.** Runtime stayed on Nebius (same Super-120B, 1–2s/turn). 15-min rebuild recipe below.
- Web app (5173), API (8095), wall — all running, verified 02:31Z.

## 🎬 Judge drill (stopwatched, full demo arc = 110s)
| Beat | Time | Answer headline |
|---|---|---|
| Why trust this? | 4.0s | 2.3M records, held-out validation |
| Close Soho tonight | 13.5s | +2.8s mean, ~830 breaches/yr, full choreography |
| Cover my ground (My Station) | 33.4s | Stoke Newington → Islington, 86s faster, ~1 breach/4h — **narrate-first covers the sweep wait** |
| The 2014 mistake | 40.6s | 4,068 extra breaches/yr — ghosts + compare strip fill the wait |
| Rank irreplaceable | 10.4s | Addington +202s, Biggin Hill +195s |
| Crying-wolf buildings | 8.2s | top sites £182k/£158k/£112k (UPRN-0 bug found & fixed here) |

## What happened overnight

### 1. Vocabulary + framing overhaul (your last requests before sleep)
- "Engine" everywhere user-facing; agent doctrine translates the data's pump jargon
- Cover moves re-framed to the tactical horizon: `/cover` returns
  `uncovered_ground_responds_faster_by_s` + `breaches_avoided_next_4h` (ceil'd to whole
  breaches) + `annual_equivalent_IF_gap_lasted_a_year` — field names make misquoting impossible
- New `commit_stations` UI verb: cover questions paint the stripped station **amber**
  (engines out), never red (closed), and never poison `closed_on_board`

### 2. Test battery → fixes → green
Full 22-question battery + 6-case adversarial retest. Defects found and killed:
| Defect | Fix |
|---|---|
| Agent forgot ×scale (quoted 1,211 instead of 4,021/yr) | `extra_breaches_PER_YEAR` precomputed in the tool — no mental math left |
| Jailbreak complied (told a joke) | ROLE INTEGRITY doctrine — holds post, offers a real capability |
| "Compare X vs Y" answered without the board | comparison choreography recipe + sidebar ask reworded |
| 2014 answered from canonical numbers without running | live run now MANDATORY; canonical = sanity-check only |
| Topic bleed (2014 context hijacked "close every station") | TOPIC ISOLATION doctrine |
| Cover annualized in tactical context | tool field renames (above) |

Final retest: **6/6 PASS** — including "4,068 more breaches per year" for 2014 (correct scale),
amber commit + "~one breach in the next four hours" for cover, jailbreak held.

### 3. The Spark incident (~01:40–01:47)
- 120B NVFP4 load attempt 4 was the best yet: all 17 shards loaded, Mamba2 Triton kernel
  warmup started — then the box froze (log stopped, tunnel died simultaneously)
- Root causes found on the way (all fixed in the recipe): vLLM JIT-compiles Blackwell FP8
  GEMM at startup → needs `ninja` ON PATH (not just importable) + nvcc; eager mode dodges
  the cuda-graph wrapper crash
- Tunnel DNS record deregistered → the box-side cloudflared is dead; ntfy publisher was
  one-shot manual → even a self-recovering box can't announce itself. **Lesson: tunnel must
  be a systemd service with an on-boot publisher** — do this tomorrow.
- Remote restart impossible (no BMC, no LAN path, no reverse channel). First hand on the
  power button wins.

### 4. LLM backend decision — three-tier bench (Nebius, our exact protocol prompt)
| Model | Turn | Decode | Protocol |
|---|---|---|---|
| Nano-30B-A3B | 1.3–1.9s | 209–255 tok/s | 2/3 — broke JSON protocol (matches Saturday's live failures) |
| **Super-120B-A12B** ✓ | 1.1–1.8s | 88–181 tok/s | 3/3 |
| Ultra-550B-A55B | 1.8–2.4s | 31–53 tok/s | 3/3 but 3–5× slower decode |

**Super-120B = measured Pareto optimum** — use this line + table in submission/video
("we evaluated three Nemotron tiers on the choreography protocol; 120B is the sweet spot").
The Spark eager-mode serve would have been slower than Nebius; it's a sovereignty demo, not
a speed upgrade. Spark's rubric contribution stands on the XGBoost training (598k legs, 1.8s).
⚠️ 10-second morning task: glance at the Nebius dashboard balance so credits can't surprise
us mid-judging.

## 🔧 Spark rebuild recipe (08:00, ~15 min)
```bash
# 1. power-cycle the box, wait for boot
# 2. on the box (keyboard or venue LAN):
tmux new -d -s tun "cloudflared tunnel --url ssh://localhost:22 2>&1 | tee ~/cf.log"
sleep 15; grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' ~/cf.log | head -1 \
  | xargs -I{} curl -s -d {} ntfy.sh/sixmin-spark-a7x3k9
# 3. from the Mac: update ~/.ssh/config ProxyCommand hostname, then:
ssh spark 'loginctl enable-linger nvidia; tmux new -d -s super120 "export PATH=$HOME/vllm-env/bin:/usr/local/cuda/bin:$PATH; vllm serve nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 --port 8000 --gpu-memory-utilization 0.80 --max-model-len 8192 --enforce-eager 2>&1 | tee ~/super120.log"'
# fallback if it fails again: bash ~/restore_nano.sh && bash ~/serve_supervisor.sh
```

## Services state (verified 02:31Z)
| Service | State |
|---|---|
| API :8095 | ✅ 200, restarted post-fixes via run_api.sh (keys loaded) |
| Web :5173 | ✅ 200 (Vite dev; prod build also passes) |
| Wall (8095/) | ✅ serving, WARDEN branding |
| Patrol | ✅ completed + evidence captured (below); supervisor cleanly stopped |
| Spark | ❌ down, awaiting 08:00 power button (recipe above) |

## 🏆 Bounty evidence (ElevenLabs)
- Session: **2026-06-07 00:58:25Z → 02:22:23Z = 1h 23m 58s** (target 1h11m + 13min buffer)
- **318 logged events**: 207 notables narrated · 69 sim-days replayed · **14 autonomous
  twin experiments** · **9 LLM investigations** · 8 chapter summaries · 10 seeded analyses
- ElevenLabs characters: 21,744 → 24,797 (**Δ 3,053** TTS chars this session)
- Evidence in repo: `logs/session_overnight_sun.jsonl` (318 rows, wall-clock timestamps)
  + `logs/memory.db` + Saturday's box session (`logs_box_backup/`, 2,250 lines)
- Cumulative story: TWO overnight sessions (Sat on the Spark, Sun on the Mac after the
  Spark froze) — resilience is part of the narrative

## Next (SUNDAY.md sequence) — all doc markers already filled overnight
08:00 box power-cycle + rebuild (recipe above) → 08:30 judge drill live + WiFi-off drill →
09:40 record video (script's session claims now use real numbers) → **10:40 SUBMIT** (hard 11:00)

If anything died overnight: `./run_api.sh` (API+wall), `cd web && npm run dev` (web),
`./run_patrol.sh` (patrol — only if you want it live during judging).
