import { useState } from "react";
import { WORKSPACES } from "../lib/workspaces";
import type { ServiceId } from "../lib/types";
import { cx } from "./ui/primitives";
import { ChevronDown } from "./ui/icons";

// one-to-two sentence, plain-English description per service (right of the card)
const DESCRIPTIONS: Record<ServiceId, string> = {
  ambulance:
    "Replays a year of real Category-1 calls so you can close a station and watch the 7-minute response promise move across every London ward.",
  fire:
    "London Fire Brigade. A validated digital twin of the brigade — click stations to take them offline and see London's 6-minute attendance re-simulate live, ward by ward.",
  police:
    "Metropolitan Police. The 15-minute response tier, owned by the police team. This workspace is still locked.",
};

// brief "what's inside" line — what the console actually gives you, per service
const INSIDE: Record<ServiceId, string> = {
  ambulance:
    "an interactive map of every London ambulance station, one-click closures, live ward-level response heatmaps, a scenario analyst panel, and a voice dispatch agent you can talk to.",
  fire:
    "every London fire station on a live map, instant station closures, a validated year-of-London scenario engine with ward heatmaps, and a voice-driven brigade analyst.",
  police:
    "the Met's response network and the same close-a-station scenario engine — locked until the police team ships it.",
};

export default function WorkspaceSelect({ onEnter }: { onEnter: (id: ServiceId) => void }) {
  const n = WORKSPACES.length;
  const [idx, setIdx] = useState(0);
  const w = WORKSPACES[idx];
  const disabled = !w.available;

  // infinite cycling: modulo wraps both directions so the arrows never run out
  const prev = () => setIdx((i) => (i - 1 + n) % n);
  const next = () => setIdx((i) => (i + 1) % n);

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16">
      {/* heading */}
      <div className="mb-16 text-center">
        <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.3em] text-neutral-400">
          London Blue-Light Digital Twin
        </div>
        <h1 className="text-5xl font-semibold tracking-tight text-neutral-900">CityWarden</h1>
        <p className="mt-3 text-[15px] text-neutral-500">
          A living digital twin of London's emergency services — pick a service, close a
          station, and watch response times move in real time.
        </p>
      </div>

      {/* carousel: arrows flank the card (left / right), description sits beside it */}
      <div className="flex items-center gap-14">
        <div className="flex items-center gap-8">
          <Arrow dir="left" onClick={prev} />
          <button
            key={w.id}
            disabled={disabled}
            onClick={() => !disabled && onEnter(w.id)}
            style={{ ["--accent" as string]: w.accent }}
            className={cx(
              "group relative flex h-[520px] w-[400px] animate-slide-in-right flex-col justify-between rounded-3xl border border-neutral-200 bg-white p-8 text-left shadow-[0_18px_50px_rgba(0,0,0,0.10)] transition-all duration-200",
              disabled
                ? "cursor-not-allowed opacity-70"
                : "hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-[0_24px_60px_rgba(0,0,0,0.14)]"
            )}
          >
            <span className="text-7xl" style={{ color: w.accent }}>
              {w.icon}
            </span>
            <div>
              <div className="text-[34px] font-semibold leading-tight tracking-tight text-neutral-900">
                {w.short}
              </div>
              <div className="mt-1.5 text-[15px] leading-snug text-neutral-400">{w.name}</div>
              <div className="mt-4 text-[15px] font-medium" style={{ color: w.accent }}>
                {w.promiseMin}-min promise
              </div>
            </div>
          </button>
          <Arrow dir="right" onClick={next} />
        </div>

        {/* description specific to the chosen card */}
        <div key={w.id + "-desc"} className="flex max-w-lg animate-slide-in-right flex-col justify-center">
          <div className="mb-3 text-[14px] font-medium uppercase tracking-[0.25em]" style={{ color: w.accent }}>
            {w.short} workspace
          </div>
          <h2 className="text-[44px] font-semibold leading-[1.05] tracking-tight text-neutral-900">
            {w.id === "ambulance" ? "London Ambulance" : w.name}
          </h2>
          <p className="mt-5 text-[19px] leading-relaxed text-neutral-600">{DESCRIPTIONS[w.id]}</p>
          <p className="mt-4 text-[15px] leading-relaxed text-neutral-500">
            <span className="font-medium text-neutral-700">Inside the console: </span>
            {INSIDE[w.id]}
          </p>
          <div className="mt-8">
            {disabled ? (
              <span className="inline-flex items-center rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-[15px] font-medium text-neutral-400">
                Locked · owned by the police tier team
              </span>
            ) : (
              <button
                onClick={() => onEnter(w.id)}
                className="inline-flex items-center gap-1.5 rounded-xl px-6 py-3.5 text-[16px] font-medium text-white shadow-[0_8px_20px_rgba(0,0,0,0.12)] transition-transform duration-150 ease-out hover:-translate-y-0.5 hover:scale-[1.04] hover:shadow-[0_12px_28px_rgba(0,0,0,0.18)] active:scale-95"
                style={{ backgroundColor: w.accent }}
              >
                Enter {w.short} console →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Arrow({ dir, onClick }: { dir: "left" | "right"; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={dir === "left" ? "Previous service" : "Next service"}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-500 shadow-sm transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-800"
    >
      <ChevronDown size={20} className={dir === "left" ? "rotate-90" : "-rotate-90"} />
    </button>
  );
}
