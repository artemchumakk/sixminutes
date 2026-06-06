import type { SimResult } from "../../lib/types";
import { fmtSec, Pill, cx } from "../ui/primitives";

function Delta({ before, after }: { before: number; after: number }) {
  const d = after - before;
  const worse = d > 0;
  return (
    <div className="flex items-baseline gap-2 font-mono tabular-nums">
      <span className="text-neutral-400 line-through decoration-neutral-300">{fmtSec(before)}</span>
      <span className="text-neutral-300">→</span>
      <span className={cx("text-base", worse ? "text-red-600" : d < 0 ? "text-green-600" : "text-neutral-900")}>
        {fmtSec(after)}
      </span>
      {d !== 0 && (
        <span className={cx("text-[11px]", worse ? "text-red-500" : "text-green-600")}>
          {worse ? "+" : ""}
          {d}s
        </span>
      )}
    </div>
  );
}

export default function ResultCard({ r }: { r: SimResult }) {
  const tone = r.verdict === "high" ? "crit" : r.verdict === "medium" ? "warn" : "ok";
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
        <span className="text-[13px] font-medium text-neutral-900">{r.title}</span>
        <Pill tone={tone}>{r.verdict} damage</Pill>
      </div>
      <div className="px-4 py-3.5">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-wide text-neutral-400">
          {r.scenario}
        </div>
        <div className="grid grid-cols-2 gap-5">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Mean response
            </div>
            <Delta before={r.meanBefore} after={r.meanAfter} />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              p90 response
            </div>
            <Delta before={r.p90Before} after={r.p90After} />
          </div>
        </div>
        {r.callsOverTarget > 0 && (
          <div className="mt-3.5 flex items-baseline gap-2">
            <span className="font-mono text-lg tabular-nums text-red-600">
              +{r.callsOverTarget.toLocaleString()}
            </span>
            <span className="text-[12px] text-neutral-500">incidents/yr pushed past the promise</span>
          </div>
        )}
        <p className="mt-3.5 border-t border-neutral-100 pt-3.5 text-[13.5px] leading-relaxed text-neutral-600">
          {r.note}
        </p>
      </div>
    </div>
  );
}
