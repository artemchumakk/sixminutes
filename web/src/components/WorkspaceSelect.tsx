import { WORKSPACES } from "../lib/workspaces";
import type { ServiceId } from "../lib/types";
import { cx } from "./ui/primitives";

export default function WorkspaceSelect({ onEnter }: { onEnter: (id: ServiceId) => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-3xl">
        <div className="mb-10 text-center">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.3em] text-neutral-400">
            London Blue-Light Digital Twin
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">
            SIX<span className="text-neutral-300">·</span>MINUTES
          </h1>
          <p className="mt-3 text-[15px] text-neutral-500">
            Choose your workspace to enter the dispatch console.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {WORKSPACES.map((w) => {
            const disabled = !w.available;
            return (
              <button
                key={w.id}
                disabled={disabled}
                onClick={() => onEnter(w.id)}
                style={{ ["--accent" as string]: w.accent }}
                className={cx(
                  "group relative flex h-44 flex-col justify-between rounded-2xl border bg-white p-4 text-left transition-all duration-200",
                  disabled
                    ? "cursor-not-allowed border-neutral-200 opacity-60"
                    : "border-neutral-200 hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)]"
                )}
              >
                <div className="flex items-start justify-between">
                  <span className="text-2xl" style={{ color: w.accent }}>
                    {w.icon}
                  </span>
                  {disabled ? (
                    <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-400">
                      locked
                    </span>
                  ) : (
                    <span className="text-[13px] font-medium text-neutral-400 transition-colors group-hover:text-neutral-900">
                      enter →
                    </span>
                  )}
                </div>
                <div>
                  <div className="text-[15px] font-medium text-neutral-900">{w.short}</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-neutral-400">{w.name}</div>
                  <div className="mt-2 text-[12px] font-medium" style={{ color: w.accent }}>
                    {w.promiseMin}-min promise
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <p className="mt-8 text-center text-[12px] text-neutral-400">
          Fire &amp; Police workspaces owned by parallel teams · Ambulance live
        </p>
      </div>
    </div>
  );
}
