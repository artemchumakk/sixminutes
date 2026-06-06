import type { Workspace } from "../../lib/types";
import { FLEET, INCIDENTS, STATIONS } from "../../lib/mock";
import { cx, fmtSec, Metric, Panel, Pill, StatusDot } from "../ui/primitives";

export default function LocalView({ ws, onBack }: { ws: Workspace; onBack: () => void }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 pb-10">
        <div className="flex items-center justify-between py-4">
          <div>
            <h1 className="text-[19px] font-medium text-neutral-900">Local monitor</h1>
            <p className="text-[13px] text-neutral-500">
              Read-only view of the {ws.short.toLowerCase()} network — live state, no agent.
            </p>
          </div>
          <button
            onClick={onBack}
            className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-600 hover:bg-neutral-50"
          >
            ← Back to agent
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title="Fleet status" className="lg:col-span-3">
            <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-5">
              <Metric label="Units avail." value={`${FLEET.unitsAvailable}/${FLEET.unitsTotal}`} tone="ok" />
              <Metric
                label="C1 mean"
                value={fmtSec(FLEET.meanResponse)}
                tone={FLEET.meanResponse > FLEET.targetC1 ? "warn" : "ok"}
                sub={`target ${fmtSec(FLEET.targetC1)}`}
              />
              <Metric label="C1 p90" value={fmtSec(FLEET.p90Response)} tone="warn" />
              <Metric label="Open" value={FLEET.openIncidents} sub="live incidents" />
              <Metric label="Promise" value={`${ws.promiseMin}:00`} sub="the clock" />
            </div>
          </Panel>

          <Panel title="London — station coverage" className="lg:col-span-2" right={<Pill tone="accent">live</Pill>}>
            <MiniMap accent={ws.accent} />
          </Panel>

          <Panel title="Stations">
            <div className="flex flex-col divide-y divide-neutral-100">
              {STATIONS.map((s) => (
                <div key={s.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <StatusDot
                      tone={s.status === "ready" ? "ok" : s.status === "busy" ? "warn" : "crit"}
                      pulse={s.status === "busy"}
                    />
                    <div>
                      <div className="text-[13.5px] text-neutral-900">{s.name}</div>
                      <div className="text-[11px] uppercase tracking-wide text-neutral-400">
                        {s.status} · {s.units} units
                      </div>
                    </div>
                  </div>
                  <LoadBar v={s.load} accent={ws.accent} />
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title="Incident feed"
            className="lg:col-span-3"
            right={<span className="text-[12px] text-neutral-400">updated 4s ago</span>}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-[11px] uppercase tracking-wide text-neutral-400">
                    <th className="px-4 py-2 font-medium">ID</th>
                    <th className="px-4 py-2 font-medium">Cat</th>
                    <th className="px-4 py-2 font-medium">Ward</th>
                    <th className="px-4 py-2 font-medium">Assigned</th>
                    <th className="px-4 py-2 font-medium">Age</th>
                    <th className="px-4 py-2 font-medium">ETA</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[13px] tabular-nums">
                  {INCIDENTS.map((i) => {
                    const over = i.etaSec > ws.promiseMin * 60;
                    return (
                      <tr key={i.id} className="border-b border-neutral-100 last:border-0">
                        <td className="px-4 py-2.5 text-neutral-500">{i.id}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className={cx(
                              "rounded px-1.5 py-0.5 text-[11px]",
                              i.category === "C1" ? "bg-red-50 text-red-600" : "bg-neutral-100 text-neutral-500"
                            )}
                          >
                            {i.category}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-neutral-800">{i.ward}</td>
                        <td className="px-4 py-2.5 text-neutral-500">{i.station}</td>
                        <td className="px-4 py-2.5 text-neutral-500">{fmtSec(i.ageSec)}</td>
                        <td className={cx("px-4 py-2.5", over ? "text-red-600" : "text-green-600")}>
                          {fmtSec(i.etaSec)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function LoadBar({ v, accent }: { v: number; accent: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.round(v * 100)}%`, background: v > 0.8 ? "#dc2626" : accent }}
        />
      </div>
      <span className="w-8 text-right font-mono text-[11px] tabular-nums text-neutral-400">
        {Math.round(v * 100)}%
      </span>
    </div>
  );
}

function MiniMap({ accent }: { accent: string }) {
  return (
    <div className="relative m-4 h-[260px] overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`v${i}`} x1={`${(i / 8) * 100}%`} y1="0" x2={`${(i / 8) * 100}%`} y2="100%" stroke="#ececec" strokeWidth="1" />
        ))}
        {Array.from({ length: 6 }).map((_, i) => (
          <line key={`h${i}`} x1="0" y1={`${(i / 5) * 100}%`} x2="100%" y2={`${(i / 5) * 100}%`} stroke="#ececec" strokeWidth="1" />
        ))}
      </svg>
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
        <path d="M -5 55 C 25 70, 45 45, 60 58 S 90 70, 110 52" fill="none" stroke="#dbeafe" strokeWidth="7" />
      </svg>
      {STATIONS.map((s) => {
        const tone = s.status === "ready" ? "#16a34a" : s.status === "busy" ? "#d97706" : "#dc2626";
        return (
          <div
            key={s.id}
            className="group absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${s.lng * 100}%`, top: `${s.lat * 100}%` }}
          >
            <span className="block h-2.5 w-2.5 rounded-full ring-2 ring-white" style={{ background: tone }} />
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[11px] text-neutral-700 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
              style={{ color: accent }}
            >
              {s.name}
            </span>
          </div>
        );
      })}
      <div className="absolute bottom-2 left-2 text-[10px] uppercase tracking-wide text-neutral-400">
        schematic · normalised coords
      </div>
    </div>
  );
}
