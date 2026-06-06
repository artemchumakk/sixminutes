// SIXMINUTES backend (FastAPI on :8095) — single source of truth for wiring
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

export interface ScenarioCity {
  mean_delta_s: number;
  p90_delta_s: number;
  pushed_past_6min: number;
}

export interface ScenarioResult {
  city: ScenarioCity;
  scale?: number;
  elapsed_s: number;
  window?: string;
  worst_wards: { ward: string; borough: string; delta_mean_s: number }[];
  ward_deltas?: Record<string, number>;
}

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

export async function runScenario(close: string[]): Promise<ScenarioResult> {
  const r = await fetch(`${API}/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ close }),
  });
  if (!r.ok) throw new Error(`scenario: ${r.status}`);
  return r.json();
}
