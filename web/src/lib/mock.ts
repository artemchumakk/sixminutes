import type { Incident, SimResult, Station, VoiceInstruction } from "./types";

// ---- live local state (ambulance) -----------------------------------------
// Placeholder numbers shaped to look real. Swap for backend data later.

export const STATIONS: Station[] = [
  { id: "st-01", name: "Waterloo HQ", lat: 0.58, lng: 0.5, units: 8, status: "ready", load: 0.42 },
  { id: "st-02", name: "Hanwell", lat: 0.46, lng: 0.16, units: 4, status: "busy", load: 0.81 },
  { id: "st-03", name: "Edmonton", lat: 0.2, lng: 0.62, units: 5, status: "ready", load: 0.55 },
  { id: "st-04", name: "Greenwich", lat: 0.66, lng: 0.74, units: 6, status: "ready", load: 0.38 },
  { id: "st-05", name: "Croydon", lat: 0.9, lng: 0.46, units: 3, status: "busy", load: 0.88 },
  { id: "st-06", name: "Romford", lat: 0.34, lng: 0.9, units: 4, status: "offline", load: 0 },
  { id: "st-07", name: "Wembley NW", lat: 0.3, lng: 0.3, units: 5, status: "ready", load: 0.49 },
];

export const INCIDENTS: Incident[] = [
  { id: "AS-4471", category: "C1", ward: "Lambeth", ageSec: 42, station: "Waterloo HQ", etaSec: 318 },
  { id: "AS-4472", category: "C2", ward: "Ealing", ageSec: 96, station: "Hanwell", etaSec: 690 },
  { id: "AS-4473", category: "C1", ward: "Enfield", ageSec: 18, station: "Edmonton", etaSec: 402 },
  { id: "AS-4474", category: "C3", ward: "Bromley", ageSec: 410, station: "Croydon", etaSec: 1240 },
  { id: "AS-4475", category: "C2", ward: "Newham", ageSec: 150, station: "Romford", etaSec: 880 },
  { id: "AS-4476", category: "C1", ward: "Greenwich", ageSec: 8, station: "Greenwich", etaSec: 286 },
];

export const FLEET = {
  unitsAvailable: 23,
  unitsTotal: 35,
  meanResponse: 430, // seconds, C1
  p90Response: 734,
  targetC1: 420,
  openIncidents: INCIDENTS.length,
};

// ---- suggested agent commands ---------------------------------------------

export const SUGGESTIONS = [
  "Close Wembley NW base — what does it cost?",
  "Which station closure hurts C1 response least?",
  "Simulate a strike day across north-east London",
  "Rank all bases by closure damage",
];

// ---- recent chats (for Search) --------------------------------------------

export interface ChatCard {
  id: string;
  title: string;
  folder: string;
  when: string;
  summary: string;
}

export const CHATS: ChatCard[] = [
  { id: "c1", title: "Close Wembley NW base", folder: "Folder", when: "2m", summary: "Tested shutting Wembley NW and found C1 response slipping ~95 seconds with 40 calls a year pushed past the 7-minute promise." },
  { id: "c2", title: "Strike-day posture · NE London", folder: "Folder", when: "1h", summary: "Modelled a strike with north-east bases at 40% staffing and saw p90 breach 18 minutes across Enfield and Newham." },
  { id: "c3", title: "Rank all bases by closure damage", folder: "Folder", when: "3h", summary: "Ranked every base by closure damage and confirmed call volume points to the wrong stations to close." },
  { id: "c4", title: "C2 tail analysis · Croydon", folder: "Audits", when: "yesterday", summary: "Dug into why Croydon's C2 mean sits near 34 minutes and where the long tail of late jobs is concentrated." },
  { id: "c5", title: "Greenwich unit pre-position", folder: "Folder", when: "yesterday", summary: "Checked whether holding one Greenwich unit in reserve recovers response time during peak load." },
  { id: "c6", title: "Move pump from Waterloo HQ", folder: "Drafts", when: "2d", summary: "Explored relocating a unit out of Waterloo HQ and found the dense overlap absorbs the loss almost for free." },
  { id: "c7", title: "Storm scenario · Thames flood", folder: "Audits", when: "2d", summary: "Ran a Thames-flood storm scenario to see which riverside wards lose coverage when roads close." },
  { id: "c8", title: "Edmonton coverage hole", folder: "Folder", when: "3d", summary: "Identified Edmonton as the most damaging closure because its calls fall back onto distant bases." },
  { id: "c9", title: "Romford offline impact", folder: "Drafts", when: "4d", summary: "Took Romford offline and traced how north-east demand leans on Edmonton to fill the gap." },
  { id: "c10", title: "p90 breach map · all wards", folder: "Audits", when: "5d", summary: "Mapped where the 90th-percentile response time breaches target across every London ward." },
  { id: "c11", title: "Demand surface refresh", folder: "Folder", when: "1w", summary: "Rebuilt the incident demand surface from the latest data and compared it against last year's pattern." },
  { id: "c12", title: "Transfer model validation", folder: "Audits", when: "1w", summary: "Validated the fire-learned travel model on ambulance C1 jobs and reported the aggregate gap honestly." },
  { id: "c13", title: "Hanwell load rebalance", folder: "Drafts", when: "1w", summary: "Looked at rebalancing Hanwell's 81% load by shifting demand to neighbouring catchments." },
  { id: "c14", title: "Bromley night-shift cover", folder: "Folder", when: "2w", summary: "Reviewed overnight cover around Bromley and where the thinnest hours leave gaps." },
  { id: "c15", title: "Closure damage vs call count", folder: "Audits", when: "2w", summary: "Showed the negative correlation between how busy a base looks and how much its closure actually hurts." },
  { id: "c16", title: "C1 mean drift · Q2", folder: "Folder", when: "2w", summary: "Tracked the quarter-on-quarter drift in C1 mean response and flagged it sitting above target." },
  { id: "c17", title: "Newham response review", folder: "Drafts", when: "3w", summary: "Reviewed Newham's response profile and the wards most exposed when nearby units are committed." },
  { id: "c18", title: "Fleet sizing experiment", folder: "Audits", when: "1mo", summary: "Experimented with total fleet size to find the point where adding units stops improving the promise." },
];

