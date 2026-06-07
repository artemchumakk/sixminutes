// SIXMINUTES ambulance backend (FastAPI on :8096, see api_ambulance.py).
// Same route surface + response shapes as the fire client (lib/api.ts), so the map
// components can be near-identical. Kept separate so the fire data path is untouched.
export const AMB_API =
  (import.meta as { env?: Record<string, string> }).env?.VITE_AMBULANCE_API ??
  "http://localhost:8096";

export interface Station {
  name: string;
  lat: number;
  lon: number;
  pumps: number; // vehicle count (field named `pumps` for shape-parity with the fire map)
}

export interface KpiSide {
  mean_s: number;
  p90_s: number;
  promise_rate: number;
}

export interface ScenarioResult {
  city: { mean_delta_s: number; p90_delta_s: number; pushed_past_6min: number };
  kpi: { base: KpiSide; scenario: KpiSide; n: number };
  hist: { edges: number[]; base: number[]; scenario: number[] };
  scale?: number;
  elapsed_s: number;
  window?: string;
  hours?: [number, number] | null;
  worst_wards: { ward: string; borough: string; delta_mean_s: number; n: number; pushed_360: number }[];
  ward_deltas?: Record<string, number>;
}

export interface BaselineInfo {
  n: number;
  window: string;
  window_n: number;
  mean_s: number;
  median_s: number;
  p90_s: number;
  promise_rate: number;
}

export interface StationDetail {
  name: string;
  pumps: number;
  nearest_cover: { name: string; km: number }[];
  calls_carried_per_yr: number;
  turnout_day_med_s: number | null;
  turnout_night_med_s: number | null;
  ground_wards: string[];
  closure: { local_added_s: number; pushed_past_6min: number; city_added_s: number } | null;
}

export interface AskContext {
  station?: string;
  closed?: string[];
  hours?: [number, number] | null;
}

export type HourBand = [number, number] | null;

export interface UiCommand {
  id: number;
  type: string;
  text?: string;
  names?: string[];
  name?: string;
  url?: string;
}

export async function fetchStations(): Promise<Station[]> {
  const r = await fetch(`${AMB_API}/stations`);
  if (!r.ok) throw new Error(`stations: ${r.status}`);
  return r.json();
}

export async function fetchWardsGeo(): Promise<GeoJSON.FeatureCollection> {
  const r = await fetch(`${AMB_API}/wards_geo`);
  if (!r.ok) throw new Error(`wards_geo: ${r.status}`);
  return r.json();
}

export async function fetchBaseline(hours: HourBand): Promise<BaselineInfo> {
  const q = hours ? `?hours=${hours[0]},${hours[1]}` : "";
  const r = await fetch(`${AMB_API}/baseline${q}`);
  if (!r.ok) throw new Error(`baseline: ${r.status}`);
  return r.json();
}

export async function fetchStationDetail(name: string): Promise<StationDetail> {
  const r = await fetch(`${AMB_API}/station/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`station: ${r.status}`);
  return r.json();
}

export async function askAgent(
  text: string,
  speak = false,
  context?: AskContext
): Promise<{ answer?: string; detail?: string; status: number }> {
  const r = await fetch(`${AMB_API}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, speak, context }),
  });
  const body = await r.json().catch(() => ({}));
  return { ...body, status: r.status };
}

export async function transcribeVoice(blob: Blob): Promise<{ text: string }> {
  const form = new FormData();
  form.append("file", blob, "voice.webm");
  const r = await fetch(`${AMB_API}/voice/transcribe`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`transcribe: ${r.status}`);
  return r.json();
}

export async function fetchCommands(since: number): Promise<{ next: number; commands: UiCommand[] }> {
  const r = await fetch(`${AMB_API}/ui/commands?since=${since}`);
  if (!r.ok) throw new Error(`commands: ${r.status}`);
  return r.json();
}

