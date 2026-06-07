import type { PlanResult, BcuRow } from "../../lib/policeApi";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n: number) => Math.round(n).toLocaleString();
const isUnnamed = (n: string) => /^police_\d+$/.test(n);
// tidy long official names for a tight panel ("Albany Street Police Station" → "Albany Street")
const tidy = (n: string) =>
  n
    .replace(/\s+Police Station$/i, "")
    .replace(/^Metropolitan Police\s+/i, "")
    .replace(/\(([^)]*)\)/g, "$1") // unwrap "(Sudbury Ward)" → "Sudbury Ward"
    .replace(/\s+Wards?$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/** The hero view: a plain-English answer to "where are units now, and what should
 *  move next month". Reads off the /plan endpoint. No jargon, one decision. */
export default function PolicePlan({
  accent,
  plan,
  showPlan,
  loading,
  onOptimise,
  onBack,
}: {
  accent: string;
  plan: PlanResult | null;
  showPlan: boolean;
  loading: boolean;
  onOptimise: () => void;
  onBack: () => void;
}) {
  // BCU is the fully-real layer (published officer totals, real crime) — the headline + moves
  // live here. bcus arrives sorted by move (reinforce first); ease list shown biggest-first.
  const reinforce = (plan?.bcus ?? []).filter((b) => b.move > 0);
  const ease = (plan?.bcus ?? []).filter((b) => b.move < 0).reverse();
  const rising = (plan?.stations ?? [])
    .filter((s) => !isUnnamed(s.name) && s.demand_next > 300 && s.growth_pct > 0.5)
    .sort((a, b) => b.growth_pct - a.growth_pct)
    .slice(0, 3);

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto rounded-2xl border border-neutral-200 bg-white/95 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm">
      <div className="border-b border-neutral-100 px-4 pb-3 pt-4">
        <div className="text-[15px] font-semibold text-neutral-900">Fleet deployment</div>
        <p className="mt-1 text-[12.5px] leading-5 text-neutral-500">
          Where the Met&apos;s officers are based today — and where next month&apos;s forecast
          demand says they should be.
        </p>
      </div>

      {!plan && (
        <div className="px-4 py-6 text-[13px] text-neutral-400">reading the demand surface…</div>
      )}

      {/* ───────────────────────── TODAY ───────────────────────── */}
      {plan && !showPlan && (
        <>
          <div className="border-b border-neutral-100 px-4 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Today
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-3xl tabular-nums text-neutral-900">
                {fmt(plan.units)}
              </span>
              <span className="text-[13px] text-neutral-500">officers</span>
            </div>
            <p className="mt-1.5 text-[13px] leading-5 text-neutral-500">
              Local-policing strength across the Met&apos;s{" "}
              <b className="text-neutral-700">{plan.n_bcus}</b> Basic Command Units — real
              published per-area numbers, spread over{" "}
              <b className="text-neutral-700">{plan.n_stations}</b> bases.
            </p>
            <p className="mt-2 text-[11.5px] leading-4 text-neutral-400">
              BCU officer totals are real and published; only the split within each BCU is
              modelled — weighted by each base&apos;s local recorded crime.
            </p>
          </div>

          <div className="border-b border-neutral-100 px-4 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              The problem
            </div>
            <p className="mt-1.5 text-[13px] leading-5 text-neutral-600">
              Crime isn&apos;t even. Next month{" "}
              <b className="text-neutral-900">{fmt(plan.total_next_per_mo)}</b> crimes/mo are
              forecast — and today&apos;s deployment leaves the busiest area carrying{" "}
              <b style={{ color: accent }}>{plan.imbalance_before}×</b> the crimes-per-officer of
              the quietest.
            </p>
          </div>

          <div className="px-4 py-4">
            <button
              onClick={onOptimise}
              disabled={loading}
              className="w-full rounded-xl px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ background: accent }}
            >
              {loading ? "Optimising…" : "Optimise for next month →"}
            </button>
            <p className="mt-2 text-center text-[11.5px] text-neutral-400">
              Match every base to its forecast demand
            </p>
          </div>
        </>
      )}

      {/* ──────────────────────── NEXT MONTH ──────────────────────── */}
      {plan && showPlan && (
        <>
          <div className="border-b border-neutral-100 px-4 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Next month&apos;s plan
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-3xl tabular-nums" style={{ color: accent }}>
                {fmt(plan.total_moved)}
              </span>
              <span className="text-[13px] text-neutral-500">officers to move</span>
            </div>
            <p className="mt-1.5 text-[12.5px] leading-5 text-neutral-500">
              Ease the over-served quiet areas, reinforce where the crime actually is —
              crimes-per-officer goes from{" "}
              <b className="text-neutral-700">{plan.imbalance_before}×</b> imbalance to roughly even.
            </p>
          </div>

          <Section title="Reinforce these areas">
            {reinforce.map((b) => (
              <BcuMoveRow key={b.bcu} b={b} positive />
            ))}
          </Section>

          <Section title="Ease these areas">
            {ease.map((b) => (
              <BcuMoveRow key={b.bcu} b={b} />
            ))}
          </Section>

          {rising.length > 0 && (
            <Section title="Heating up · forecast">
              {rising.map((s) => (
                <div
                  key={s.name}
                  className="flex items-baseline justify-between py-0.5 text-[12.5px]"
                >
                  <span className="text-neutral-700">{tidy(s.name)}</span>
                  <span className="tabular-nums text-neutral-500">
                    <span className="text-red-600">▲ {s.growth_pct.toFixed(0)}%</span> ·{" "}
                    {cap(s.top_category)}
                  </span>
                </div>
              ))}
            </Section>
          )}

          <div className="px-4 py-4">
            <button
              onClick={onBack}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-[13px] text-neutral-600 transition-colors hover:bg-neutral-50"
            >
              ← Back to today
            </button>
          </div>
        </>
      )}

      <div className="mt-auto px-4 py-3 text-[10.5px] leading-4 text-neutral-400">
        Tier B · officer strength is real, published per BCU (
        <a
          href={plan?.source_url}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-neutral-600"
        >
          London Assembly
        </a>
        ); the within-BCU station split is modelled. Next-month demand is a damped trend
        projection, not a validated forecast.
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-100 px-4 py-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {title}
      </div>
      {children}
    </div>
  );
}

function BcuMoveRow({ b, positive }: { b: BcuRow; positive?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
      <span className="flex items-baseline gap-2 truncate">
        <b
          className={"tabular-nums " + (positive ? "text-emerald-600" : "text-red-600")}
        >
          {positive ? "+" : "−"}
          {Math.abs(b.move)}
        </b>
        <span className="truncate text-neutral-700">{b.bcu}</span>
      </span>
      <span className="shrink-0 tabular-nums text-[11.5px] text-neutral-400">
        {fmt(b.demand_next)}/mo{positive ? ` · ${cap(b.top_category)}` : ""}
      </span>
    </div>
  );
}
