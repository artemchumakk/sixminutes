/**
 * Voice mode UI (PREVIEW — for the ElevenLabs integration).
 * - SpeakingOrb: the agent presence, a soft cyan/red/white orb with faint
 *   sound-wave rings.
 * - RecordingBar: replaces the composer; a subtle dark waveform of captured
 *   mic audio with a stop button.
 * When the API is wired in: drive the orb scale from the agent's output
 * amplitude, and the RecordingBar bars from the mic input amplitude.
 */

export function SpeakingOrb({ accent }: { accent: string }) {
  void accent;
  return (
    <div className="flex flex-col items-center gap-7">
      <div className="relative flex h-56 w-56 items-center justify-center">
        {/* faint sound-wave rings */}
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="absolute h-full w-full rounded-full border"
            style={{
              borderColor: "rgba(34,211,238,0.22)",
              animation: `pulse-ring 2.8s ease-out ${i * 0.7}s infinite`,
            }}
          />
        ))}
        {/* orb — cyan / red / white */}
        <div
          className="relative h-32 w-32 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 32% 26%, #ffffff 0%, #a5f3fc 26%, #22d3ee 52%, #fb7185 100%)",
            boxShadow: "0 0 70px rgba(34,211,238,0.30), 0 0 40px rgba(251,113,133,0.20)",
            animation: "orb-breathe 2.8s ease-in-out infinite",
          }}
        />
      </div>
      <div className="text-[12px] font-medium uppercase tracking-[0.16em] text-neutral-400">
        Listening…
      </div>
    </div>
  );
}

export function RecordingBar({ accent, onStop }: { accent: string; onStop: () => void }) {
  void accent;
  const bars = Array.from({ length: 56 });
  return (
    <div className="flex items-center gap-3 rounded-[26px] border border-neutral-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {/* captured-audio waveform — subtle, black */}
      <div className="flex h-6 flex-1 items-center justify-center gap-[2px] overflow-hidden">
        {bars.map((_, i) => (
          <span
            key={i}
            className="w-[2px] rounded-full"
            style={{
              height: "100%",
              background: "rgba(20,20,20,0.55)",
              transformOrigin: "center",
              transform: "scaleY(0.18)",
              animation: `bar ${0.6 + (i % 7) * 0.13}s ease-in-out ${(i % 11) * 0.07}s infinite`,
            }}
          />
        ))}
      </div>

      <button
        onClick={onStop}
        title="Stop"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700"
      >
        <span className="h-3 w-3 rounded-[3px] bg-white" />
      </button>
    </div>
  );
}
