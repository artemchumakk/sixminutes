import type {
  AllocResult,
  DamageProps,
  PoliceBaseline,
  PoliceScenario,
  PredictResult,
} from "../../lib/policeApi";

export type Lens = "closure" | "demand" | "criticality" | "forecast" | "deploy";

const fmtS = (v: number) => `${Math.round(v)}s`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// "deploy" stays in the Lens type (the map still references it) but is intentionally absent
// here — the hypothetical what-if pool was removed; the real footprint lives in Fleet deployment.
const LENSES: { id: Lens; label: string }[] = [
  { id: "closure", label: "Closure" },
  { id: "demand", label: "Demand" },
  { id: "criticality", label: "Critical" },
  { id: "forecast", label: "Forecast" },
];

// A one-line, jargon-free "what this view does" banner shown at the top of each lens.
function LensIntro({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-100 bg-neutral-50/70 px-4 py-2.5 text-[12px] leading-[17px] text-neutral-500">
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-100 px-4 py-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, base, scen, worse }: { label: string; base: string; scen?: string; worse?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-[13px]">
      <span className="text-neutral-500">{label}</span>
      <span className="tabular-nums">
        <span className="text-neutral-400">{base}</span>
        {scen !== undefined && (
          <>
            <span className="mx-1.5 text-neutral-300">→</span>
            <b className={worse ? "text-red-600" : "text-emerald-600"}>{scen}</b>
          </>
        )}
      </span>
    </div>
  );
}

