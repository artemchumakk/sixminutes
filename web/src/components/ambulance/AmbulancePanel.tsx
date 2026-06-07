import type {
  BaselineInfo,
  HourBand,
  ScenarioResult,
  StationDetail,
  CoverageCells,
  DemandCategory,
  Hospital,
  StandbyResult,
  WinterResult,
  HandoverResult,
  Bucket,
} from "../../lib/ambApi";

// LAS Category-1 mean standard — the 7-minute promise (vs the fire twin's 6 minutes).
const PROMISE_S = 420;
const fmtS = (v: number) => `${Math.round(v)}s`;
const fmtMin = (v: number) => `${(v / 60).toFixed(1)} min`;
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const SCALE_FALLBACK = 26.9;

type Posture =
  | { kind: "standby"; data: StandbyResult }
  | { kind: "winter"; data: WinterResult }
  | { kind: "handover"; data: HandoverResult }
  | null;

function Section({ title, children, sub }: { title: string; children: React.ReactNode; sub?: string }) {
  return (
    <div className="border-b border-neutral-100 px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{title}</div>
        {sub && <div className="text-[10px] text-neutral-400">{sub}</div>}
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

function Seg<T extends string | number>({
  opts,
  value,
  onChange,
}: {
  opts: { label: string; v: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
      {opts.map((o) => {
        const active = o.v === value;
        return (
          <button
            key={String(o.v)}
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

function Toggle({ on, onChange, label }: { on: boolean; onChange: (b: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between py-1.5 text-[13px] text-neutral-600"
    >
      <span>{label}</span>
      <span
        className={"relative h-[18px] w-[32px] rounded-full transition-colors " + (on ? "bg-teal-500" : "bg-neutral-300")}
      >
        <span
          className={"absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all " + (on ? "left-[16px]" : "left-[2px]")}
        />
      </span>
    </button>
  );
}

export function HourBandControl({ value, onChange }: { value: HourBand; onChange: (h: HourBand) => void }) {
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
  const W = 300;
  const H = 64;
  const n = base.length;
  const bw = W / n;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + 14}`} className="block">
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
      {(() => {
        const idx = edges.indexOf(PROMISE_S);
        if (idx < 0) return null;
        const x = idx * bw;
        return (
          <g>
            <line x1={x} y1={0} x2={x} y2={H} stroke="#dc2626" strokeWidth={1} strokeDasharray="3,2" />
            <text x={x + 3} y={10} fontSize={9} fill="#dc2626">7 min</text>
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
    `SIXMINUTES ambulance brief — ${r.window ?? "annual demand"}${r.hours ? ` · hours ${r.hours[0]}–${r.hours[1]}` : ""}`,
    `Posture: close ${closed.join(", ")}`,
    `Mean response: ${fmtS(r.kpi.base.mean_s)} → ${fmtS(r.kpi.scenario.mean_s)} (+${r.city.mean_delta_s}s)`,
    `p90: ${fmtS(r.kpi.base.p90_s)} → ${fmtS(r.kpi.scenario.p90_s)}`,
    `7-min promise kept: ${fmtPct(r.kpi.base.promise_rate)} → ${fmtPct(r.kpi.scenario.promise_rate)}`,
    `C1 calls pushed past 7 min: ~${Math.round(r.city.pushed_past_6min * scale).toLocaleString()}/yr`,
    `Worst wards: ${r.worst_wards.slice(0, 5).map((w) => `${w.ward} +${Math.round(w.delta_mean_s)}s`).join("; ")}`,
  ];
  navigator.clipboard.writeText(lines.join("\n")).catch(() => undefined);
}

function downloadCsv(r: ScenarioResult) {
  const rows = [
    "ward,borough,n,delta_mean_s,pushed_past_7min",
    ...r.worst_wards.map((w) => `"${w.ward}","${w.borough}",${w.n},${w.delta_mean_s.toFixed(1)},${w.pushed_360}`),
  ];
  const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "sixminutes_ambulance_scenario_wards.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ----- the three decision cards (briefing) -----------------------------------
function DecisionCard({
  n,
  title,
  body,
  cta,
  onRun,
  busy,
  accent,
}: {
  n: number;
  title: string;
  body: string;
  cta?: string;
  onRun?: () => void;
  busy?: boolean;
  accent: string;
}) {
  return (
    <div className="mb-2 rounded-xl border border-neutral-200 bg-white p-3 last:mb-0">
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: accent }}
        >
          {n}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-neutral-900">{title}</div>
          <div className="mt-0.5 text-[12px] leading-[1.45] text-neutral-500">{body}</div>
        </div>
      </div>
      {cta && onRun && (
        <button
          onClick={onRun}
          disabled={busy}
          className="mt-2.5 w-full rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-50"
          style={{ background: accent }}
        >
          {busy ? "modeling…" : cta}
        </button>
      )}
    </div>
  );
}

function CoverStatRow({ s }: { s: { mean_s: number; p90_s: number; pct_over_target: number } }) {
  return (
    <>
      <Row label="demand-weighted mean" base={fmtMin(s.mean_s)} />
      <Row label="p90 response" base={fmtMin(s.p90_s)} />
      <Row label="demand over 7-min" base={`${s.pct_over_target}%`} />
    </>
  );
}

function PostureResult({ posture, accent }: { posture: Posture; accent: string }) {
  if (!posture) return null;
  if (posture.kind === "standby") {
    const d = posture.data;
    return (
      <Section title={`Standby placement · ${d.bucket}`} sub={`hour ~${d.rep_hour}`}>
        <CoverStatRow s={d.coverage} />
        <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          park idle units here
        </div>
        <div className="mt-1 max-h-40 overflow-y-auto pr-1">
          {d.standby_here.map((s, i) => (
            <div key={s.cell} className="flex items-center justify-between border-t border-neutral-100 py-1 text-[12px]">
              <span className="flex items-center gap-1.5 text-neutral-700">
                <span className="flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: accent }}>{i + 1}</span>
                {s.demand.toLocaleString()} calls/yr
              </span>
              <span className="tabular-nums text-red-600">{fmtMin(s.cur_response_s)}</span>
            </div>
          ))}
        </div>
      </Section>
    );
  }
  if (posture.kind === "winter") {
    const d = posture.data;
    return (
      <Section title={`Winter surge · ${d.bucket}`} sub={`${d.stuck_fraction_pct}% of units tied up`}>
        <Row label="normal mean" base={fmtMin(d.normal.mean_s)} />
        <Row label="surge peak" base={fmtMin(d.normal.mean_s)} scen={fmtMin(d.surge_peak.mean_s)}
             better={d.surge_peak.mean_s <= d.normal.mean_s} />
        <Row label={`+${d.standby_added.length} standby → recovered`} base={fmtMin(d.surge_peak.mean_s)}
             scen={fmtMin(d.recovered_to.mean_s)} better={d.recovered_to.mean_s <= d.surge_peak.mean_s} />
        <p className="mt-1.5 text-[11.5px] leading-4 text-neutral-400">
          {d.units_stuck} units stuck at A&E. Pre-positioning {d.standby_added.length} standby units
          claws the mean back toward baseline — the winter posture play.
        </p>
      </Section>
    );
  }
  const d = posture.data;
  return (
    <Section title="Hospital handover drain" sub={d.bucket}>
      <div className="mb-1 text-[13px] font-medium text-neutral-800">{d.hospital}</div>
      <Row label={`${d.units_stuck} units stuck → mean`} base={fmtMin(d.baseline.mean_s)}
           scen={fmtMin(d.during_drain.mean_s)} better={d.during_drain.mean_s <= d.baseline.mean_s} />
      <Row label="newly exposed demand" base={`${d.exposed_demand.toLocaleString()}/yr`} />
      {d.best_patch_cell && (
        <p className="mt-1.5 text-[11.5px] leading-4 text-neutral-400">
          Best single patch relocates one unit (green pin) → mean back to {fmtMin(d.patched_mean_s)}.
        </p>
      )}
    </Section>
  );
}

export default function AmbulancePanel({
  accent,
  baseline,
  hours,
  onHours,
  closed,
  onReopen,
  result,
  running,
  station,
  coverage,
  category,
  covHour,
  onCoverage,
  showHeat,
  onShowHeat,
  colocate,
  onColocate,
  hospitals,
  posture,
  postureBusy,
  onRunPlaybook,
  onClearPosture,
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
  coverage: CoverageCells | null;
  category: DemandCategory;
  covHour: number;
  onCoverage: (cat: DemandCategory, hour: number) => void;
  showHeat: boolean;
  onShowHeat: (b: boolean) => void;
  colocate: boolean;
  onColocate: (b: boolean) => void;
  hospitals: Hospital[];
  posture: Posture;
  postureBusy: boolean;
  onRunPlaybook: (kind: "standby" | "winter" | "handover", opts?: { bucket?: Bucket; hospital?: string }) => void;
  onClearPosture: () => void;
}) {
  const scale = result?.scale ?? SCALE_FALLBACK;
  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto rounded-2xl border border-neutral-200 bg-white/95 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm">
      {/* Insight 2 — the hero coverage surface controls */}
      <Section
        title="Coverage map"
        sub={coverage ? `${(coverage.window_n / 1e6).toFixed(2)}M calls/yr` : undefined}
      >
        <Seg<DemandCategory>
          value={category}
          onChange={(c) => onCoverage(c, covHour)}
          opts={[
            { label: "All demand", v: "proxy_all" },
            { label: "Assault", v: "assault" },
            { label: "Alcohol", v: "alcohol" },
          ]}
        />
        <div className="mt-1.5">
          <Seg<number>
            value={covHour}
            onChange={(h) => onCoverage(category, h)}
            opts={[
              { label: "Night", v: 3 },
              { label: "Morning", v: 9 },
              { label: "Day", v: 15 },
              { label: "Evening", v: 21 },
            ]}
          />
        </div>
        {coverage && (
          <div className="mt-2.5">
            <CoverStatRow s={coverage.summary} />
          </div>
        )}
        <div className="mt-1.5 border-t border-neutral-100 pt-1">
          <Toggle on={showHeat} onChange={onShowHeat} label="Demand heatmap" />
          <Toggle on={colocate} onChange={onColocate} label="Fire stations (free co-location)" />
        </div>
      </Section>

      {/* Insight 3 — the decisions / playbooks */}
      <Section title="Decisions">
        <DecisionCard
          n={1}
          accent={accent}
          title="Aim escalation at Category-2, not C1"
          body="C1 holds near its 7-min standard; C2 is the breach and it worsens every winter. Pre-position for the winter surge."
          cta="Model the winter surge"
          busy={postureBusy && posture?.kind !== "winter"}
          onRun={() => onRunPlaybook("winter", { bucket: "eve" })}
        />
        <DecisionCard
          n={2}
          accent={accent}
          title="Place standby units where coverage is thin"
          body="Park idle units on hot demand that sits far from a base. Toggle fire stations to find free joint-coverage sites."
          cta="Recommend standby points"
          busy={postureBusy && posture?.kind !== "standby"}
          onRun={() => onRunPlaybook("standby", { bucket: "pm" })}
        />
        <DecisionCard
          n={3}
          accent={accent}
          title="Stress-test a hospital handover"
          body="When an A&E ties up its nearest units, see who loses the promise — and the single best relocation to patch it."
        />
        {hospitals.length > 0 && (
          <select
            onChange={(e) => e.target.value && onRunPlaybook("handover", { hospital: e.target.value, bucket: "pm" })}
            value=""
            className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-[12.5px] text-neutral-600"
          >
            <option value="" disabled>
              {postureBusy ? "modeling…" : "Drain a hospital…"}
            </option>
            {hospitals.map((h) => (
              <option key={h.name} value={h.name}>{h.name}</option>
            ))}
          </select>
        )}
        {posture && (
          <button
            onClick={onClearPosture}
            className="mt-2 w-full rounded-lg border border-neutral-200 px-2 py-1 text-[12px] text-neutral-500 hover:bg-neutral-50"
          >
            Clear playbook from map
          </button>
        )}
      </Section>

      {/* live playbook result */}
      <PostureResult posture={posture} accent={accent} />

      {/* Sandbox — close stations and re-simulate */}
      <Section title={`Sandbox · ${closed.length} closed`}>
        <HourBandControl value={hours} onChange={onHours} />
        {closed.length === 0 ? (
          <p className="mt-2 text-[12.5px] leading-5 text-neutral-400">
            Click ambulance stations on the map to close them. London's C1 demand
            re-simulates automatically.
          </p>
        ) : (
          <>
            <div className="mb-2 mt-2 flex flex-wrap gap-1.5">
              {closed.map((n) => (
                <button
                  key={n}
                  onClick={() => onReopen(n)}
                  className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-[12px] text-red-700 hover:bg-red-100"
                >
                  {n.replace(" Ambulance Station", "")} ✕
                </button>
              ))}
            </div>
            {running && <div className="py-2 text-[13px] text-neutral-400">re-simulating London…</div>}
            {result && !running && (
              <>
                <Row label="mean" base={fmtS(result.kpi.base.mean_s)} scen={fmtS(result.kpi.scenario.mean_s)}
                     better={result.kpi.scenario.mean_s <= result.kpi.base.mean_s} />
                <Row label="p90" base={fmtS(result.kpi.base.p90_s)} scen={fmtS(result.kpi.scenario.p90_s)}
                     better={result.kpi.scenario.p90_s <= result.kpi.base.p90_s} />
                <Row label="promise kept" base={fmtPct(result.kpi.base.promise_rate)}
                     scen={fmtPct(result.kpi.scenario.promise_rate)}
                     better={result.kpi.scenario.promise_rate >= result.kpi.base.promise_rate} />
                <Row label="pushed past 7 min"
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
          <div className="mb-1 text-[14px] font-medium text-neutral-900">
            {station.name.replace(" Ambulance Station", "")}
          </div>
          <Row label="vehicles" base={String(station.pumps)} />
          <Row label="calls carried" base={`~${station.calls_carried_per_yr.toLocaleString()}/yr`} />
          {station.nearest_cover?.length > 0 && (
            <Row
              label="nearest cover"
              base={station.nearest_cover.map((c) => `${c.name.replace(" Ambulance Station", "")} ${c.km}km`).join(" · ")}
            />
          )}
          {station.closure && (
            <>
              <Row label="if closed: local impact" base={`+${Math.round(station.closure.local_added_s)}s`} />
              <Row label="if closed: pushed past 7m" base={`${station.closure.pushed_past_6min.toLocaleString()}/yr`} />
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
        Planning model: nearest-station response over real London Ambulance demand (1.07M
        calls/yr, GLA Ward Atlas) with Thames-aware travel physics. C2 trend is published
        AmbSYS data. {baseline ? baseline.window : ""}
      </div>
    </aside>
  );
}
