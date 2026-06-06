import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  API,
  askAgent,
  fetchBaseline,
  fetchCommands,
  fetchStationDetail,
  fetchStations,
  fetchWardsGeo,
  runScenario,
  type BaselineInfo,
  type HourBand,
  type ScenarioResult,
  type StationDetail,
  type UiCommand,
} from "../../lib/api";
import FirePanel from "./FirePanel";

export interface FireMapHandle {
  ask: (text: string, speak?: boolean) => void;
  clearChat: () => void;
}

export interface FireMsg {
  id: number;
  role: "user" | "agent";
  text: string;
  pending?: boolean;
}

const norm = (s: string) =>
  (s || "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The validated fire twin as an analytical workspace: light-mode map + analyst panel.
 *  Click stations to close them — or ask the agent, which drives this same map. */
const FireMap = forwardRef<
  FireMapHandle,
  {
    accent: string;
    onAnalysingChange?: (analysing: boolean) => void;
    onBusyChange?: (busy: boolean) => void;
    onMessagesChange?: (msgs: FireMsg[]) => void;
  }
>(function FireMap({ accent, onAnalysingChange, onBusyChange, onMessagesChange }, handleRef) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const stationsRef = useRef<Record<string, L.CircleMarker>>({});
  const wardsRef = useRef<Record<string, L.Path>>({});
  const closedRef = useRef<Set<string>>(new Set());
  const hoursRef = useRef<HourBand>(null);
  const debounceRef = useRef<number | null>(null);

  const [closed, setClosed] = useState<string[]>([]);
  const [hours, setHours] = useState<HourBand>(null);
  const [baseline, setBaseline] = useState<BaselineInfo | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [running, setRunning] = useState(false);
  const [station, setStation] = useState<StationDetail | null>(null);
  const stationRef = useRef<StationDetail | null>(null);
  useEffect(() => {
    stationRef.current = station;
  }, [station]);
  const [msgs, setMsgs] = useState<FireMsg[]>([]);
  const msgId = useRef(0);
  const busCursor = useRef<number | null>(null);
  const busTimer = useRef<number | null>(null);
  const voiceAudio = useRef<HTMLAudioElement | null>(null);

  const paintStations = useCallback(() => {
    Object.entries(stationsRef.current).forEach(([name, m]) => {
      const isClosed = closedRef.current.has(name);
      m.setStyle({
        color: isClosed ? "#dc2626" : accent,
        fillColor: isClosed ? "#dc2626" : accent,
        fillOpacity: isClosed ? 0.85 : 0.5,
      });
    });
  }, [accent]);

  const paintWards = useCallback((deltas: Record<string, number>) => {
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
  }, []);

  const run = useCallback(async () => {
    const names = [...closedRef.current];
    if (names.length === 0) {
      setResult(null);
      paintWards({});
      return;
    }
    setRunning(true);
    try {
      const res = await runScenario(names, hoursRef.current);
      setResult(res);
      paintWards(res.ward_deltas ?? {});
    } catch {
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [paintWards]);

  const scheduleRun = useCallback(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(run, 650);
  }, [run]);

  const toggleStation = useCallback(
    (name: string) => {
      const next = new Set(closedRef.current);
      if (next.has(name)) next.delete(name);
      else {
        next.add(name);
        fetchStationDetail(name).then(setStation).catch(() => undefined);
      }
      closedRef.current = next;
      setClosed([...next]);
      paintStations();
      scheduleRun();
    },
    [paintStations, scheduleRun]
  );

  const onHours = useCallback(
    (h: HourBand) => {
      hoursRef.current = h;
      setHours(h);
      fetchBaseline(h).then(setBaseline).catch(() => undefined);
      scheduleRun();
    },
    [scheduleRun]
  );

  useEffect(() => {
    fetchBaseline(null).then(setBaseline).catch(() => undefined);
  }, []);

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

  // ---- Ghost Operator: the agent drives THIS map ---------------------------
  const setClosedSet = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      closedRef.current = updater(closedRef.current);
      setClosed([...closedRef.current]);
      paintStations();
    },
    [paintStations]
  );

  const execCommand = useCallback(
    (c: UiCommand) => {
      const map = mapRef.current;
      switch (c.type) {
        case "audio":
          if (c.url) {
            voiceAudio.current?.pause();
            voiceAudio.current = new Audio(`${API}${c.url}`);
            voiceAudio.current.play().catch(() => undefined);
          }
          break;
        case "narrate":
          if (c.text) {
            setMsgs((m) =>
              m.map((x, i) => (i === m.length - 1 && x.role === "agent" ? { ...x, text: c.text! } : x))
            );
          }
          break;
        case "reset":
          setClosedSet(() => new Set());
          paintWards({});
          setResult(null);
          break;
        case "close_stations":
          setClosedSet((prev) => new Set([...prev, ...(c.names ?? [])]));
          break;
        case "run_scenario":
          void run();
          break;
        case "focus_ward": {
          const p = wardsRef.current[norm(c.name ?? "")];
          const center = p && "getBounds" in p ? (p as L.Polygon).getBounds().getCenter() : null;
          if (center && map) map.flyTo(center, 13, { duration: 1.3 });
          break;
        }
        case "focus_station": {
          const m = stationsRef.current[c.name ?? ""];
          if (m && map) map.flyTo(m.getLatLng(), 13, { duration: 1.3 });
          break;
        }
        default:
          break; // 2014/compare verbs live on the wall; harmless to skip here
      }
    },
    [paintWards, run, setClosedSet]
  );

  const stopBusPolling = useCallback(() => {
    if (busTimer.current) {
      window.clearInterval(busTimer.current);
      busTimer.current = null;
    }
  }, []);

  const startBusPolling = useCallback(() => {
    stopBusPolling();
    busTimer.current = window.setInterval(async () => {
      try {
        if (busCursor.current === null) return;
        const d = await fetchCommands(busCursor.current);
        busCursor.current = d.next;
        d.commands.forEach((c, i) => window.setTimeout(() => execCommand(c), i * 450));
      } catch {
        /* poller self-heals next tick */
      }
    }, 600);
  }, [execCommand, stopBusPolling]);

  const ask = useCallback(
    async (text: string, speak = false) => {
      const t = text.trim();
      if (!t) return;
      onBusyChange?.(true);
      setMsgs((m) => [
        ...m.slice(-6),
        { id: ++msgId.current, role: "user", text: t },
        { id: ++msgId.current, role: "agent", text: "", pending: true },
      ]);
      try {
        const tip = await fetchCommands(999_999_999);
        busCursor.current = tip.next;
        startBusPolling();
        const res = await askAgent(t, speak, {
          station: stationRef.current?.name,
          closed: [...closedRef.current],
          hours: hoursRef.current,
        });
        const final =
          res.status === 429
            ? "Hold on — I'm mid-analysis. Ask again in a moment."
            : res.answer || res.detail || "…";
        window.setTimeout(() => {
          setMsgs((m) =>
            m.map((x, i) => (i === m.length - 1 && x.role === "agent" ? { ...x, text: final, pending: false } : x))
          );
        }, 900); // let trailing narrations land first
      } catch {
        setMsgs((m) =>
          m.map((x, i) =>
            i === m.length - 1 && x.role === "agent"
              ? { ...x, text: "Lost the agent — is the engine running?", pending: false }
              : x
          )
        );
      } finally {
        window.setTimeout(stopBusPolling, 3000);
        onBusyChange?.(false);
      }
    },
    [onBusyChange, startBusPolling, stopBusPolling]
  );

  const clearChat = useCallback(() => setMsgs([]), []);
  useImperativeHandle(handleRef, () => ({ ask, clearChat }), [ask, clearChat]);
  useEffect(() => stopBusPolling, [stopBusPolling]);
  useEffect(() => {
    onMessagesChange?.(msgs);
  }, [msgs, onMessagesChange]);

  const analysing = closed.length > 0;

  useEffect(() => {
    onAnalysingChange?.(analysing);
  }, [analysing, onAnalysingChange]);

  return (
    <div className="absolute inset-0">
      <div ref={divRef} className="h-full w-full" />

      {/* quiet hint — the only chrome before an analysis begins */}
      {!analysing && (
        <div className="pointer-events-none absolute left-1/2 top-5 z-[1100] -translate-x-1/2 rounded-full border border-neutral-200 bg-white/90 px-4 py-1.5 text-[12.5px] text-neutral-500 shadow-[0_2px_12px_rgba(0,0,0,0.06)] backdrop-blur-sm">
        click a fire station to start an analysis
        </div>
      )}
      {running && (
        <div className="pointer-events-none absolute left-1/2 top-5 z-[1100] -translate-x-1/2 rounded-full border border-neutral-200 bg-white/90 px-4 py-1.5 text-[12.5px] text-neutral-500 shadow-[0_2px_12px_rgba(0,0,0,0.06)] backdrop-blur-sm">
          simulating a year of London…
        </div>
      )}

      {/* choropleth legend — a warden can't brief colors they can't define */}
      {result && !running && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-[1090] flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-white/90 px-3 py-1.5 text-[11px] text-neutral-500 shadow-sm backdrop-blur-sm">
          <span className="font-medium text-neutral-400">added response</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#facc15" }} />3–20s</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#f97316" }} />20–60s</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#dc2626" }} />60s+</span>
        </div>
      )}

      {/* analytics: appears only once an analysis is live */}
      {analysing && (
        <div className="absolute bottom-3 right-3 top-14 z-[1100] w-[320px]">
          <FirePanel
            accent={accent}
            baseline={baseline}
            hours={hours}
            onHours={onHours}
            closed={closed}
            onReopen={toggleStation}
            result={result}
            running={running}
            station={station}
          />
        </div>
      )}
    </div>
  );
});

export default FireMap;
