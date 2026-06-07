import { useEffect, useMemo, useState } from "react";
import { fetchC2Series, type C2Series } from "../../lib/ambApi";

/** The broken Category-2 promise — real London Ambulance Service AmbSYS data.
 *  A strip over the hero map that frames WHY coverage matters; click to expand
 *  the month-by-month chart (worst in winter). Citywide, published figures. */
export default function C2Banner({ accent }: { accent: string }) {
  const [data, setData] = useState<C2Series | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetchC2Series().then(setData).catch(() => undefined);
  }, []);

  if (!data || !data.headline.latest) return null;
  const { latest, winter_mean_min } = data.headline;
  const std = data.standards_min.c2_mean;
  const overBy = latest.c2_mean_min - std;

  return (
    <div className="pointer-events-auto absolute left-1/2 top-4 z-[1100] w-[min(680px,calc(100%-32px))] -translate-x-1/2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-xl border border-red-200 bg-white/95 px-4 py-2.5 text-left shadow-[0_4px_20px_rgba(0,0,0,0.10)] backdrop-blur-sm transition-colors hover:border-red-300"
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold leading-tight text-neutral-900">
            Category-2 response is {latest.c2_mean_min} min — the {std}-minute standard, broken
          </span>
          <span className="block text-[11.5px] leading-tight text-neutral-500">
            London Ambulance Service · {latest.label} · {overBy > 0 ? `+${overBy.toFixed(0)} min over` : "at"} standard
            {winter_mean_min ? ` · winter avg ${winter_mean_min} min` : ""}
          </span>
        </span>
        <span className="shrink-0 text-[11px] font-medium text-red-600">
          {open ? "hide" : "see the trend"} {open ? "▲" : "▼"}
        </span>
      </button>

      {open && <C2Chart data={data} accent={accent} />}
    </div>
  );
}

function C2Chart({ data, accent }: { data: C2Series; accent: string }) {
  const { series } = data;
  const std = data.standards_min.c2_mean;
  const c1std = data.standards_min.c1_mean;

  const { W, H, pad, xs, yMax, c2pts, c1pts, ticks } = useMemo(() => {
    const W = 632, H = 196, pad = 30;
    const n = series.length;
    const yMax = Math.ceil(Math.max(std, ...series.map((s) => s.c2_mean_min)) / 10) * 10;
    const x = (i: number) => pad + (i / Math.max(1, n - 1)) * (W - pad * 2);
    const y = (v: number) => H - pad - (v / yMax) * (H - pad * 2);
    const c2pts = series.map((s, i) => `${x(i)},${y(s.c2_mean_min)}`).join(" ");
    const c1pts = series
      .filter((s) => s.c1_mean_min != null)
      .map((s) => `${x(series.indexOf(s))},${y(s.c1_mean_min as number)}`)
      .join(" ");
    // year ticks
    const ticks: { x: number; label: string }[] = [];
    let lastYr = -1;
    series.forEach((s, i) => {
      if (s.year !== lastYr) {
        ticks.push({ x: x(i), label: String(s.year) });
        lastYr = s.year;
      }
    });
    return { W, H, pad, xs: x, yMax, c2pts, c1pts, ticks, yFn: y };
  }, [series, std]);

  const yPix = (v: number) => H - pad - (v / yMax) * (H - pad * 2);
  const { latest, worst } = data.headline;

  return (
    <div className="animate-fade-up mt-2 rounded-xl border border-neutral-200 bg-white/97 p-4 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12px] font-medium text-neutral-700">
          Mean response time, month by month
        </div>
        <div className="text-[10.5px] text-neutral-400">{data.source}</div>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
        {/* winter shading (Nov–Feb) */}
        {series.map((s, i) =>
          [11, 12, 1, 2].includes(s.month) ? (
            <rect key={`w${i}`} x={xs(i) - 2} y={pad} width={4} height={H - pad * 2}
                  fill="#3b82f6" opacity={0.05} />
          ) : null
        )}
        {/* 18-min C2 standard */}
        <line x1={pad} y1={yPix(std)} x2={W - pad} y2={yPix(std)}
              stroke="#dc2626" strokeWidth={1.2} strokeDasharray="5,3" />
        <text x={W - pad} y={yPix(std) - 4} fontSize={9.5} fill="#dc2626" textAnchor="end">
          {std}-min C2 standard
        </text>
        {/* 7-min C1 standard */}
        <line x1={pad} y1={yPix(c1std)} x2={W - pad} y2={yPix(c1std)}
              stroke="#10b981" strokeWidth={1} strokeDasharray="2,3" />
        <text x={pad} y={yPix(c1std) - 4} fontSize={9} fill="#059669">{c1std}-min C1 (held)</text>
        {/* gap fill above standard */}
        <polyline points={`${pad},${yPix(std)} ${c2pts} ${W - pad},${yPix(std)}`}
                  fill="#dc2626" opacity={0.07} stroke="none" />
        {/* C1 line (mostly flat, on target) */}
        {c1pts && <polyline points={c1pts} fill="none" stroke="#10b981" strokeWidth={1.4} opacity={0.7} />}
        {/* C2 line */}
        <polyline points={c2pts} fill="none" stroke={accent} strokeWidth={2} />
        {/* year ticks */}
        {ticks.map((t) => (
          <text key={t.label} x={t.x} y={H - 8} fontSize={9} fill="#a3a3a3" textAnchor="middle">
            {t.label}
          </text>
        ))}
        {/* y labels */}
        <text x={4} y={pad + 4} fontSize={9} fill="#a3a3a3">{yMax}m</text>
        <text x={4} y={H - pad} fontSize={9} fill="#a3a3a3">0</text>
      </svg>

      <div className="mt-2 grid grid-cols-3 gap-3 text-center">
        <Stat label="Latest" value={`${latest?.c2_mean_min} min`} sub={latest?.label} tone="bad" />
        <Stat label="Worst on record" value={`${worst?.c2_mean_min} min`} sub={worst?.label} tone="bad" />
        <Stat
          label="Winter vs summer"
          value={`${data.headline.winter_mean_min ?? "—"} / ${data.headline.summer_mean_min ?? "—"}`}
          sub="min (last 3 yrs)"
          tone="warn"
        />
      </div>
      <p className="mt-2.5 text-[11px] leading-4 text-neutral-500">
        Category-1 (life-threatening) holds near its 7-minute standard. The breach is
        Category-2 — and it deepens every winter. That is where escalation and winter
        posture should be aimed, not C1.
      </p>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "bad" | "warn" }) {
  return (
    <div className="rounded-lg border border-neutral-150 bg-neutral-50 px-2 py-1.5">
      <div className="text-[9.5px] uppercase tracking-wide text-neutral-400">{label}</div>
      <div className={"text-[15px] font-semibold tabular-nums " + (tone === "bad" ? "text-red-600" : "text-amber-600")}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-neutral-400">{sub}</div>}
    </div>
  );
}