// ---- voice agent canned instructions --------------------------------------

export const VOICE_SCRIPT: VoiceInstruction[] = [
  { id: "v1", kind: "info", text: "Standing by. C1 mean response is holding at 430 seconds, ten above target." },
  { id: "v2", kind: "alert", text: "Croydon is at 88% load with 3 units. Recommend pre-positioning one unit from Greenwich." },
  { id: "v3", kind: "action", text: "Incident AS-4473 in Enfield is C1, 18 seconds old. Nearest ready unit: Edmonton, ETA 6 minutes 42." },
  { id: "v4", kind: "info", text: "Romford is offline for the strike scenario. North-east coverage now leans on Edmonton." },
];

// ---- mock "agent" ----------------------------------------------------------
// Maps a free-text command to a canned simulation result + narration.

const round = (n: number) => Math.round(n);

function buildResult(input: string): SimResult {
  const q = input.toLowerCase();

  if (q.includes("rank") || q.includes("least") || q.includes("all base")) {
    return {
      title: "Closure damage ranking",
      scenario: "Each base closed in turn · 50k synthetic C1 incidents replayed",
      meanBefore: 430,
      meanAfter: 430,
      p90Before: 734,
      p90After: 734,
      callsOverTarget: 0,
      verdict: "medium",
      note: "Most damaging: Edmonton (+161s, NE coverage hole). Least: Waterloo HQ (+22s, dense overlap). Call-count ranking would have closed Edmonton first — the opposite of what the physics says.",
    };
  }

  if (q.includes("strike")) {
    return {
      title: "Strike-day posture",
      scenario: "North-east bases at 40% staffing · demand held at baseline",
      meanBefore: 430,
      meanAfter: 612,
      p90Before: 734,
      p90After: 1180,
      callsOverTarget: 1430,
      verdict: "high",
      note: "p90 breaches 18 minutes across Enfield, Newham and Havering. Holding one Edmonton unit in reserve recovers ~90s of the p90 tail.",
    };
  }

  // default: close a named base (pull the name out loosely)
  const named =
    STATIONS.find((s) => q.includes(s.name.toLowerCase().split(" ")[0])) ??
    (q.includes("nw") || q.includes("wembley") ? STATIONS[6] : undefined) ??
    STATIONS[6];

  const dmg = 0.6 + named.load; // busier/edge bases cost more
  const meanAfter = round(430 + 70 * dmg);
  const p90After = round(734 + 150 * dmg);
  return {
    title: `Close ${named.name}`,
    scenario: `${named.name} offline · nearest-station fallback · fire-learned travel model`,
    meanBefore: 430,
    meanAfter,
    p90Before: 734,
    p90After,
    callsOverTarget: round(40 * dmg),
    verdict: dmg > 1.4 ? "high" : dmg > 1.0 ? "medium" : "low",
    note: `${named.name} sits on the edge of its catchment, so its calls fall back onto distant bases. Damage is ${dmg > 1.2 ? "high despite modest call volume — a classic spreadsheet blind spot." : "moderate; nearby overlap absorbs most of the load."}`,
  };
}

export function agentReply(input: string): { text: string; result: SimResult } {
  const result = buildResult(input);
  const deltaMean = result.meanAfter - result.meanBefore;
  const text =
    deltaMean === 0
      ? `Ran the counterfactual against ground truth. Here's the ranking — the headline is that call volume points the wrong way.`
      : `Replayed historical C1 incidents under that posture. Mean response moves ${deltaMean >= 0 ? "+" : ""}${deltaMean}s and roughly ${result.callsOverTarget} extra calls per year breach the 7-minute promise.`;
  return { text, result };
}