export async function runScenario(close: string[], hours: HourBand): Promise<ScenarioResult> {
  const r = await fetch(`${AMB_API}/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ close, hours }),
  });
  if (!r.ok) throw new Error(`scenario: ${r.status}`);
  return r.json();
}

// ---- Insight 1: the broken Category-2 promise (real AmbSYS, citywide) --------
export interface C2Point {
  year: number;
  month: number;
  label: string;
  c2_mean_min: number;
  c2_p90_min: number | null;
  c1_mean_min: number | null;
}
export interface C2Series {
  org: string;
  source: string;
  standards_min: { c2_mean: number; c2_p90: number; c1_mean: number; c1_p90: number };
  series: C2Point[];
  headline: {
    latest: C2Point | null;
    worst: C2Point | null;
    winter_mean_min: number | null;
    summer_mean_min: number | null;
  };
}
export async function fetchC2Series(): Promise<C2Series> {
  const r = await fetch(`${AMB_API}/c2_series`);
  if (!r.ok) throw new Error(`c2_series: ${r.status}`);
  return r.json();
}

// ---- Insight 2: per-cell coverage surface (the hero map heatmap) -------------
export type DemandCategory = "proxy_all" | "assault" | "alcohol";
export interface CoverageCell {
  cell: string;
  lat: number;
  lon: number;
  demand: number;
  response_s: number | null;
  over_target: boolean;
}
export interface CoverageCells {
  hour: number;
  category: DemandCategory;
  target_s: number;
  n_cells: number;
  demand_total: number;
  window_n: number;
  summary: { mean_s: number; p90_s: number; pct_over_target: number };
  cells: CoverageCell[];
}
export async function fetchCoverageCells(
  hour = 18,
  category: DemandCategory = "proxy_all"
): Promise<CoverageCells> {
  const r = await fetch(`${AMB_API}/coverage_cells?hour=${hour}&category=${category}`);
  if (!r.ok) throw new Error(`coverage_cells: ${r.status}`);
  return r.json();
}

// ---- Insight 3: predictive-posture playbooks --------------------------------
export type Bucket = "night" | "am" | "pm" | "eve";
export interface CellCoord { lat: number; lon: number }
export interface CoverStat { mean_s: number; p90_s: number; pct_over_target: number }

export interface StandbyResult {
  bucket: string;
  rep_hour: number;
  coverage: CoverStat;
  total_demand: number;
  standby_here: { cell: string; demand: number; cur_response_s: number }[];
  cell_coords?: Record<string, CellCoord>;
}
export interface HandoverResult {
  hospital: string;
  units_stuck: number;
  bucket: string;
  baseline: CoverStat;
  during_drain: CoverStat;
  newly_exposed_cells: number;
  exposed_demand: number;
  best_patch_cell: string | null;
  patched_mean_s: number;
  cell_coords?: Record<string, CellCoord>;
}
export interface WinterResult {
  bucket: string;
  stuck_fraction_pct: number;
  units_stuck: number;
  normal: CoverStat;
  surge_peak: CoverStat;
  standby_added: string[];
  recovered_to: CoverStat;
  cell_coords?: Record<string, CellCoord>;
}
export interface Hospital { name: string; lat: number; lon: number }

export async function fetchHospitals(): Promise<Hospital[]> {
  const r = await fetch(`${AMB_API}/hospitals`);
  if (!r.ok) throw new Error(`hospitals: ${r.status}`);
  return r.json();
}
export async function fetchStandby(bucket: Bucket = "pm"): Promise<StandbyResult> {
  const r = await fetch(`${AMB_API}/posture/standby?bucket=${bucket}`);
  if (!r.ok) throw new Error(`posture/standby: ${r.status}`);
  return r.json();
}
export async function fetchHandover(hospital: string, bucket: Bucket = "pm", nUnits = 6): Promise<HandoverResult> {
  const r = await fetch(
    `${AMB_API}/posture/handover?hospital=${encodeURIComponent(hospital)}&bucket=${bucket}&n_units=${nUnits}`
  );
  if (!r.ok) throw new Error(`posture/handover: ${r.status}`);
  return r.json();
}
export async function fetchWinter(bucket: Bucket = "eve", stuckFrac = 0.15, nStandby = 5): Promise<WinterResult> {
  const r = await fetch(
    `${AMB_API}/posture/winter?bucket=${bucket}&stuck_frac=${stuckFrac}&n_standby=${nStandby}`
  );
  if (!r.ok) throw new Error(`posture/winter: ${r.status}`);
  return r.json();
}
