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
import "../../lib/leafletGlobal"; // publish L onto window…
import "leaflet.heat"; // …so this plugin can extend it (adds L.heatLayer)
import {
  fetchAllocation,
  fetchBaseline,
  fetchCategories,
  fetchCells,
  fetchDamage,
  fetchPlan,
  fetchPredict,
  fetchStations,
  geocode,
  runScenario,
  type AllocResult,
  type DamageProps,
  type PlanResult,
  type PoliceBaseline,
  type PoliceScenario,
  type PoliceStation,
  type PredictResult,
} from "../../lib/policeApi";
import PolicePanel, { type Lens } from "./PolicePanel";
import PolicePlan from "./PolicePlan";
import { watchCommander, type FocusMark } from "./watchCommander";

type Mode = "plan" | "explore";

/** Imperative handle so the chat bar (in Chat.tsx) can drive this same map. */
export interface PoliceMapHandle {
  ask: (text: string) => void;
  clearChat: () => void;
}

export interface PoliceMsg {
  id: number;
  role: "user" | "agent";
  text: string;
  pending?: boolean;
}

const deltaColor = (d: number) => (d > 60 ? "#dc2626" : d > 20 ? "#f97316" : "#facc15");

/** The police digital twin as an analytical workspace: a light-mode London with five
 *  lenses — close bases, read demand, rank criticality, forecast an area, rebalance the
 *  fleet. Tier-B parallel to the fire FireMap, wired to the police backend on :8096.
 *  The Watch Commander chat (Chat.tsx) drives it through the imperative `ask` handle. */
const PoliceMap = forwardRef<
  PoliceMapHandle,
  {
    accent: string;
    onMessagesChange?: (msgs: PoliceMsg[]) => void;
    onBusyChange?: (busy: boolean) => void;
  }
