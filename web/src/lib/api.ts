// WARDEN backend (FastAPI on :8095) — single source of truth for wiring
// ynkvch's UI to the validated twin, one workspace at a time.
export const API =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SIXMINUTES_API ??
  "http://localhost:8095";

export interface Station {
  name: string;
  lat: number;
  lon: number;
  pumps: number;
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

export async function fetchStations(): Promise<Station[]> {
  const r = await fetch(`${API}/stations`);
  if (!r.ok) throw new Error(`stations: ${r.status}`);
  return r.json();
}

export async function fetchWardsGeo(): Promise<GeoJSON.FeatureCollection> {
  const r = await fetch(`${API}/wards_geo`);
  if (!r.ok) throw new Error(`wards_geo: ${r.status}`);
  return r.json();
}

export async function fetchBaseline(hours: HourBand): Promise<BaselineInfo> {
  const q = hours ? `?hours=${hours[0]},${hours[1]}` : "";
  const r = await fetch(`${API}/baseline${q}`);
  if (!r.ok) throw new Error(`baseline: ${r.status}`);
  return r.json();
}

export async function fetchStationDetail(name: string): Promise<StationDetail> {
  const r = await fetch(`${API}/station/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`station: ${r.status}`);
  return r.json();
}

export interface UiCommand {
  id: number;
  type: string;
  text?: string;
  names?: string[];
  name?: string;
  url?: string;
}

export async function askAgent(
  text: string,
  speak = false,
  context?: AskContext
): Promise<{ answer?: string; detail?: string; status: number }> {
  const r = await fetch(`${API}/ask`, {
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
  const r = await fetch(`${API}/voice/transcribe`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`transcribe: ${r.status}`);
  return r.json();
}

export async function fetchCommands(since: number): Promise<{ next: number; commands: UiCommand[] }> {
  const r = await fetch(`${API}/ui/commands?since=${since}`);
  if (!r.ok) throw new Error(`commands: ${r.status}`);
  return r.json();
}

export async function runScenario(close: string[], hours: HourBand): Promise<ScenarioResult> {
  const r = await fetch(`${API}/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ close, hours }),
  });
  if (!r.ok) throw new Error(`scenario: ${r.status}`);
  return r.json();
}
