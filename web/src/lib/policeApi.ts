// SIXMINUTES — POLICE backend (FastAPI on :8096) client. Tier-B parallel to api.ts.
// Police-native: the unit is a 1 km demand cell, weighting is crimes/month, and the
// promise line is the 15-minute (900 s) Met I-grade target. Never points at the fire API.
export const POLICE_API =
  (import.meta as { env?: Record<string, string> }).env?.VITE_POLICE_API ??
  "http://localhost:8096";

/** ElevenLabs voice for the Watch Commander — identical voice/model to the fire tier.
 *  Returns the MP3 URL the browser can play directly (server 503s when no key is set). */
export const policeTtsUrl = (text: string): string =>
  `${POLICE_API}/tts?text=${encodeURIComponent(text.slice(0, 600))}`;

/** Whether server-side ElevenLabs voice is live (a key is configured). Falls back to
 *  false on any error so the caller can use the browser voice instead. */
export async function policeTtsReady(): Promise<boolean> {
  try {
    const r = await fetch(`${POLICE_API}/health`);
    if (!r.ok) return false;
    const j = (await r.json()) as { tts?: boolean };
    return Boolean(j?.tts);
  } catch {
    return false;
  }
}

export interface PoliceStation {
  name: string;
  kind: string;
  E: number;
  N: number;
  lat: number;
  lon: number;
}

export interface DemandCell {
  cell: string;
  lat: number;
  lon: number;
  weight: number; // crimes / month
}

export interface PoliceBaseline {
  cells: number;
  stations: number;
  crimes_per_mo: number;
  mean_response_s: number;
  target_s: number;
  overhead_s: number;
  eval_slice: { hour: number; dow: number; month: number };
}

export interface PredictCategory {
  category: string;
  now_per_mo: number;
  proj_next_mo: number;
  trend_3y_pct: number;
  share_pct: number;
}

export interface PredictResult {
  center: { lat: number; lon: number };
  radius_km: number;
  cells: number;
  sample_incidents_36mo: number;
  total_now_per_mo: number;
  total_proj_next_mo: number;
  categories: PredictCategory[];
}

export interface AllocStation {
  name: string;
  kind: string;
  bcu: string;
  lat: number;
  lon: number;
  demand_per_mo: number;
  cur_units: number;
  opt_units: number;
  delta: number;
  cur_workload: number;
}

export interface AllocResult {
  units: number;
  n_stations: number;
  total_demand_per_mo: number;
  even_per_station: number;
  worst_workload_now: number;
  workload_balanced: number;
  imbalance_now: number;
  stations: AllocStation[];
  under_resourced: { name: string; add: number; demand_per_mo: number; cur_workload: number }[];
  over_resourced: { name: string; spare: number; demand_per_mo: number; cur_workload: number }[];
}

export interface PlanStation {
  name: string;
  kind: string;
  bcu: string;
  borough: string;
  lat: number;
  lon: number;
  demand_now: number;
  demand_next: number;
  growth_pct: number;
  units_now: number;
  units_next: number;
  move: number; // whole officers, + = reinforce, - = free up (within-BCU split is modelled)
  move_raw: number;
  top_category: string;
  top_trend_pct: number;
}

/** A Basic Command Unit — the FULLY-real layer: officer totals are published and crime is
 *  real, so nothing is modelled at this level (officers are managed per BCU, not per station). */
export interface BcuRow {
  bcu: string;
  officers_now: number;   // today's real published strength
  officers_next: number;  // same total re-matched to next-month forecast crime
  move: number;           // officers to shift, + = reinforce, - = ease
  demand_now: number;
  demand_next: number;
  share_pct: number;      // share of city crime next month
  growth_pct: number;
  crimes_per_officer: number;
  top_category: string;
}

export interface PlanResult {
  units: number;          // real total officers across the 12 BCUs (~15,941)
  n_stations: number;
  n_bcus: number;
  even_per_station: number;
  total_now_per_mo: number;
  total_next_per_mo: number;
  growth_pct: number;
  total_moved: number;    // officers shifted between BCUs
  imbalance_before: number; // BCU-level crimes-per-officer spread (real)
  footprint_real: boolean;
  source: string;
  source_url: string;
  bcus: BcuRow[];         // the 12 areas, sorted by move (reinforce first)
  stations: PlanStation[];
  moves_to: PlanStation[];
  moves_from: PlanStation[];
}

export interface ScenarioCity {
  mean_delta_s: number;
  p90_delta_s: number;
  crimes_pushed_over_target: number;
  cells_pushed_over_target: number;
  category: string;
}

export interface WorstCell {
  cell: string;
  lat: number;
  lon: number;
  delta_s: number;
  crimes_per_mo: number;
  impact: number;
  near: string;
}

export interface PoliceScenario {
  posture: { close: string[]; category: string };
  city: ScenarioCity;
  worst_cells: WorstCell[];
  cell_deltas: { cell: string; lat: number; lon: number; delta_s: number }[];
}

export interface DamageProps {
  station: string;
  calls: number;
  mean_added_s: number;
  p90_added_s: number;
  pushed_over_target: number;
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${POLICE_API}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export const fetchStations = () => getJSON<PoliceStation[]>("/stations");
export const fetchCategories = () => getJSON<string[]>("/categories");
export const fetchBaseline = () => getJSON<PoliceBaseline>("/baseline");
export const fetchCells = (category = "all") =>
  getJSON<DemandCell[]>(`/cells?category=${encodeURIComponent(category)}`);
export const fetchDamage = () => getJSON<GeoJSON.FeatureCollection>("/damage");
export const fetchPredict = (lat: number, lon: number, radiusKm = 2.0) =>
  getJSON<PredictResult>(`/predict?lat=${lat}&lon=${lon}&radius_km=${radiusKm}`);
export const fetchAllocation = (units = 600) =>
  getJSON<AllocResult>(`/allocation?units=${units}`);
// `units` is ignored server-side — the plan total is the real published BCU officer strength.
export const fetchPlan = () => getJSON<PlanResult>(`/plan`);

export async function runScenario(close: string[], category = "all"): Promise<PoliceScenario> {
  const r = await fetch(`${POLICE_API}/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ close, category }),
  });
  if (!r.ok) throw new Error(`scenario: ${r.status}`);
  return r.json();
}

// Nominatim geocode, clamped to Greater London (matches the dark dashboard search box).
export interface GeoHit {
  display_name: string;
  lat: string;
  lon: string;
}
export async function geocode(q: string): Promise<GeoHit[]> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=gb" +
    "&viewbox=-0.55,51.72,0.34,51.25&bounded=1&q=" +
    encodeURIComponent(q);
  const r = await fetch(url, { headers: { "Accept-Language": "en-GB" } });
  if (!r.ok) throw new Error(`geocode: ${r.status}`);
  return r.json();
}