>(function PoliceMap({ accent, onMessagesChange, onBusyChange }, handleRef) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const canvasRef = useRef<L.Renderer | null>(null);

  // leaflet layer groups, toggled per lens
  const stationLG = useRef<L.LayerGroup | null>(null);
  const cellsLG = useRef<L.LayerGroup | null>(null);
  const scenarioLG = useRef<L.LayerGroup | null>(null);
  const damageLG = useRef<L.LayerGroup | null>(null);
  const predictLG = useRef<L.LayerGroup | null>(null);
  const deployLG = useRef<L.LayerGroup | null>(null);
  const planLG = useRef<L.LayerGroup | null>(null);
  const chatLG = useRef<L.LayerGroup | null>(null); // commander focus ring + local move emphasis
  const stationMarks = useRef<Record<string, L.CircleMarker>>({});

  // react state (drives the panel)
  const [mode, setMode] = useState<Mode>("plan"); // lead with the plain-language plan
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [showPlan, setShowPlan] = useState(false); // false = today's footprint, true = next-month plan
  const [lens, setLens] = useState<Lens>("closure");
  const [categories, setCategories] = useState<string[]>(["all"]);
  const [category, setCategory] = useState("all");
  const [baseline, setBaseline] = useState<PoliceBaseline | null>(null);
  const [closed, setClosed] = useState<string[]>([]);
  const [scenario, setScenario] = useState<PoliceScenario | null>(null);
  const [running, setRunning] = useState(false);
  const [damage, setDamage] = useState<DamageProps[]>([]);
  const [predict, setPredict] = useState<PredictResult | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [radiusKm, setRadiusKm] = useState(2);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [allocation, setAllocation] = useState<AllocResult | null>(null);
  const [units, setUnits] = useState(600);

  // ---- Watch Commander chat (drives this map; transcript lives in Chat.tsx) ----
  const [msgs, setMsgs] = useState<PoliceMsg[]>([]);
  const msgId = useRef(0);
  const chatBusy = useRef(false);

  // refs mirror state for use inside stable leaflet handlers
  const modeRef = useRef(mode); modeRef.current = mode;
  const lensRef = useRef(lens); lensRef.current = lens;
  const radiusRef = useRef(radiusKm); radiusRef.current = radiusKm;
  const categoryRef = useRef(category); categoryRef.current = category;
  const closedRef = useRef<Set<string>>(new Set());
  const scenDebounce = useRef<number | null>(null);
  const allocDebounce = useRef<number | null>(null);

  // ---- station paint (respects closed + lens dimming) ----------------------
  const paintStations = useCallback(() => {
    const dim = lensRef.current === "forecast" || lensRef.current === "deploy";
    Object.entries(stationMarks.current).forEach(([name, m]) => {
      const isClosed = closedRef.current.has(name);
      m.setStyle({
        color: isClosed ? "#dc2626" : accent,
        fillColor: isClosed ? "#dc2626" : accent,
        fillOpacity: isClosed ? 0.9 : dim ? 0.18 : 0.55,
        opacity: dim && !isClosed ? 0.35 : 1,
      });
    });
  }, [accent]);

  // ---- scenario (closure lens) --------------------------------------------
  const paintScenario = useCallback((res: PoliceScenario | null) => {
    const lg = scenarioLG.current;
    if (!lg) return;
    lg.clearLayers();
    if (!res) return;
    res.cell_deltas.forEach((c) => {
      if (c.delta_s < 3) return;
      L.circleMarker([c.lat, c.lon], {
        renderer: canvasRef.current ?? undefined,
        radius: 5,
        weight: 0,
        fillColor: deltaColor(c.delta_s),
        fillOpacity: Math.min(0.85, 0.3 + c.delta_s / 200),
      }).addTo(lg);
    });
  }, []);

  const runScen = useCallback(async () => {
    const names = [...closedRef.current];
    if (names.length === 0) {
      setScenario(null);
      paintScenario(null);
      return;
    }
    setRunning(true);
    try {
      const res = await runScenario(names, categoryRef.current);
      setScenario(res);
      paintScenario(res);
    } catch {
      setScenario(null);
    } finally {
      setRunning(false);
    }
  }, [paintScenario]);

  const scheduleScen = useCallback(() => {
    if (scenDebounce.current) window.clearTimeout(scenDebounce.current);
    scenDebounce.current = window.setTimeout(runScen, 450);
  }, [runScen]);

  const toggleStation = useCallback(
    (name: string) => {
      if (lensRef.current !== "closure") {
        setLens("closure"); // closing only makes sense in the closure lens — switch into it
      }
      const next = new Set(closedRef.current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      closedRef.current = next;
      setClosed([...next]);
      paintStations();
      scheduleScen();
    },
    [paintStations, scheduleScen]
  );

  const reopen = useCallback(
    (name: string) => {
      closedRef.current.delete(name);
      setClosed([...closedRef.current]);
      paintStations();
      scheduleScen();
    },
    [paintStations, scheduleScen]
  );

  const reset = useCallback(() => {
    closedRef.current = new Set();
    setClosed([]);
    setScenario(null);
    paintScenario(null);
    paintStations();
  }, [paintScenario, paintStations]);

  // ---- demand surface (demand lens) ---------------------------------------
  // A smooth blue heat field instead of a dot grid: deep/opaque blue where crime
  // is concentrated, fading to transparent where it's sparse. sqrt() compresses
  // the long tail so mid-demand areas still read as blue, not washed out.
  const loadCells = useCallback(
    async (cat: string) => {
      const lg = cellsLG.current;
      if (!lg) return;
      try {
        const cells = await fetchCells(cat);
        const max = cells.reduce((m, c) => Math.max(m, c.weight), 1);
        lg.clearLayers();
        const points: [number, number, number][] = cells.map((c) => [
          c.lat,
          c.lon,
          Math.sqrt(c.weight / max),
        ]);
        if (typeof L.heatLayer === "function") {
          L.heatLayer(points, {
            radius: 22,
            blur: 18,
            minOpacity: 0.15,
            max: 1.0,
            gradient: {
              0.0: "#dbeafe",
              0.35: "#93c5fd",
              0.6: "#3b82f6",
              0.85: "#2563eb",
              1.0: "#1e3a8a",
            },
          }).addTo(lg);
        } else {
          // graceful fallback to dots if the plugin failed to attach
          cells.forEach((c) => {
            const t = c.weight / max;
            L.circleMarker([c.lat, c.lon], {
              renderer: canvasRef.current ?? undefined,
              radius: 3 + 6 * Math.sqrt(t),
              weight: 0,
              fillColor: accent,
              fillOpacity: 0.2 + 0.6 * t,
            }).addTo(lg);
          });
        }
      } catch {
        /* leave previous cells */
      }
    },
    [accent]
  );

  // ---- criticality (damage rings) -----------------------------------------
  const paintDamage = useCallback((feats: DamageProps[], geo: GeoJSON.FeatureCollection) => {
    const lg = damageLG.current;
    if (!lg) return;
    lg.clearLayers();
    const max = feats.reduce((m, d) => Math.max(m, d.mean_added_s), 1);
    geo.features.forEach((f) => {
      const p = f.properties as unknown as DamageProps;
      const g = f.geometry as GeoJSON.Point;
      const [lon, lat] = g.coordinates;
      const t = p.mean_added_s / max;
      L.circleMarker([lat, lon], {
        renderer: canvasRef.current ?? undefined,
        radius: 6 + 22 * Math.sqrt(t),
        weight: 1.5,
        color: "#dc2626",
        opacity: 0.5 + 0.4 * t,
        fillColor: "#dc2626",
        fillOpacity: 0.08 + 0.22 * t,
      })
        .bindTooltip(`${p.station}: +${Math.round(p.mean_added_s)}s if closed`, { className: "firemap-tip" })
        .addTo(lg);
    });
  }, []);

  // ---- forecast (predict) -------------------------------------------------
  const runPredict = useCallback(
    async (lat: number, lon: number, radiusOverride?: number) => {
      const lg = predictLG.current;
      if (!lg) return;
      const rad = radiusOverride ?? radiusRef.current;
      setPredicting(true);
      setSearchError(null);
      lg.clearLayers();
      L.circle([lat, lon], {
        radius: rad * 1000,
        weight: 1.5,
        color: accent,
        fillColor: accent,
        fillOpacity: 0.08,
      }).addTo(lg);
      L.circleMarker([lat, lon], { radius: 6, weight: 2, color: "#fff", fillColor: accent, fillOpacity: 1 }).addTo(lg);
      mapRef.current?.setView([lat, lon], 13, { animate: true });
      try {
        const res = await fetchPredict(lat, lon, rad);
        setPredict(res);
      } catch {
        setSearchError("Couldn't read that area.");
      } finally {
        setPredicting(false);
      }
    },
    [accent]
  );

  const onSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) return;
      setSearchError(null);
      try {
        const hits = await geocode(q);
        if (!hits.length) {
          setSearchError("No London match for that place.");
          return;
        }
        await runPredict(Number(hits[0].lat), Number(hits[0].lon));
      } catch {
        setSearchError("Search failed — try again.");
      }
    },
    [runPredict]
  );

  // ---- deploy (allocation) ------------------------------------------------
  const paintDeploy = useCallback((res: AllocResult | null) => {
    const lg = deployLG.current;
    if (!lg) return;
    lg.clearLayers();
    if (!res) return;
    const maxAbs = res.stations.reduce((m, s) => Math.max(m, Math.abs(s.delta)), 1);
    res.stations.forEach((s) => {
      const a = Math.abs(s.delta);
      if (a < 0.05) return;
      const under = s.delta > 0; // needs more units
      L.circleMarker([s.lat, s.lon], {
        renderer: canvasRef.current ?? undefined,
        radius: 4 + 18 * Math.sqrt(a / maxAbs),
        weight: 1,
        color: under ? "#dc2626" : "#2563eb",
        opacity: 0.7,
        fillColor: under ? "#dc2626" : "#2563eb",
        fillOpacity: 0.35,
      })
        .bindTooltip(`${s.name}: ${under ? "+" : ""}${s.delta} units · ${s.demand_per_mo}/mo`, {
          className: "firemap-tip",
        })
        .addTo(lg);
    });
  }, []);

  const loadAlloc = useCallback(
    async (u: number) => {
      try {
        const res = await fetchAllocation(u);
        setAllocation(res);
        paintDeploy(res);
      } catch {
        /* keep prior */
      }
    },
    [paintDeploy]
  );

  // ---- plan (today's footprint → next-month redeployment) -----------------
  const paintPlan = useCallback(
    (p: PlanResult | null, show: boolean) => {
      const lg = planLG.current;
      if (!lg) return;
      lg.clearLayers();
      if (!p) return;
      const maxMove = p.stations.reduce((m, s) => Math.max(m, Math.abs(s.move_raw)), 1);
      p.stations.forEach((s) => {
        // "today" = uniform even footprint; "next month" = grow receivers / shrink givers
        let color = accent;
        let radius = 6;
        let fillOpacity = 0.45;
        let label = `${s.name} · ~${p.even_per_station} units (even)`;
        if (show) {
          const recv = s.move_raw > 0.5;
          const give = s.move_raw < -0.5;
          color = recv ? "#16a34a" : give ? "#dc2626" : "#cbd5e1";
          radius = 4 + 15 * Math.sqrt(Math.abs(s.move_raw) / maxMove);
          const sign = s.move > 0 ? "+" : s.move < 0 ? "−" : "";
          label = `${s.name} · ${sign}${Math.abs(s.move)} officers · ${Math.round(s.demand_next).toLocaleString()}/mo`;
        }
        L.circleMarker([s.lat, s.lon], {
          renderer: canvasRef.current ?? undefined,
          radius,
          weight: 1,
          color,
          opacity: 0.85,
          fillColor: color,
          fillOpacity,
        })
          .bindTooltip(label, { className: "firemap-tip" })
          .addTo(lg);
      });
    },
    [accent]
  );

  const loadPlan = useCallback(async () => {
    try {
      const res = await fetchPlan();
      setPlan(res);
    } catch {
      /* keep prior */
    }
  }, []);

  // ---- commander focus: ring an area + emphasise the local moves --------------
  const paintFocus = useCallback(
    (focus: { lat: number; lon: number; label: string; highlight: FocusMark[] } | null) => {
      const lg = chatLG.current;
      if (!lg) return;
      lg.clearLayers();
      if (!focus) return;
      L.circle([focus.lat, focus.lon], {
        pane: "chat",
        radius: 2000,
        weight: 1.5,
        dashArray: "4 4",
        color: accent,
        fillColor: accent,
        fillOpacity: 0.05,
      }).addTo(lg);
      focus.highlight.forEach((h) => {
        const col = h.move > 0 ? "#16a34a" : h.move < 0 ? "#dc2626" : "#64748b";
        const sign = h.move > 0 ? "+" : h.move < 0 ? "−" : "";
        L.circleMarker([h.lat, h.lon], {
          pane: "chat",
          radius: 9,
          weight: 2.5,
          color: col,
          fillColor: col,
          fillOpacity: 0.18,
        })
          .bindTooltip(`${h.name} · ${sign}${Math.abs(h.move)} officers`, { className: "firemap-tip" })
          .addTo(lg);
      });
    },
    [accent]
  );

  const ask = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || chatBusy.current) return;
      chatBusy.current = true;
      onBusyChange?.(true);
      const agentId = ++msgId.current;
      setMsgs((m) => [
        ...m.slice(-8),
        { id: ++msgId.current, role: "user", text: t },
        { id: agentId, role: "agent", text: "", pending: true },
      ]);
      try {
        const { reply, actions } = await watchCommander(t);
        actions.forEach((a) => {
          switch (a.kind) {
            case "forecast":
              chatLG.current?.clearLayers();
              setMode("explore");
              setLens("forecast");
              void runPredict(a.lat, a.lon, a.radiusKm);
              break;
            case "plan":
              setMode("plan");
              setShowPlan(a.show);
              if (a.focus) {
                const f = a.focus;
                window.setTimeout(() => {
                  paintFocus(f);
                  mapRef.current?.setView([f.lat, f.lon], 12, { animate: true });
                }, 140); // win the mode-change recenter
              } else {
                paintFocus(null);
              }
              break;
            case "scenario":
              chatLG.current?.clearLayers();
              closedRef.current = new Set(a.close);
              setClosed([...closedRef.current]);
              setMode("explore");
              setLens("closure");
              paintStations();
              void runScen();
              break;
            default:
              break;
          }
        });
        setMsgs((m) =>
          m.map((x) => (x.id === agentId ? { ...x, text: reply, pending: false } : x))
        );
      } catch {
        setMsgs((m) =>
          m.map((x) =>
            x.id === agentId
              ? { ...x, text: "Lost the police engine — is the API on :8096 up?", pending: false }
              : x
          )
        );
      } finally {
        chatBusy.current = false;
        onBusyChange?.(false);
      }
    },
    [onBusyChange, paintFocus, paintStations, runPredict, runScen]
  );

  const clearChat = useCallback(() => {
    setMsgs([]);
    chatLG.current?.clearLayers();
  }, []);

  useImperativeHandle(handleRef, () => ({ ask, clearChat }), [ask, clearChat]);

  useEffect(() => {
    onMessagesChange?.(msgs);
  }, [msgs, onMessagesChange]);

  // ---- map init -----------------------------------------------------------
  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { zoomControl: false, attributionControl: false }).setView(
      [51.505, -0.09],
      11
    );
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 18 }).addTo(map);
    canvasRef.current = L.canvas({ padding: 0.5 });
    map.createPane("stns");
    const pane = map.getPane("stns");
    if (pane) pane.style.zIndex = "640";
    map.createPane("chat");
    const cpane = map.getPane("chat");
    if (cpane) cpane.style.zIndex = "660"; // commander focus sits above everything
    mapRef.current = map;

    cellsLG.current = L.layerGroup();
    scenarioLG.current = L.layerGroup();
    damageLG.current = L.layerGroup();
    predictLG.current = L.layerGroup();
    deployLG.current = L.layerGroup();
    planLG.current = L.layerGroup();
    chatLG.current = L.layerGroup().addTo(map); // always on, drawn into by the chat
    stationLG.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (modeRef.current === "explore" && lensRef.current === "forecast")
        void runPredict(e.latlng.lat, e.latlng.lng);
    });

    let cancelled = false;
    fetchStations()
      .then((sts: PoliceStation[]) => {
        if (cancelled) return;
        sts.forEach((s) => {
          const m = L.circleMarker([s.lat, s.lon], {
            pane: "stns",
            bubblingMouseEvents: false,
            radius: s.kind?.toLowerCase().includes("hq") ? 7 : 5,
            weight: 1.5,
            color: accent,
            fillColor: accent,
            fillOpacity: 0.55,
          });
          m.bindTooltip(`${s.name}${s.kind ? ` · ${s.kind}` : ""}`, { className: "firemap-tip" });
          m.on("click", () => toggleStation(s.name));
          m.addTo(stationLG.current!);
          stationMarks.current[s.name] = m;
        });
      })
      .catch(() => undefined);

    fetchCategories().then((c) => !cancelled && setCategories(c)).catch(() => undefined);
    fetchBaseline().then((b) => !cancelled && setBaseline(b)).catch(() => undefined);
    void loadCells("all");
    fetchDamage()
      .then((geo) => {
        if (cancelled) return;
        const feats = geo.features
          .map((f) => f.properties as unknown as DamageProps)
          .sort((a, b) => b.mean_added_s - a.mean_added_s);
        setDamage(feats);
        paintDamage(feats, geo);
      })
      .catch(() => undefined);
    void loadAlloc(600);
    void loadPlan();

    return () => {
      cancelled = true;
      map.remove();
      mapRef.current = null;
      stationMarks.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- mode + lens → which overlays are on the map ------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const show = (lg: L.LayerGroup | null, on: boolean) => {
      if (!lg) return;
      if (on && !map.hasLayer(lg)) lg.addTo(map);
      if (!on && map.hasLayer(lg)) map.removeLayer(lg);
    };
    const planMode = mode === "plan";
    // plan overlay and the explore overlays (incl. the clickable station estate) are exclusive
    show(planLG.current, planMode);
    show(stationLG.current, !planMode);
    show(cellsLG.current, !planMode && lens === "demand");
    show(scenarioLG.current, !planMode && lens === "closure");
    show(damageLG.current, !planMode && lens === "criticality");
    show(predictLG.current, !planMode && lens === "forecast");
    show(deployLG.current, !planMode && lens === "deploy");
    if (planMode) paintPlan(plan, showPlan);
    else paintStations();
  }, [mode, lens, plan, showPlan, paintStations, paintPlan]);

  // ---- snap to the London overview for whole-city views -------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode === "plan" || lens === "demand" || lens === "criticality" || lens === "deploy") {
      map.setView([51.505, -0.09], 11, { animate: true });
    }
  }, [mode, lens]);

  // ---- category change → reload demand + rerun open scenario --------------
  useEffect(() => {
    void loadCells(category);
    if (closedRef.current.size > 0) scheduleScen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  // ---- units change → re-allocate (debounced) -----------------------------
  useEffect(() => {
    if (allocDebounce.current) window.clearTimeout(allocDebounce.current);
    allocDebounce.current = window.setTimeout(() => void loadAlloc(units), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  const hint =
    mode === "plan"
      ? showPlan
        ? "green = reinforce · red = free up · sized by units moved"
        : "today's footprint — press Optimise for next month"
      : lens === "closure"
        ? "click a police base to take it offline"
        : lens === "demand"
          ? "crimes per month, per 1 km cell"
          : lens === "criticality"
            ? "rings sized by closure damage"
            : lens === "forecast"
              ? "click the map to forecast an area"
              : "demand-balanced fleet vs even spread";

  return (
    <div className="absolute inset-0">
      <div ref={divRef} className="h-full w-full" />

      {/* quiet contextual hint */}
      <div className="pointer-events-none absolute left-1/2 top-5 z-[1100] -translate-x-1/2 rounded-full border border-neutral-200 bg-white/90 px-4 py-1.5 text-[12.5px] text-neutral-500 shadow-[0_2px_12px_rgba(0,0,0,0.06)] backdrop-blur-sm">
        {hint}
      </div>

      {/* right column — mode toggle + the active panel */}
      <div className="absolute bottom-3 right-3 top-14 z-[1100] flex w-[360px] flex-col gap-2">
        <div className="flex rounded-xl border border-neutral-200 bg-white/95 p-0.5 shadow-[0_4px_20px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          {(["plan", "explore"] as Mode[]).map((mid) => {
            const active = mode === mid;
            return (
              <button
                key={mid}
                onClick={() => setMode(mid)}
                className={
                  "flex-1 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors " +
                  (active ? "bg-neutral-900 text-white" : "text-neutral-500 hover:text-neutral-800")
                }
              >
                {mid === "plan" ? "Plan" : "Explore"}
              </button>
            );
          })}
        </div>

        <div className="animate-fade-up min-h-0 flex-1">
          {mode === "plan" ? (
            <PolicePlan
              accent={accent}
              plan={plan}
              showPlan={showPlan}
              loading={!plan}
              onOptimise={() => setShowPlan(true)}
              onBack={() => setShowPlan(false)}
            />
          ) : (
            <PolicePanel
              accent={accent}
              lens={lens}
              onLens={setLens}
              categories={categories}
              category={category}
              onCategory={setCategory}
              baseline={baseline}
              closed={closed}
              onReopen={reopen}
              onReset={reset}
              scenario={scenario}
              running={running}
              damage={damage}
              predict={predict}
              predicting={predicting}
              radiusKm={radiusKm}
              onRadius={setRadiusKm}
              onSearch={onSearch}
              searchError={searchError}
              allocation={allocation}
              units={units}
              onUnits={setUnits}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export default PoliceMap;
