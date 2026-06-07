// Ambulance-owned chat/handle shapes. Structurally identical to the fire map's
// (so the shared Chat.tsx can drive either map by ref), but defined here so the
// ambulance tier no longer imports from the fire components — it owns its surface.

export interface AmbMsg {
  id: number;
  role: "user" | "agent";
  text: string;
  pending?: boolean;
}

export interface AmbMapHandle {
  ask: (text: string, speak?: boolean) => void;
  clearChat: () => void;
  note: (text: string) => void;
  stopAudio: () => void;
}
