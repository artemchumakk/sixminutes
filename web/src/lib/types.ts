export type ServiceId = "fire" | "ambulance" | "police";

export interface Workspace {
  id: ServiceId;
  name: string;
  short: string;
  icon: string;
  /** the "clock promise" in minutes */
  promiseMin: number;
  accent: string;
  /** is this workspace owned by another team / not built here yet */
  available: boolean;
  blurb: string;
}

export type Role = "agent" | "user" | "system";

export interface ChatMessage {
  id: string;
  role: Role;
  /** plain text body (may stream in) */
  text: string;
  /** optional structured simulation result rendered as a card */
  result?: SimResult;
  pending?: boolean;
}

export interface SimResult {
  title: string;
  scenario: string;
  meanBefore: number; // seconds
  meanAfter: number;
  p90Before: number;
  p90After: number;
  callsOverTarget: number; // extra incidents pushed past the promise / year
  verdict: "low" | "medium" | "high";
  note: string;
}

export interface Station {
  id: string;
  name: string;
  lat: number; // 0..1 normalised for the mini-map
  lng: number;
  units: number;
  status: "ready" | "busy" | "offline";
  load: number; // 0..1
}

export interface Incident {
  id: string;
  category: "C1" | "C2" | "C3" | "C4";
  ward: string;
  ageSec: number;
  station: string;
  etaSec: number;
}

export interface VoiceInstruction {
  id: string;
  text: string;
  kind: "info" | "action" | "alert";
}
