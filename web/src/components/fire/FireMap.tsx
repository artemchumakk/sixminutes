import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchStations, fetchWardsGeo, runScenario, type ScenarioResult } from "../../lib/api";

const norm = (s: string) =>
  (s || "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The validated fire twin, light-mode, living inside the chat window.
 *  Click stations to close them; the scenario re-runs automatically. */
export default function FireMap({ accent }: { accent: string }) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const stationsRef = useRef<Record<string, L.CircleMarker>>({});
  const wardsRef = useRef<Record<string, L.Path>>({});
  const closedRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<number | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [running, setRunning] = useState(false);
  const [closedCount, setClosedCount] = useState(0);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { zoomControl: false, attributionControl: false }).setView(
      [51.495, -0.09],
      11
    );
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
    }).addTo(map);
    map.createPane("stns");
    const pane = map.getPane("stns");
    if (pane) pane.style.zIndex = "620";
    mapRef.current = map;

    let cancelled = false;

    fetchWardsGeo()
      .then((gj) => {
        if (cancelled) return;
        L.geoJSON(gj, {
          style: () => ({ weight: 0.6, color: "#e5e5e5", fillColor: "#fafafa", fillOpacity: 0.4 }),
          onEachFeature: (f, layer) => {
            const key = norm((f.properties as { WD22NM?: string })?.WD22NM ?? "");
            wardsRef.current = { ...wardsRef.current, [key]: layer as L.Path };
          },
        }).addTo(map);
      })
      .catch(() => undefined);

    fetchStations()
      .then((st) => {
        if (cancelled) return;
        st.forEach((s) => {
          const m = L.circleMarker([s.lat, s.lon], {
            pane: "stns",
            radius: 4 + 1.6 * s.pumps,
            weight: 1.5,
            color: accent,
            fillColor: accent,
            fillOpacity: 0.5,
          }).addTo(map);
          m.bindTooltip(`${s.name} · ${s.pumps} pump${s.pumps > 1 ? "s" : ""}`, {
            className: "firemap-tip",
          });
          m.on("click", () => toggleStation(s.name));
          stationsRef.current = { ...stationsRef.current, [s.name]: m };
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      map.remove();
      mapRef.current = null;
      stationsRef.current = {};
      wardsRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function paintStations() {
    Object.entries(stationsRef.current).forEach(([name, m]) => {
      const closed = closedRef.current.has(name);
      m.setStyle({
        color: closed ? "#dc2626" : accent,
        fillColor: closed ? "#dc2626" : accent,
        fillOpacity: closed ? 0.85 : 0.5,
      });
    });
  }

  function paintWards(deltas: Record<string, number>) {
    Object.values(wardsRef.current).forEach((p) =>
      p.setStyle({ fillColor: "#fafafa", fillOpacity: 0.4 })
    );
    Object.entries(deltas).forEach(([ward, d]) => {
      const p = wardsRef.current[norm(ward)];
      if (!p || d < 3) return;
      p.setStyle({
        fillColor: d > 60 ? "#dc2626" : d > 20 ? "#f97316" : "#facc15",
        fillOpacity: Math.min(0.6, 0.2 + d / 150),
      });
      p.bindTooltip(`${ward}: +${Math.round(d)}s`, { className: "firemap-tip" });
    });
  }

  function toggleStation(name: string) {
    const next = new Set(closedRef.current);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    closedRef.current = next;
    setClosedCount(next.size);
    paintStations();
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(run, 650);
  }

  async function run() {
    const closed = [...closedRef.current];
    if (closed.length === 0) {
      setResult(null);
      paintWards({});
      return;
    }
    setRunning(true);
    try {
      const res = await runScenario(closed);
      setResult(res);
      paintWards(res.ward_deltas ?? {});
    } catch {
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  const pushedPerYear =
    result != null ? Math.round(result.city.pushed_past_6min * (result.scale ?? 3.32)) : 0;

  return (
    <div className="relative h-full w-full">
      <div ref={divRef} className="h-full w-full" />

      {/* hint / verdict chip — styled with the app's own tokens */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-[700] -translate-x-1/2">
        {result == null && !running ? (
          <div className="rounded-xl border border-neutral-200 bg-white/95 px-3.5 py-2 text-[13px] text-neutral-500 shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
            {closedCount === 0
              ? "Click a fire station to close it — the year re-simulates automatically"
              : "…"}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white/95 px-3.5 py-2 text-[13px] text-neutral-700 shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
            {running ? (
              <span className="text-neutral-400">simulating a year of London…</span>
            ) : (
              result && (
                <>
                  <span>
                    city <b className="text-neutral-900">+{result.city.mean_delta_s}s</b>
                  </span>
                  <span>
                    p90 <b className="text-neutral-900">+{result.city.p90_delta_s}s</b>
                  </span>
                  <span>
                    promise breaks{" "}
                    <b style={{ color: "#dc2626" }}>{pushedPerYear.toLocaleString()}/yr</b>
                  </span>
                  <span className="text-neutral-400">{result.elapsed_s}s</span>
                </>
              )
            )}
          </div>
        )}
      </div>

      {/* worst ward strip */}
      {result && result.worst_wards.length > 0 && !running && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-[700] -translate-x-1/2">
          <div className="rounded-xl border border-neutral-200 bg-white/95 px-3.5 py-2 text-[12.5px] text-neutral-600 shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
            worst: {result.worst_wards.slice(0, 3).map((w) => `${w.ward} +${Math.round(w.delta_mean_s)}s`).join(" · ")}
          </div>
        </div>
      )}
    </div>
  );
}
