# Police tier — insights

Three findings from the police closure-damage model. Every claim has a number; the method
and honesty bounds are in [POLICE_VALIDATION.md](../POLICE_VALIDATION.md).

## 1. The spreadsheet closes the wrong 10 stations — every single one

If a budget review ranks stations by call volume and shuts the 10 quietest (the obvious
"low-activity" cut), versus our model shutting the 10 with the lowest *closure damage*:

| close 10 by…            | added delay (crime-min/mo) | crimes/mo pushed past 15 min |
|-------------------------|---------------------------:|-----------------------------:|
| **call volume** (spreadsheet) | **464** | **59.5** |
| **closure damage** (our model) | **287** | **1.4** |

Same headcount of closures. The spreadsheet inflicts **1.6×** the added delay and leaves
**58 more violent crimes a month** stranded beyond the I-grade target. The two lists
**agree on 0 of 10 stations** — the naive cut would close Biggin Hill, Albany Street,
Sudbury and seven others that our model flags as costly to lose.

## 2. Quiet does not mean safe to close (call volume mis-ranks damage)

spearman(call volume, closure damage) = **+0.37** — far below the 0.85 you'd need for
"just close the quiet ones" to be safe. The cleanest inversion:

- **Biggin Hill** — 23.7 violence crimes/mo (bottom 40% by volume) — is the **single most
  damaging** closure in London at **+374 s mean** added response.
- **Edmonton** — the **busiest** station at 456 crimes/mo — costs only **+108 s** to close.

Three-and-a-half times the per-incident damage from a station handling one-twentieth the
volume. Call volume points at the wrong end of the list.

## 3. Crime is extremely concentrated — and stable enough to plan on

Violence demand on the 1 km grid is top-heavy: the **top 10 %** of cells hold **47.5 %** of
all violence, the top 20 % hold **70.4 %**. The peak cell **E529_N180** (Soho / West End)
runs **153** violence crimes/month.

And it does not move: predict-Y3 spearman = **0.94** for violence (year-over-year cell
log-correlation 0.99). Last year's map is next year's map — concentration this sharp plus
stability this high is exactly the regime where targeted coverage decisions pay off.
