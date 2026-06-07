import { useEffect, useRef, useState } from "react";
import { VOICE_SCRIPT } from "../../lib/mock";
import type { VoiceInstruction, Workspace } from "../../lib/types";
import { cx, Pill, StatusDot } from "../ui/primitives";
import { Mic, Waveform, X } from "../ui/icons";

type Phase = "idle" | "listening" | "speaking";

/**
 * Voice agent UI. ElevenLabs API is being built separately — this is the full
 * front-end in PREVIEW mode. To go live: replace `emit()` with the real session
 * (start/stop + onTranscript + onInstruction callbacks). Nothing else changes.
 */
export default function VoiceAgent({
  ws,
  active,
  onClose,
}: {
  ws: Workspace;
  active: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<VoiceInstruction[]>([]);
  const [partial, setPartial] = useState("");
  const step = useRef(0);

  useEffect(() => {
    if (!active) {
      setPhase("idle");
      return;
    }
    setPhase("listening");
    const t = window.setTimeout(() => emit(), 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function emit() {
    const item = VOICE_SCRIPT[step.current % VOICE_SCRIPT.length];
    step.current += 1;
    setPhase("speaking");
    let i = 0;
    setPartial("");
    const timer = window.setInterval(() => {
      i += 2;
      setPartial(item.text.slice(0, i));
      if (i >= item.text.length) {
        window.clearInterval(timer);
        setLog((l) => [{ ...item }, ...l]);
        setPartial("");
        setPhase("listening");
      }
    }, 18);
  }

  return (
    <aside
      className={cx(
        "absolute right-0 top-0 z-30 flex h-full w-[340px] flex-col border-l border-neutral-200 bg-white shadow-[-8px_0_24px_rgba(0,0,0,0.04)] transition-transform duration-300",
        active ? "translate-x-0" : "translate-x-full"
      )}
    >
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Waveform size={16} className="text-neutral-500" />
          <span className="text-[13px] font-medium text-neutral-800">Voice agent</span>
          <Pill tone="warn">preview</Pill>
        </div>
        <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
          <X size={16} />
        </button>
      </header>

      {/* orb */}
      <div className="flex flex-col items-center gap-3 border-b border-neutral-200 py-7">
        <div className="relative flex h-24 w-24 items-center justify-center">
          {phase !== "idle" && (
            <>
              <span
                className="absolute h-full w-full rounded-full"
                style={{ background: `color-mix(in srgb, ${ws.accent} 22%, transparent)`, animation: "pulse-ring 2s ease-out infinite" }}
              />
              <span
                className="absolute h-2/3 w-2/3 rounded-full"
                style={{ background: `color-mix(in srgb, ${ws.accent} 18%, transparent)`, animation: "pulse-ring 2s ease-out 0.6s infinite" }}
              />
            </>
          )}
          <div
            className="relative flex h-16 w-16 items-center justify-center rounded-full border bg-white"
            style={{ borderColor: ws.accent, color: ws.accent }}
          >
            <Mic size={24} />
          </div>
        </div>
        <div className="flex items-center gap-2 text-[12px] uppercase tracking-wide text-neutral-500">
          <StatusDot tone={phase === "idle" ? "idle" : "ok"} pulse={phase !== "idle"} />
          {phase === "idle" ? "offline" : phase}
        </div>
      </div>

      {/* now speaking */}
      <div className="min-h-[60px] border-b border-neutral-200 px-4 py-3">
        {partial ? (
          <p className="text-[13.5px] leading-relaxed text-neutral-900">
            <span className="caret">{partial}</span>
          </p>
        ) : (
          <p className="text-[12.5px] text-neutral-400">
            {phase === "idle"
              ? "Connect the ElevenLabs session to begin spoken guidance."
              : "Listening for dispatcher commands…"}
          </p>
        )}
      </div>

      {/* log */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          Instructions to dispatcher
        </div>
        <div className="flex flex-col gap-2">
          {log.length === 0 && <div className="text-[12.5px] text-neutral-400">No guidance yet.</div>}
          {log.map((l, i) => (
            <div key={`${l.id}-${i}`} className="animate-fade-up rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5">
              <Pill tone={l.kind === "alert" ? "crit" : l.kind === "action" ? "accent" : "idle"}>{l.kind}</Pill>
              <p className="mt-1.5 text-[13px] leading-snug text-neutral-700">{l.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* controls */}
      <div className="border-t border-neutral-200 px-4 py-3">
        <button
          onClick={emit}
          disabled={!active}
          className="w-full rounded-xl border border-neutral-200 py-2 text-[12.5px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40"
        >
          ▸ Simulate next instruction
        </button>
        <p className="mt-2 text-center text-[10.5px] text-neutral-400">
          Mock cycle · live audio arrives when the ElevenLabs API is wired in
        </p>
      </div>
    </aside>
  );
}
