// Watch Commander — the police-tier chat brain (Tier B).
//
// Artem's fire bar runs an LLM agent over an /ask endpoint; this machine has no LLM
// or ElevenLabs keys, so the police parallel is a DETERMINISTIC commander: it parses
// the dispatcher's question, calls our own validated endpoints (geocode → /predict,
// /plan, /scenario) and returns a plain-English answer PLUS the map moves to run.
// Same promise as the fire agent — "ask about our data, see it on the map" — minus
// the model in the middle. Every answer is grounded in a real backend call.
import {
  fetchPlan,
  fetchPredict,
  geocode,
  runScenario,
  type PlanResult,
  type PlanStation,
} from "../../lib/policeApi";

const fmt = (n: number) => Math.round(n).toLocaleString();
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// round an estimate to a human-friendly figure ("about 1,400", not "1,392")
const approx = (n: number): string => {
  const r = n >= 1000 ? Math.round(n / 50) * 50 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n);
  return r.toLocaleString();
};
// join names the way a person says them: "a, b and c"
const listWords = (xs: string[]): string =>
  xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const tidy = (n: string) =>
  n
    .replace(/\s+Police Station$/i, "")
    .replace(/^Metropolitan Police\s+/i, "")
    .replace(/\(([^)]*)\)/g, "$1") // unwrap "(Sudbury Ward)" → "Sudbury Ward"
    .replace(/\s+Wards?$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/** A move the map should make in response to a question. The PoliceMap applies these. */
export type WCAction =
  | {
      kind: "plan";
      show: boolean;
      focus?: { lat: number; lon: number; label: string; highlight: FocusMark[] };
    }
  | { kind: "forecast"; lat: number; lon: number; radiusKm: number; label: string }
  | { kind: "scenario"; close: string[] }
  | { kind: "none" };

export interface FocusMark {
  lat: number;
  lon: number;
  name: string;
  move: number;
}

export interface WCResult {
  reply: string;
  actions: WCAction[];
}

const RADIUS_KM = 2.0;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Pull a likely London place name out of a free-text question. */
function extractPlace(text: string): string | null {
  const m = text.match(
    /\b(?:in|for|around|near|at|within|of|to)\s+([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i
  );
  if (!m) return null;
  const place = m[1]
    .replace(
      /\b(next|this|the|a|month|months|year|forecast|forecasts|crime|crimes|demand|area|areas|please|now|today|tomorrow|relocat\w*|redeploy\w*|unit|units|move\w*|transfer\w*|reinforce\w*|spare|from|where|and|how|many|much|us|we|need|should)\b/gi,
      " "
    )
    .replace(/[^A-Za-z'’\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return place.length > 1 ? place : null;
}

function shortLabel(displayName: string, fallback: string): string {
  const first = (displayName || "").split(",")[0]?.trim();
  return first && first.length > 1 ? first : cap(fallback);
}

// A real local-response station is named "… Police Station". That one positive rule cleanly
// excludes geocoding artefacts (police_<id>), separate forces (British Transport, City of
// London, RAF, Royal Parks), and Met HQ / forensic / marine / ward / records-office sites —
// none of which the agent should offer as "the nearest base" or "who covers it".
const RESPONSE_STATION = /police station$/i;
const named = (rows: PlanStation[]) => rows.filter((s) => RESPONSE_STATION.test(s.name));

/** Top giver names — the source pool the relocation pulls FROM (over-served quiet posts). */
function giverNames(plan: PlanResult, k = 3): string[] {
  return named(plan.moves_from)
    .filter((s) => s.move < 0)
    .slice(0, k)
    .map((s) => tidy(s.name));
}

/** City-wide relocation summary used when no specific area is named — spoken like a duty officer.
 *  Works at the fully-real BCU level (published officer totals), not the modelled per-station split. */
function planSentence(plan: PlanResult): string {
  const bcus = plan.bcus ?? [];
  const recv = bcus
    .filter((b) => b.move > 0)
    .slice(0, 3)
    .map((b) => `${b.bcu} takes ${b.move}`);
  const give = bcus
    .filter((b) => b.move < 0)
    .sort((a, b) => a.move - b.move)
    .slice(0, 3)
    .map((b) => b.bcu);
  const bits: string[] = [
    `To match next month's forecast, I'd move about ${fmt(plan.total_moved)} officers between the ${plan.n_bcus} command areas.`,
  ];
  if (recv.length)
    bits.push(`The biggest reinforcements: ${listWords(recv)} — that's where crime is rising.`);
  if (give.length)
    bits.push(`Those come from the quieter, over-served areas like ${listWords(give)}.`);
  bits.push(
    `That takes the busiest area from carrying about ${Math.round(
      plan.imbalance_before
    )} times the crimes-per-officer of the quietest down to roughly even.`
  );
  return bits.join(" ");
}

/** Forecast sentence for a geocoded area, from /predict — phrased like a person, not a readout. */
async function forecastFor(
  lat: number,
  lon: number,
  label: string
): Promise<{ reply: string; nextPerMo: number } | null> {
  const p = await fetchPredict(lat, lon, RADIUS_KM).catch(() => null);
  if (!p) return null;
  const now = p.total_now_per_mo;
  const next = p.total_proj_next_mo;
  const d = now > 0 ? ((next - now) / now) * 100 : 0;
  const top = p.categories[0];

  let driver = "";
  if (top) {
    const t = Math.abs(top.trend_3y_pct);
    const dir =
      top.trend_3y_pct >= 1
        ? `and it's been climbing about ${Math.round(t)} percent a year`
        : top.trend_3y_pct <= -1
          ? `and it's been easing about ${Math.round(t)} percent a year`
          : "and it's holding fairly steady";
    driver = ` The main driver is ${top.category}, around ${Math.round(
      top.share_pct
    )} percent of all incidents, ${dir}.`;
  }

  const headline =
    Math.abs(d) < 1
      ? `crime looks steady — about ${approx(next)} a month, much like now`
      : d > 0
        ? `I'm expecting crime to climb about ${Math.round(d)} percent, to roughly ${approx(next)} a month`
        : `I'm expecting crime to ease about ${Math.round(Math.abs(d))} percent, to roughly ${approx(
            next
          )} a month`;

  return { reply: `Around ${label}, ${headline}.${driver}`, nextPerMo: next };
}

/** The headline question: forecast for an AREA + which units move there, and from where. */
async function areaPlan(
  lat: number,
  lon: number,
  label: string
): Promise<WCResult> {
  const [fc, plan] = await Promise.all([
    forecastFor(lat, lon, label),
    fetchPlan().catch(() => null),
  ]);

  if (!plan) {
    return {
      reply: fc?.reply ?? `Couldn't read ${label}.`,
      actions: fc
        ? [{ kind: "forecast", lat, lon, radiusKm: RADIUS_KM, label }]
        : [{ kind: "none" }],
    };
  }

  // stations near the area, by straight-line distance to the geocoded point
  const near = named(plan.stations)
    .map((s) => ({ s, d: haversineKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d);
  const localReceivers = near
    .filter((x) => x.d <= 5 && x.s.move > 0)
    .sort((a, b) => b.s.move - a.s.move)
    .slice(0, 2)
    .map((x) => x.s);
  const givers = giverNames(plan, 3);

  const highlight: FocusMark[] = near
    .slice(0, 6)
    .map((x) => ({ lat: x.s.lat, lon: x.s.lon, name: tidy(x.s.name), move: x.s.move }));

  const lines: string[] = [];
  if (fc) lines.push(fc.reply);

  if (localReceivers.length) {
    const recv = localReceivers.map((s) => `${s.move} into ${tidy(s.name)}`);
    lines.push(
      `To cover that, I'd move ${listWords(recv)}` +
        (givers.length ? `, pulled from the quiet posts like ${listWords(givers)}.` : ".")
    );
  } else {
    const nearest = near[0]?.s;
    if (nearest) {
      const verb =
        nearest.move > 0
          ? `take on ${nearest.move} more officers`
          : nearest.move < 0
            ? `give up ${Math.abs(nearest.move)} officers`
            : "stay where it is";
      lines.push(
        `Locally it's already close to balanced — the nearest base, ${tidy(nearest.name)}, would ${verb}. ` +
          `Most of the relocation pulls from quiet posts like ${listWords(givers)} toward the busiest areas across the city.`
      );
    }
  }
  lines.push(
    `Across London that's about ${fmt(plan.total_moved)} officers on the move between command areas, taking crimes-per-officer from about ${Math.round(
      plan.imbalance_before
    )} times imbalance down to roughly even.`
  );

  return {
    reply: lines.join(" "),
    actions: [{ kind: "plan", show: true, focus: { lat, lon, label, highlight } }],
  };
}

// words that are never a place — stripped from any closure candidate before geocoding
// (includes the closure verbs themselves, so "close Croydon" / "scrap the Brixton" reduce
// cleanly to the proper noun).
const CLOSURE_STOP =
  /\b(station|stations|police|offline|off|down|nick|base|bases|unit|units|please|now|today|the|a|an|to|near|if|when|our|my|we|us|do|does|will|would|could|should|is|are|that|this|next|one|come|comes|coming|rescue|help|cover|covers|covering|which|what|who|whom|happens|happen|here|it|its|i|dont|don|know|for|close|closes|closed|closing|shut|shuts|shutting|scrap|scraps|lose|losing|lost|remove|removed|removing|drop|dropping|take|takes|without|goes|went|gone)\b/gi;

/** Place name in a closure question. People phrase these every which way, so we try three
 *  patterns in order of reliability and take the first that yields a real word:
 *    (a1) before a "station/nick/base" noun — "close Croydon police station", "the Brixton nick"
 *    (a2) right before a closure verb        — "Hackney shuts", "Southwark closes down"
 *    (b)  right after a closure verb         — "close Croydon", "without Croydon"
 *  Whatever survives is geocoded + distance-checked downstream, so over-matches self-correct. */
function extractClosurePlace(text: string): string | null {
  const clean = (s: string | undefined): string | null => {
    if (!s) return null;
    const p = s
      .replace(CLOSURE_STOP, " ")
      .replace(/[^A-Za-z'’\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return p.length > 1 ? p : null;
  };
  const patterns = [
    /\b(?:the\s+)?([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,2})\s+(?:police\s+)?(?:station|nick|base)\b/i,
    /\b([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,2})\s+(?:closes?|closed|closing|shuts?|shutting|(?:goes?|went)\s+offline)\b/i,
    /\b(?:close|closes|closed|closing|shut|shuts|shutting|without|lose|losing|lost|drop|dropping|take|remove|removed|scrap)\s+(?:down\s+|the\s+|off\s+)*([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i,
  ];
  for (const re of patterns) {
    const p = clean(text.match(re)?.[1]);
    if (p) return p;
  }
  return null;
}

/** Try to read a "close <station>" intent against the live estate (best-effort). */
async function maybeScenario(text: string): Promise<WCResult | null> {
  if (
    !/\b(close|closes|closed|closing|shut|shuts|shutting|offline|without|lose|losing|lost|scrap|scraps|remove|removed|gone)\b/i.test(
      text
    )
  )
    return null;
  const place = extractClosurePlace(text) ?? extractPlace(text);
  if (!place) return null;
  const plan = await fetchPlan().catch(() => null);
  if (!plan) return null;
  const real = named(plan.stations);

  // Resolve the place to the base they mean. If it names a London borough, use that
  // borough's busiest response base — geocoding a borough label can land on its edge and
  // pick a neighbouring force's building across the river. Otherwise geocode + nearest.
  const placeLc = place.toLowerCase();
  let closed: PlanStation | null =
    real
      .filter((s) => {
        const b = (s.borough || "").toLowerCase();
        return !!b && (placeLc.includes(b) || b.includes(placeLc));
      })
      .sort((a, b) => b.demand_now - a.demand_now)[0] ?? null;
  if (!closed) {
    const hits = await geocode(place).catch(() => []);
    if (!hits.length) return null;
    const lat = +hits[0].lat;
    const lon = +hits[0].lon;
    const n = real
      .map((s) => ({ s, d: haversineKm(lat, lon, s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!n || n.d > 6) return null;
    closed = n.s;
  }
  const base = closed;
  const name = base.name;
  // who picks up the slack — the closed base's nearest open neighbours ("its rescue")
  const cover = real
    .filter((s) => s.name !== name)
    .map((s) => ({ s, d: haversineKm(base.lat, base.lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((x) => tidy(x.s.name));
  const sc = await runScenario([name], "all").catch(() => null);
  if (!sc) return null;
  const meanS = Math.round(sc.city.mean_delta_s);
  const p90S = Math.round(sc.city.p90_delta_s);
  const pushed = sc.city.crimes_pushed_over_target;
  const meanPhrase =
    meanS < 1
      ? "the city-wide response would barely move — under a second slower on average"
      : `the city-wide response would slow by about ${meanS} second${meanS === 1 ? "" : "s"} on average`;
  const p90Phrase =
    p90S < 1
      ? "even the slowest calls would hold steady"
      : `with the slowest calls about ${p90S} seconds slower`;
  const pushedPhrase =
    pushed < 1
      ? "and no extra crimes would miss the 15-minute target"
      : `and roughly ${fmt(pushed)} more crimes a month would slip past the 15-minute target`;
  const worst = sc.worst_cells[0]
    ? ` The area that feels it most is around ${sc.worst_cells[0].near}, about ${Math.round(
        sc.worst_cells[0].delta_s
      )} seconds slower.`
    : "";
  const coverPhrase = cover.length
    ? `${tidy(name)}'s ground would mainly fall to ${listWords(cover)} — its closest open ${
        cover.length > 1 ? "bases" : "base"
      }. `
    : "";
  const reply = `If ${tidy(name)} went offline, ${coverPhrase}${meanPhrase}, ${p90Phrase}, ${pushedPhrase}.${worst}`;
  return { reply, actions: [{ kind: "scenario", close: [name] }] };
}

/**
 * The single entry point the chat bar calls. Returns the spoken/typed answer and the
 * list of map moves to apply. Always backed by a real endpoint call.
 */
export async function watchCommander(text: string): Promise<WCResult> {
  const t = text.toLowerCase().trim();
  if (!t) return { reply: "", actions: [{ kind: "none" }] };

  // 1) closure counterfactual ("what if we close …")
  const scen = await maybeScenario(text);
  if (scen) return scen;

  const wantsPlan =
    /relocat|reloc\b|redeploy|deploy|\bmove\b|\bunits?\b|transfer|reinforc|rebalanc|spare|free up|how many|\bplan\b|where from|from where/.test(
      t
    );
  const wantsForecast =
    /forecast|predict|outlook|trend|expect|demand|crime|hotspot|busy|next month|how bad/.test(t);

  const place = extractPlace(text);
  let hit: { lat: number; lon: number; label: string } | null = null;
  if (place) {
    try {
      const hits = await geocode(place);
      if (hits.length)
        hit = { lat: +hits[0].lat, lon: +hits[0].lon, label: shortLabel(hits[0].display_name, place) };
    } catch {
      /* no geocode */
    }
  }

  // 2) area named + relocation asked → the headline answer (forecast + local moves)
  if (hit && wantsPlan) return areaPlan(hit.lat, hit.lon, hit.label);

  // 3) area named, forecast only
  if (hit && (wantsForecast || !wantsPlan)) {
    const fc = await forecastFor(hit.lat, hit.lon, hit.label);
    if (fc)
      return {
        reply: fc.reply,
        actions: [{ kind: "forecast", lat: hit.lat, lon: hit.lon, radiusKm: RADIUS_KM, label: hit.label }],
      };
    return {
      reply: `Couldn't read ${hit.label} — try a nearby London place.`,
      actions: [{ kind: "none" }],
    };
  }

  // 4) relocation only, no place → city-wide plan
  if (wantsPlan) {
    const plan = await fetchPlan().catch(() => null);
    if (plan) return { reply: planSentence(plan), actions: [{ kind: "plan", show: true }] };
  }

  // 5) couldn't resolve a place that was probably meant
  if (place && !hit) {
    return {
      reply: `I couldn't find “${place}” in Greater London. Try a borough or station name — e.g. “forecast for Southwark next month”.`,
      actions: [{ kind: "none" }],
    };
  }

  // 6) help
  return {
    reply:
      "Ask me about an area or the fleet — e.g. “what’s the forecast for Southwark next month?”, " +
      "“how many officers do we relocate next month, and from where?”, or “what happens if we close Croydon?”",
    actions: [{ kind: "none" }],
  };
}