function CategorySelect({
  categories,
  value,
  onChange,
  accent,
}: {
  categories: string[];
  value: string;
  onChange: (c: string) => void;
  accent: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {categories.map((c) => {
        const active = c === value;
        return (
          <button
            key={c}
            onClick={() => onChange(c)}
            className={
              "rounded-full border px-2.5 py-0.5 text-[12px] transition-colors " +
              (active
                ? "border-transparent text-white"
                : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50")
            }
            style={active ? { background: accent } : undefined}
          >
            {c === "all" ? "All crime" : cap(c)}
          </button>
        );
      })}
    </div>
  );
}

function TrendArrow({ pct }: { pct: number }) {
  if (pct > 1) return <span className="text-red-600">▲ {pct.toFixed(0)}%</span>;
  if (pct < -1) return <span className="text-emerald-600">▼ {Math.abs(pct).toFixed(0)}%</span>;
  return <span className="text-neutral-400">– flat</span>;
}

export default function PolicePanel({
  accent,
  lens,
  onLens,
  categories,
  category,
  onCategory,
  baseline,
  closed,
  onReopen,
  onReset,
  scenario,
  running,
  damage,
  predict,
  predicting,
  radiusKm,
  onRadius,
  onSearch,
  searchError,
  allocation,
  units,
  onUnits,
}: {
  accent: string;
  lens: Lens;
  onLens: (l: Lens) => void;
  categories: string[];
  category: string;
  onCategory: (c: string) => void;
  baseline: PoliceBaseline | null;
  closed: string[];
  onReopen: (name: string) => void;
  onReset: () => void;
  scenario: PoliceScenario | null;
  running: boolean;
  damage: DamageProps[];
  predict: PredictResult | null;
  predicting: boolean;
  radiusKm: number;
  onRadius: (km: number) => void;
  onSearch: (q: string) => void;
  searchError: string | null;
  allocation: AllocResult | null;
  units: number;
  onUnits: (u: number) => void;
}) {
  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto rounded-2xl border border-neutral-200 bg-white/95 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm">
      {/* lens switcher */}
      <div className="sticky top-0 z-10 border-b border-neutral-100 bg-white/95 px-3 py-2.5 backdrop-blur-sm">
        <div className="flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
          {LENSES.map((l) => {
            const active = l.id === lens;
            return (
              <button
                key={l.id}
                onClick={() => onLens(l.id)}
                className={
                  "flex-1 rounded-md px-1.5 py-1 text-[11.5px] transition-colors " +
                  (active ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700")
                }
              >
                {l.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- CLOSURE ---------------------------------------------------- */}
      {lens === "closure" && (
        <>
          <LensIntro>
            <b className="text-neutral-600">What if a base shut down?</b> Click stations on the map to
            take them offline — every call reroutes to the next-nearest base, and you see how much
            slower London&apos;s response gets and which areas hurt most.
          </LensIntro>
          <Section title="Crime category">
            <CategorySelect categories={categories} value={category} onChange={onCategory} accent={accent} />
          </Section>
          <Section title={`Closure posture · ${closed.length} closed`}>
            {closed.length === 0 ? (
              <p className="text-[13px] leading-5 text-neutral-400">
                Click stations on the map to take them offline. Every 1 km demand cell reroutes
                to its nearest open base and the city impact recomputes instantly.
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
                {running && <div className="py-2 text-[13px] text-neutral-400">rerouting London…</div>}
                {scenario && !running && (
                  <>
                    <Row label="mean response" base={fmtS(0)} scen={`+${scenario.city.mean_delta_s}s`} worse />
                    <Row label="p90 response" base={fmtS(0)} scen={`+${scenario.city.p90_delta_s}s`} worse />
                    <Row
                      label="crimes pushed >15 min"
                      base={`${scenario.city.crimes_pushed_over_target}/mo`}
                    />
                    <Row label="cells degraded" base={`${scenario.city.cells_pushed_over_target}`} />
                    <button
                      onClick={onReset}
                      className="mt-3 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50"
                    >
                      Reset posture
                    </button>
                  </>
                )}
              </>
            )}
          </Section>
          {scenario && !running && scenario.worst_cells.length > 0 && (
            <Section title="Worst-hit areas">
              <div className="max-h-52 overflow-y-auto pr-1">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10.5px] uppercase tracking-wide text-neutral-400">
                      <th className="pb-1 font-medium">cell → nearest open</th>
                      <th className="pb-1 text-right font-medium">Δ resp</th>
                      <th className="pb-1 text-right font-medium">crimes/mo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenario.worst_cells.map((c) => (
                      <tr key={c.cell} className="border-t border-neutral-100">
                        <td className="py-1 pr-2 text-neutral-600">{c.near}</td>
                        <td className="py-1 text-right tabular-nums text-red-600">+{Math.round(c.delta_s)}s</td>
                        <td className="py-1 text-right tabular-nums text-neutral-500">{c.crimes_per_mo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}

      {/* ---- DEMAND ----------------------------------------------------- */}
      {lens === "demand" && (
        <>
          <LensIntro>
            <b className="text-neutral-600">Where the crime actually is.</b> The blue heat shows
            recorded crimes per month — deeper, more solid blue means busier. Switch crime type below.
          </LensIntro>
          <Section title="Crime category">
            <CategorySelect categories={categories} value={category} onChange={onCategory} accent={accent} />
          </Section>
          <Section title="Demand surface">
            <p className="mb-2 text-[13px] leading-5 text-neutral-400">
              Each dot is a 1 km grid cell, sized and shaded by recorded crimes per month for the
              selected category — the city&apos;s real demand signal.
            </p>
            {baseline && (
              <>
                <Row label="grid cells" base={baseline.cells.toLocaleString()} />
                <Row label="police bases" base={String(baseline.stations)} />
                <Row label="crimes / month" base={Math.round(baseline.crimes_per_mo).toLocaleString()} />
                <Row label="mean response" base={fmtS(baseline.mean_response_s)} />
                <Row label="15-min target" base={fmtS(baseline.target_s)} />
              </>
            )}
            <div className="mt-2.5 flex items-center gap-2.5 text-[11px] text-neutral-500">
              <span className="font-medium text-neutral-400">crimes/mo</span>
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent, opacity: 0.35 }} />low
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />high
              </span>
            </div>
          </Section>
        </>
      )}

      {/* ---- CRITICALITY ----------------------------------------------- */}
      {lens === "criticality" && (
        <>
          <LensIntro>
            <b className="text-neutral-600">Which bases matter most.</b> We shut each one in turn and
            measure the damage to response times — a high score is a quiet-but-critical base you
            can&apos;t afford to lose.
          </LensIntro>
          <Section title="Closure criticality">
          <p className="mb-2 text-[13px] leading-5 text-neutral-400">
            Rings sized by how badly closing each base would hurt the area it serves
            (mean added response across its catchment). The quiet-but-critical signal.
          </p>
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-neutral-400">
                  <th className="pb-1 font-medium">base</th>
                  <th className="pb-1 text-right font-medium">+mean</th>
                  <th className="pb-1 text-right font-medium">pushed</th>
                </tr>
              </thead>
              <tbody>
                {damage.map((d, i) => (
                  <tr key={`${d.station}-${i}`} className="border-t border-neutral-100">
                    <td className="py-1 pr-2 text-neutral-700">{d.station}</td>
                    <td className="py-1 text-right tabular-nums text-red-600">+{Math.round(d.mean_added_s)}s</td>
                    <td className="py-1 text-right tabular-nums text-neutral-500">{Math.round(d.pushed_over_target)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        </>
      )}

      {/* ---- FORECAST -------------------------------------------------- */}
      {lens === "forecast" && (
        <>
          <LensIntro>
            <b className="text-neutral-600">Crime outlook for any area.</b> Search a London place or
            click the map to read its current crime mix and a damped next-month projection.
          </LensIntro>
          <Section title="Area crime forecast">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const q = (e.currentTarget.elements.namedItem("q") as HTMLInputElement)?.value ?? "";
                onSearch(q);
              }}
            >
              <input
                name="q"
                autoComplete="off"
                placeholder="Search a place — or click the map"
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[13px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-300 focus:outline-none"
              />
            </form>
            <div className="mt-2 flex items-center gap-2 text-[12px] text-neutral-500">
              <span>radius</span>
              {[1, 2, 3, 5].map((r) => (
                <button
                  key={r}
                  onClick={() => onRadius(r)}
                  className={
                    "rounded-md border px-2 py-0.5 transition-colors " +
                    (radiusKm === r
                      ? "border-transparent text-white"
                      : "border-neutral-200 text-neutral-600 hover:bg-neutral-50")
                  }
                  style={radiusKm === r ? { background: accent } : undefined}
                >
                  {r}km
                </button>
              ))}
            </div>
            {searchError && <p className="mt-2 text-[12px] text-red-600">{searchError}</p>}
          </Section>

          {predicting && <Section title="Profile"><div className="text-[13px] text-neutral-400">reading the grid…</div></Section>}

          {predict && !predicting && (
            <>
              <Section title="Next-month projection">
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-neutral-400">now / mo</div>
                    <div className="font-mono text-2xl tabular-nums text-neutral-900">
                      {Math.round(predict.total_now_per_mo).toLocaleString()}
                    </div>
                  </div>
                  <div className="pb-1 text-neutral-300">→</div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wide text-neutral-400">projected</div>
                    <div className="font-mono text-2xl tabular-nums" style={{ color: accent }}>
                      {Math.round(predict.total_proj_next_mo).toLocaleString()}
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-[11.5px] leading-4 text-neutral-400">
                  Across {predict.cells} cells within {predict.radius_km} km, from{" "}
                  {predict.sample_incidents_36mo.toLocaleString()} recorded crimes over 36 months.
                </p>
              </Section>
              <Section title="Most likely crimes here">
                <div className="flex flex-col gap-2">
                  {predict.categories.map((c) => (
                    <div key={c.category}>
                      <div className="flex items-baseline justify-between text-[12.5px]">
                        <span className="text-neutral-700">{cap(c.category)}</span>
                        <span className="tabular-nums text-neutral-500">
                          {c.now_per_mo}/mo · {c.share_pct}% · <TrendArrow pct={c.trend_3y_pct} />
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                        <div className="h-full rounded-full" style={{ width: `${c.share_pct}%`, background: accent }} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}

          {!predict && !predicting && (
            <Section title="Profile">
              <p className="text-[13px] leading-5 text-neutral-400">
                Search a London place or click anywhere on the map to read the local crime mix and a
                damped next-month projection.
              </p>
            </Section>
          )}
        </>
      )}

      {/* ---- DEPLOY ---------------------------------------------------- */}
      {lens === "deploy" && (
        <>
          <Section title="Pool to distribute · what-if">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-neutral-500">officers</span>
              <span className="font-mono text-lg tabular-nums text-neutral-900">{units.toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={100}
              max={1500}
              step={50}
              value={units}
              autoComplete="off"
              onChange={(e) => onUnits(Number(e.target.value))}
              className="mt-1 w-full accent-[var(--accent)]"
            />
            <p className="mt-1 text-[11.5px] leading-4 text-neutral-400">
              A hypothetical pool you size by hand — we split it across stations by demand. For the
              Met&apos;s real, published footprint, see Fleet deployment.
            </p>
          </Section>
          {allocation && (
            <>
              <Section title="Workload balance">
                <Row
                  label="demand / month"
                  base={Math.round(allocation.total_demand_per_mo).toLocaleString()}
                />
                <Row label="even spread (today)" base={`${allocation.imbalance_now}× imbalance`} />
                <Row label="demand-weighted" base={`${allocation.workload_balanced}/officer · balanced`} />
                <p className="mt-1.5 text-[11.5px] leading-4 text-neutral-400">
                  An even spread leaves the worst catchment carrying {allocation.imbalance_now}× the
                  crimes-per-officer of the lightest. Weighting by demand equalises the load.
                </p>
              </Section>
              <Section title="Under-resourced (add officers)">
                {allocation.under_resourced.map((s, i) => (
                  <div key={`${s.name}-${i}`} className="flex items-baseline justify-between py-0.5 text-[12.5px]">
                    <span className="text-neutral-700">{s.name}</span>
                    <span className="tabular-nums text-red-600">+{s.add}</span>
                  </div>
                ))}
              </Section>
              <Section title="Over-resourced (spare)">
                {allocation.over_resourced.map((s, i) => (
                  <div key={`${s.name}-${i}`} className="flex items-baseline justify-between py-0.5 text-[12.5px]">
                    <span className="text-neutral-700">{s.name}</span>
                    <span className="tabular-nums text-blue-600">−{s.spare}</span>
                  </div>
                ))}
              </Section>
            </>
          )}
        </>
      )}

      <div className="mt-auto px-4 py-3 text-[10.5px] leading-4 text-neutral-400">
        Tier B · transferred travel physics, scale-anchored to the Met I-grade mean. Closure
        rankings and deltas are scale-invariant; forecasts are extrapolation, not validated.
      </div>
    </aside>
  );
}
