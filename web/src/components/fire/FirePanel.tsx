import type { BaselineInfo, HourBand, ScenarioResult, StationDetail } from "../../lib/api";

const fmtS = (v: number) => `${Math.round(v)}s`;
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const SCALE_FALLBACK = 3.32;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-100 px-4 py-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, base, scen, better }: { label: string; base: string; scen?: string; better?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-[13px]">
      <span className="text-neutral-500">{label}</span>
      <span className="tabular-nums">
        <span className="text-neutral-400">{base}</span>
        {scen !== undefined && (
          <>
            <span className="mx-1.5 text-neutral-300">→</span>
            <b className={better ? "text-emerald-600" : "text-red-600"}>{scen}</b>
          </>
        )}
      </span>
    </div>
  );
}

export function HourBandControl({
  value,
  onChange,
}: {
  value: HourBand;
  onChange: (h: HourBand) => void;
}) {
  const opts: { label: string; v: HourBand }[] = [
    { label: "24h", v: null },
    { label: "Rush 7–10", v: [7, 10] },
    { label: "Day 10–18", v: [10, 18] },
    { label: "Night 22–6", v: [22, 6] },
  ];
  return (
    <div className="flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
      {opts.map((o) => {
        const active = JSON.stringify(o.v) === JSON.stringify(value);
        return (
          <button
            key={o.label}
            onClick={() => onChange(o.v)}
            className={
              "flex-1 rounded-md px-2 py-1 text-[12px] transition-colors " +
              (active ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Histogram({ result, accent }: { result: ScenarioResult; accent: string }) {
  const { edges, base, scenario } = result.hist;
  const max = Math.max(...base, ...scenario, 1);
  const W = 272;
  const H = 64;
  const n = base.length;
  const bw = W / n;
  return (
    <svg width={W} height={H + 14} className="block">
      {base.map((b, i) => {
        const s = scenario[i];
        const bh = (b / max) * H;
        const sh = (s / max) * H;
        return (
          <g key={i}>
            <rect x={i * bw + 1} y={H - bh} width={bw / 2 - 1.5} height={bh} rx={1.5} fill="#d4d4d4" />
            <rect x={i * bw + bw / 2} y={H - sh} width={bw / 2 - 1.5} height={sh} rx={1.5}
                  fill={s > b ? "#dc2626" : accent} opacity={0.85} />
          </g>
        );
      })}
      {/* 6-minute promise line */}
      {(() => {
        const idx = edges.indexOf(360);
        if (idx < 0) return null;
        const x = idx * bw;
        return (
          <g>
            <line x1={x} y1={0} x2={x} y2={H} stroke="#dc2626" strokeWidth={1} strokeDasharray="3,2" />
            <text x={x + 3} y={10} fontSize={9} fill="#dc2626">6 min</text>
          </g>
        );
      })()}
      <text x={0} y={H + 11} fontSize={9} fill="#a3a3a3">0s</text>
      <text x={W - 38} y={H + 11} fontSize={9} fill="#a3a3a3">&gt;900s</text>
    </svg>
  );
}

function copyBrief(closed: string[], r: ScenarioResult) {
  const scale = r.scale ?? SCALE_FALLBACK;
  const lines = [
    `SIXMINUTES scenario brief — ${r.window ?? "latest 12 months"}${r.hours ? ` · hours ${r.hours[0]}–${r.hours[1]}` : ""}`,
    `Posture: close ${closed.join(", ")}`,
    `Mean attendance: ${fmtS(r.kpi.base.mean_s)} → ${fmtS(r.kpi.scenario.mean_s)} (+${r.city.mean_delta_s}s)`,
    `p90: ${fmtS(r.kpi.base.p90_s)} → ${fmtS(r.kpi.scenario.p90_s)}`,
    `6-min promise kept: ${fmtPct(r.kpi.base.promise_rate)} → ${fmtPct(r.kpi.scenario.promise_rate)}`,
    `Incidents pushed past 6 min: ~${Math.round(r.city.pushed_past_6min * scale).toLocaleString()}/yr`,
    `Worst wards: ${r.worst_wards.slice(0, 5).map((w) => `${w.ward} +${Math.round(w.delta_mean_s)}s`).join("; ")}`,
    `Engine: validated DES (blind-2025 ±5%), n=${r.kpi.n.toLocaleString()} sampled incidents, ${r.elapsed_s}s compute.`,
  ];
  navigator.clipboard.writeText(lines.join("\n")).catch(() => undefined);
}

function downloadCsv(r: ScenarioResult) {
  const rows = [
    "ward,borough,n,delta_mean_s,pushed_past_6min",
    ...r.worst_wards.map((w) => `"${w.ward}","${w.borough}",${w.n},${w.delta_mean_s.toFixed(1)},${w.pushed_360}`),
  ];
  const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "sixminutes_scenario_wards.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function FirePanel({
  accent,
  baseline,
  hours,
  onHours,
  closed,
  onReopen,
  result,
  running,
  station,
}: {
  accent: string;
  baseline: BaselineInfo | null;
  hours: HourBand;
  onHours: (h: HourBand) => void;
  closed: string[];
  onReopen: (name: string) => void;
  result: ScenarioResult | null;
  running: boolean;
  station: StationDetail | null;
}) {
  const scale = result?.scale ?? SCALE_FALLBACK;
  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto rounded-2xl border border-neutral-200 bg-white/95 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm">
      <Section title="Replay window">
        <HourBandControl value={hours} onChange={onHours} />
        {baseline && (
          <div className="mt-2.5">
            <Row label="incidents (window)" base={baseline.window_n.toLocaleString()} />
            <Row label="mean attendance" base={fmtS(baseline.mean_s)} />
            <Row label="p90 attendance" base={fmtS(baseline.p90_s)} />
            <Row label="6-min promise kept" base={fmtPct(baseline.promise_rate)} />
          </div>
        )}
      </Section>

      <Section title={`Scenario · ${closed.length} closed`}>
        {closed.length === 0 ? (
          <p className="text-[13px] leading-5 text-neutral-400">
            Click stations on the map to close them. The latest 12 months of London
            re-simulate automatically.
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {closed.map((n) => (
                <button
                  key={n}
                  onClick={() => onReopen(n)}
                  className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-[12px] text-red-700 hover:bg-red-100"
                >
                  {n} ✕
                </button>
              ))}
            </div>
            {running && <div className="py-2 text-[13px] text-neutral-400">simulating a year of London…</div>}
            {result && !running && (
              <>
                <Row label="mean" base={fmtS(result.kpi.base.mean_s)} scen={fmtS(result.kpi.scenario.mean_s)}
                     better={result.kpi.scenario.mean_s <= result.kpi.base.mean_s} />
                <Row label="p90" base={fmtS(result.kpi.base.p90_s)} scen={fmtS(result.kpi.scenario.p90_s)}
                     better={result.kpi.scenario.p90_s <= result.kpi.base.p90_s} />
                <Row label="promise kept" base={fmtPct(result.kpi.base.promise_rate)}
                     scen={fmtPct(result.kpi.scenario.promise_rate)}
                     better={result.kpi.scenario.promise_rate >= result.kpi.base.promise_rate} />
                <Row label="pushed past 6 min"
                     base={`~${Math.round(result.city.pushed_past_6min * scale).toLocaleString()}/yr`} />
                <div className="mt-2.5">
                  <Histogram result={result} accent={accent} />
                  <div className="mt-1 flex gap-3 text-[10.5px] text-neutral-400">
                    <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-neutral-300" />baseline</span>
                    <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: accent }} />scenario</span>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => copyBrief(closed, result)}
                          className="flex-1 rounded-lg border border-neutral-200 px-2 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50">
                    Copy brief
                  </button>
                  <button onClick={() => downloadCsv(result)}
                          className="flex-1 rounded-lg border border-neutral-200 px-2 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50">
                    Ward CSV
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </Section>

      {result && !running && result.worst_wards.length > 0 && (
        <Section title="Affected wards">
          <div className="max-h-44 overflow-y-auto pr-1">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-neutral-400">
                  <th className="pb-1 font-medium">ward</th>
                  <th className="pb-1 text-right font-medium">Δ mean</th>
                  <th className="pb-1 text-right font-medium">pushed</th>
                </tr>
              </thead>
              <tbody>
                {result.worst_wards.map((w) => (
                  <tr key={w.ward + w.borough} className="border-t border-neutral-100">
                    <td className="py-1 pr-2 text-neutral-700">{w.ward}</td>
                    <td className="py-1 text-right tabular-nums text-red-600">+{Math.round(w.delta_mean_s)}s</td>
                    <td className="py-1 text-right tabular-nums text-neutral-500">{w.pushed_360}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {station && (
        <Section title="Station inspector">
          <div className="mb-1 text-[14px] font-medium text-neutral-900">{station.name}</div>
          <Row label="pumps" base={String(station.pumps)} />
          <Row label="calls carried" base={`~${station.calls_carried_per_yr.toLocaleString()}/yr`} />
          {station.nearest_cover?.length > 0 && (
            <Row
              label="nearest cover"
              base={station.nearest_cover.map((c) => `${c.name} ${c.km}km`).join(" · ")}
            />
          )}
          {station.turnout_day_med_s != null && station.turnout_night_med_s != null && (
            <Row label="turnout day / night"
                 base={`${fmtS(station.turnout_day_med_s)} / ${fmtS(station.turnout_night_med_s)}`} />
          )}
          {station.closure && (
            <>
              <Row label="if closed: local impact" base={`+${Math.round(station.closure.local_added_s)}s`} />
              <Row label="if closed: pushed past 6m" base={`${station.closure.pushed_past_6min}/yr`} />
            </>
          )}
          {station.ground_wards.length > 0 && (
            <p className="mt-1.5 text-[11.5px] leading-4 text-neutral-400">
              first-due for {station.ground_wards.slice(0, 4).join(", ")}
            </p>
          )}
        </Section>
      )}

      <div className="mt-auto px-4 py-3 text-[10.5px] leading-4 text-neutral-400">
        Validated against blind 2025: mean +2.4% · p90 −3.7%. Physics learned from 600k
        timed mobilisations. {baseline ? `${baseline.window} · through Apr 2026.` : ""}
      </div>
    </aside>
  );
}
