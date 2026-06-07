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
  AMB_API,
  askAgent,
  fetchBaseline,
  fetchCommands,
  fetchStationDetail,
  fetchStations,
  fetchWardsGeo,
  fetchCoverageCells,
  fetchStandby,
  fetchWinter,
  fetchHandover,
  fetchHospitals,
  runScenario,
  type BaselineInfo,
  type HourBand,
  type ScenarioResult,
  type StationDetail,
  type UiCommand,
  type CoverageCells,
  type DemandCategory,
  type Bucket,
  type Hospital,
  type StandbyResult,
  type WinterResult,
  type HandoverResult,
} from "../../lib/ambApi";
import AmbulancePanel from "./AmbulancePanel";
import C2Banner from "./C2Banner";
// ambulance-owned handle/message shapes (see ./types) — no longer borrowed from fire
import type { AmbMapHandle, AmbMsg } from "./types";

const TTS_RATE = 1.2; // brisk but natural (pitch preserved)

// fire engine (read-only) — used only to overlay co-location candidates
const FIRE_API =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SIXMINUTES_API ??
  "http://localhost:8095";

/** Predicted-response colour ramp over the 7-minute (420s) C1 mean standard. */
const covColor = (s: number | null) =>
  s == null ? "#7f1d1d" : s <= 360 ? "#0d9488" : s <= 480 ? "#f59e0b" : "#dc2626";

const norm = (s: string) =>
  (s || "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The ambulance free-flow twin as an analytical workspace: light-mode map + analyst panel.
 *  Click stations to close them — or ask the agent, which drives this same map.
 *  A faithful sibling of the fire map; only the data source (:8096) and labels differ. */
const AmbulanceMap = forwardRef<
  AmbMapHandle,
  {
    accent: string;
    onAnalysingChange?: (analysing: boolean) => void;
    onBusyChange?: (busy: boolean) => void;
    onMessagesChange?: (msgs: AmbMsg[]) => void;
    onAudioStateChange?: (playing: boolean) => void;
  }
>(function AmbulanceMap(
  { accent, onAnalysingChange, onBusyChange, onMessagesChange, onAudioStateChange },
  handleRef
) {
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

  // ---- coverage heatmap (the hero layer) -----------------------------------
  const coverageRef = useRef<L.LayerGroup | null>(null);
  const postureRef = useRef<L.LayerGroup | null>(null);
  const fireRef = useRef<L.LayerGroup | null>(null);
  const [coverage, setCoverage] = useState<CoverageCells | null>(null);
  const [category, setCategory] = useState<DemandCategory>("proxy_all");
  const [covHour, setCovHour] = useState(18);
  const [showHeat, setShowHeat] = useState(true);
  const [colocate, setColocate] = useState(false);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [posture, setPosture] = useState<
    | { kind: "standby"; data: StandbyResult }
    | { kind: "winter"; data: WinterResult }
    | { kind: "handover"; data: HandoverResult }
    | null
  >(null);
  const [postureBusy, setPostureBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const categoryRef = useRef<DemandCategory>("proxy_all");
  const covHourRef = useRef(18);
  const [station, setStation] = useState<StationDetail | null>(null);
  const stationRef = useRef<StationDetail | null>(null);
  useEffect(() => {
    stationRef.current = station;
  }, [station]);
  const [msgs, setMsgs] = useState<AmbMsg[]>([]);
  const msgId = useRef(0);
  const busCursor = useRef<number | null>(null);
  const busTimer = useRef<number | null>(null);
  const voiceAudio = useRef<HTMLAudioElement | null>(null);
  const audioQueue = useRef<{ url: string; text?: string }[]>([]);
  const audioBusy = useRef(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const audioAnalyser = useRef<AnalyserNode | null>(null);
  const [thinking, setThinking] = useState(false);
  const [speakSeg, setSpeakSeg] = useState<{ text: string; dur: number; t0: number } | null>(null);
  const [amp, setAmp] = useState(0);
  const ampTimer = useRef<number | null>(null);

  const startAmpMeter = useCallback(() => {
    if (ampTimer.current) return;
    const buf = new Uint8Array(128);
    ampTimer.current = window.setInterval(() => {
      let a = 0;
      if (audioAnalyser.current) {
        audioAnalyser.current.getByteFrequencyData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i];
        a = Math.min(1, (s / buf.length / 140) * 1.4);
      } else {
        a = 0.45 + 0.35 * Math.abs(Math.sin(performance.now() / 260));
      }
      setAmp((prev) => prev * 0.55 + a * 0.45);
    }, 80);
  }, []);

  const stopAmpMeter = useCallback(() => {
    if (ampTimer.current) window.clearInterval(ampTimer.current);
    ampTimer.current = null;
    setAmp(0);
  }, []);

  const pulse = useCallback((m: L.CircleMarker, scale = 1.9, ms = 480) => {
    const r0 = m.getRadius();
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const k = 1 + (scale - 1) * Math.sin(p * Math.PI);
      m.setRadius(r0 * k);
      if (p < 1) requestAnimationFrame(step);
      else m.setRadius(r0);
    };
    requestAnimationFrame(step);
  }, []);

  // animated vehicle relocation: progressive arc + traveling dot + arrival pulse
  const animateMove = useCallback(
    (fromName: string, toName: string) => {
      const map = mapRef.current;
      const A = stationsRef.current[fromName]?.getLatLng();
      const B = stationsRef.current[toName]?.getLatLng();
      if (!map || !A || !B) return;
      const mlat = (A.lat + B.lat) / 2;
      const mlng = (A.lng + B.lng) / 2;
      const dx = B.lng - A.lng;
      const dy = B.lat - A.lat;
      const ctrl = L.latLng(mlat - dx * 0.22, mlng + dy * 0.22);
      const N = 56;
      const pts: L.LatLng[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const lat = (1 - t) ** 2 * A.lat + 2 * (1 - t) * t * ctrl.lat + t ** 2 * B.lat;
        const lng = (1 - t) ** 2 * A.lng + 2 * (1 - t) * t * ctrl.lng + t ** 2 * B.lng;
        pts.push(L.latLng(lat, lng));
      }
      map.flyToBounds(L.latLngBounds([A, B]).pad(0.35), { duration: 0.9 });
      const line = L.polyline([pts[0]], {
        pane: "stns", color: accent, weight: 3.5, opacity: 0.9, dashArray: "1,7", lineCap: "round",
      }).addTo(map);
      const dot = L.circleMarker(pts[0], {
        pane: "stns", radius: 7, weight: 2, color: "#ffffff", fillColor: accent, fillOpacity: 1,
      }).addTo(map);
      const DUR = 1700;
      const t0 = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / DUR);
        const ease = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        const idx = Math.max(1, Math.round(ease * N));
        line.setLatLngs(pts.slice(0, idx + 1));
        dot.setLatLng(pts[Math.min(idx, N)]);
        if (p < 1) requestAnimationFrame(step);
        else {
          const target = stationsRef.current[toName];
          if (target) pulse(target, 2.2, 600);
          window.setTimeout(() => {
            line.setStyle({ opacity: 0 });
            dot.setStyle({ fillOpacity: 0, opacity: 0 });
            window.setTimeout(() => {
              map.removeLayer(line);
              map.removeLayer(dot);
            }, 600);
          }, 2600);
        }
      };
      requestAnimationFrame(step);
    },
    [accent, pulse]
  );

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

  // ---- coverage heatmap: where long predicted response meets heavy demand ----
  const paintCoverage = useCallback((cov: CoverageCells | null, show: boolean) => {
    const lg = coverageRef.current;
    if (!lg) return;
    lg.clearLayers();
    if (!show || !cov) return;
    const maxD = Math.max(1, ...cov.cells.map((c) => c.demand));
    cov.cells.forEach((c) => {
      const r = 3 + 12 * Math.sqrt(c.demand / maxD);
      const respTxt = c.response_s == null ? "no station within 15 km" : `${Math.round(c.response_s)}s predicted`;
      const m = L.circleMarker([c.lat, c.lon], {
        pane: "cov", radius: r, weight: 0, fillColor: covColor(c.response_s), fillOpacity: 0.5,
      });
      m.bindTooltip(`${c.demand.toLocaleString()} calls/yr · ${respTxt}`, { className: "firemap-tip" });
      lg.addLayer(m);
    });
  }, []);

  const loadCoverage = useCallback(
    async (hour: number, cat: DemandCategory) => {
      try {
        const cov = await fetchCoverageCells(hour, cat);
        setCoverage(cov);
      } catch {
        /* heatmap is best-effort */
      }
    },
    []
  );

  // repaint whenever the data or the toggle changes
  useEffect(() => {
    paintCoverage(coverage, showHeat);
  }, [coverage, showHeat, paintCoverage]);

  const onCoverage = useCallback(
    (cat: DemandCategory, hour: number) => {
      categoryRef.current = cat;
      covHourRef.current = hour;
      setCategory(cat);
      setCovHour(hour);
      loadCoverage(hour, cat);
    },
    [loadCoverage]
  );

  // ---- predictive-posture playbooks (standby / winter / handover) -----------
  const paintPosture = useCallback(
    (p: typeof posture) => {
      const lg = postureRef.current;
      const map = mapRef.current;
      if (!lg || !map) return;
      lg.clearLayers();
      if (!p) return;
      const coords = p.data.cell_coords || {};
      const addPin = (cell: string, color: string, label: string) => {
        const c = coords[cell];
        if (!c) return;
        L.circleMarker([c.lat, c.lon], {
          pane: "cov", radius: 17, weight: 2, color, fillColor: color, fillOpacity: 0.1,
        }).addTo(lg);
        const m = L.circleMarker([c.lat, c.lon], {
          pane: "stns", radius: 8, weight: 3, color: "#ffffff", fillColor: color, fillOpacity: 1,
        });
        m.bindTooltip(label, { className: "firemap-tip" });
        lg.addLayer(m);
      };
      if (p.kind === "standby")
        p.data.standby_here.forEach((s, i) =>
          addPin(s.cell, accent, `Standby ${i + 1}: ${s.demand.toLocaleString()} calls/yr underserved · ${Math.round(s.cur_response_s)}s`)
        );
      if (p.kind === "winter")
        p.data.standby_added.forEach((cell, i) => addPin(cell, accent, `Recovery standby unit ${i + 1}`));
      if (p.kind === "handover" && p.data.best_patch_cell)
        addPin(p.data.best_patch_cell, "#16a34a", "Best patch — relocate one unit here");
      const pts = lg
        .getLayers()
        .map((l) => (l as L.CircleMarker).getLatLng?.())
        .filter(Boolean) as L.LatLng[];
      if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.45), { duration: 0.8 });
    },
    [accent]
  );

  const runPlaybook = useCallback(
    async (kind: "standby" | "winter" | "handover", opts?: { bucket?: Bucket; hospital?: string }) => {
      setPanelOpen(true);
      setPostureBusy(true);
      try {
        let p: typeof posture;
        if (kind === "standby") p = { kind, data: await fetchStandby(opts?.bucket ?? "pm") };
        else if (kind === "winter") p = { kind, data: await fetchWinter(opts?.bucket ?? "eve") };
        else
          p = {
            kind,
            data: await fetchHandover(
              opts?.hospital ?? hospitals[0]?.name ?? "Royal London (Whitechapel)",
              opts?.bucket ?? "pm"
            ),
          };
        setPosture(p);
        paintPosture(p);
      } catch {
        /* playbook best-effort */
      } finally {
        setPostureBusy(false);
      }
    },
    [paintPosture, hospitals]
  );

  const clearPosture = useCallback(() => {
    setPosture(null);
    postureRef.current?.clearLayers();
  }, []);

  // ---- fire co-location overlay (free joint coverage) -----------------------
  const onColocate = useCallback(async (on: boolean) => {
    setColocate(on);
    const lg = fireRef.current;
    if (!lg) return;
    lg.clearLayers();
    if (!on) return;
    try {
      const r = await fetch(`${FIRE_API}/stations`);
      const fs: { name: string; lat: number; lon: number }[] = await r.json();
      fs.forEach((s) => {
        const m = L.circleMarker([s.lat, s.lon], {
          pane: "stns", radius: 4.5, weight: 1.6, color: "#9333ea", fillColor: "#ffffff", fillOpacity: 0.9,
        });
        m.bindTooltip(`Fire station: ${s.name} — free co-location candidate`, { className: "firemap-tip" });
        lg.addLayer(m);
      });
    } catch {
      /* fire engine may be offline; overlay is optional */
    }
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
        const m = stationsRef.current[name];
        if (m) pulse(m);
        fetchStationDetail(name).then(setStation).catch(() => undefined);
        setPanelOpen(true); // closing a station opens the analysis panel (fire-parity)
      }
      closedRef.current = next;
      setClosed([...next]);
      paintStations();
      scheduleRun();
    },
    [paintStations, scheduleRun, pulse]
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
    map.createPane("cov");
    const covPane = map.getPane("cov");
    if (covPane) covPane.style.zIndex = "610";
    mapRef.current = map;

    coverageRef.current = L.layerGroup().addTo(map);
    fireRef.current = L.layerGroup().addTo(map);
    postureRef.current = L.layerGroup().addTo(map);

    // hero layer + playbook metadata
    loadCoverage(covHourRef.current, categoryRef.current);
    fetchHospitals().then(setHospitals).catch(() => undefined);

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
          m.bindTooltip(`${s.name} · ${s.pumps} vehicle${s.pumps > 1 ? "s" : ""}`, {
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
      coverageRef.current = null;
      postureRef.current = null;
      fireRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the agent drives THIS map -------------------------------------------
  const setClosedSet = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      closedRef.current = updater(closedRef.current);
      setClosed([...closedRef.current]);
      paintStations();
    },
    [paintStations]
  );

  // dismiss the popped-out analytics card: reopen every station, clear the board
  const resetBoard = useCallback(() => {
    setClosedSet(() => new Set());
    paintWards({});
    setResult(null);
    setStation(null);
    clearPosture();
  }, [setClosedSet, paintWards, clearPosture]);

  const execCommand = useCallback(
    (c: UiCommand) => {
      const map = mapRef.current;
      switch (c.type) {
        case "audio":
          if (c.url) {
            audioQueue.current.push({ url: `${AMB_API}${c.url}`, text: c.text });
            onAudioStateChange?.(true);
            const playNext = () => {
              const next = audioQueue.current.shift();
              if (!next) {
                audioBusy.current = false;
                setSpeakSeg(null);
                stopAmpMeter();
                onAudioStateChange?.(false);
                return;
              }
              audioBusy.current = true;
              const a = new Audio();
              a.crossOrigin = "anonymous";
              a.src = next.url;
              a.playbackRate = TTS_RATE;
              voiceAudio.current = a;
              a.onloadedmetadata = () => {
                if (next.text) {
                  setSpeakSeg({
                    text: next.text,
                    dur: Math.max(600, (a.duration * 1000) / TTS_RATE),
                    t0: performance.now(),
                  });
                }
              };
              a.onended = playNext;
              a.onerror = playNext;
              try {
                if (!audioCtx.current) {
                  const Ctx = window.AudioContext ??
                    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                  audioCtx.current = new Ctx();
                  audioAnalyser.current = audioCtx.current.createAnalyser();
                  audioAnalyser.current.fftSize = 256;
                  audioAnalyser.current.connect(audioCtx.current.destination);
                }
                void audioCtx.current.resume();
                const src = audioCtx.current.createMediaElementSource(a);
                src.connect(audioAnalyser.current!);
              } catch {
                /* analyser unavailable -> synthetic pulse fallback */
              }
              startAmpMeter();
              a.play().catch(playNext);
            };
            if (!audioBusy.current) playNext();
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
          (c.names ?? []).forEach((n) => {
            const m = stationsRef.current[n];
            if (m) pulse(m);
          });
          break;
        case "move_unit": {
          const cc = c as UiCommand & { from?: string; to?: string };
          if (cc.from && cc.to) animateMove(cc.from, cc.to);
          break;
        }
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
          break;
      }
    },
    [paintWards, run, setClosedSet, animateMove, pulse, onAudioStateChange, startAmpMeter, stopAmpMeter]
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
      setThinking(true);
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
        }, 900);
      } catch {
        setMsgs((m) =>
          m.map((x, i) =>
            i === m.length - 1 && x.role === "agent"
              ? { ...x, text: "Lost the agent — is the ambulance engine running on :8096?", pending: false }
              : x
          )
        );
      } finally {
        window.setTimeout(stopBusPolling, 8000);
        setThinking(false);
        onBusyChange?.(false);
      }
    },
    [onBusyChange, startBusPolling, stopBusPolling]
  );

  const clearChat = useCallback(() => setMsgs([]), []);
  const note = useCallback((text: string) => {
    setMsgs((m) => [...m.slice(-7), { id: ++msgId.current, role: "agent", text }]);
  }, []);
  const stopAudio = useCallback(() => {
    audioQueue.current = [];
    audioBusy.current = false;
    if (voiceAudio.current) {
      voiceAudio.current.onended = null;
      voiceAudio.current.onerror = null;
      voiceAudio.current.pause();
    }
    setSpeakSeg(null);
    stopAmpMeter();
    onAudioStateChange?.(false);
  }, [onAudioStateChange, stopAmpMeter]);
  useImperativeHandle(handleRef, () => ({ ask, clearChat, note, stopAudio }),
    [ask, clearChat, note, stopAudio]);
  useEffect(() => stopBusPolling, [stopBusPolling]);
  useEffect(() => {
    onMessagesChange?.(msgs);
  }, [msgs, onMessagesChange]);

  // Report panel open/close so Chat slides the composer (same animation as fire:
  // open → input box glides to right-[336px]; close → glides back to centre).
  useEffect(() => {
    onAnalysingChange?.(panelOpen);
    return () => onAnalysingChange?.(false);
  }, [panelOpen, onAnalysingChange]);

  const speaking = speakSeg !== null;

  return (
    <div className="absolute inset-0">
      <div ref={divRef} className="h-full w-full" />

      {/* Insight 1 — the broken Category-2 promise, framing the whole board */}
      <C2Banner accent={accent} />

      {/* ambient edge glow — the room breathes while the agent speaks */}
      <div
        className="pointer-events-none absolute inset-0 z-[1060] transition-opacity duration-500"
        style={{
          opacity: speaking ? 0.25 + amp * 0.55 : 0,
          boxShadow: `inset 0 0 140px 10px ${accent}`,
        }}
      />

      {/* corner presence */}
      {(thinking || speaking) && (
        <div className="pointer-events-none absolute left-4 top-4 z-[1100] flex items-center gap-2.5 rounded-full border border-neutral-200 bg-white/90 py-1.5 pl-2 pr-4 shadow-[0_2px_12px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          <span
            className="block h-5 w-5 rounded-full transition-transform duration-100"
            style={{
              background: `radial-gradient(circle at 32% 28%, #ffffff 0%, ${accent}66 35%, ${accent} 75%)`,
              boxShadow: `0 0 ${8 + amp * 22}px ${accent}aa`,
              transform: `scale(${speaking ? 1 + amp * 0.45 : 1})`,
              animation: thinking && !speaking ? "orb-breathe 1.6s ease-in-out infinite" : undefined,
            }}
          />
          <span className="text-[12px] font-medium text-neutral-600">
            {speaking ? "LAS Watch · speaking" : "LAS Watch · thinking"}
          </span>
          {speaking && (
            <span className="flex h-3.5 items-end gap-[2px]">
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className="w-[2.5px] rounded-full transition-[height] duration-100"
                  style={{
                    background: accent,
                    height: `${Math.max(2, (amp * 14 * (0.5 + Math.abs(Math.sin(performance.now() / 150 + i * 1.4))))) | 0}px`,
                  }}
                />
              ))}
            </span>
          )}
        </div>
      )}

      {/* cinematic subtitle */}
      {speakSeg && (
        <div
          className={
            "pointer-events-none absolute bottom-32 left-0 z-[1090] px-4 transition-[right] duration-300 " +
            (panelOpen ? "right-[336px]" : "right-0")
          }
        >
          <Subtitle key={speakSeg.t0} seg={speakSeg} accent={accent} />
        </div>
      )}

      {running && (
        <div className="pointer-events-none absolute left-6 top-[72px] z-[1100] rounded-full border border-neutral-200 bg-white/90 px-4 py-1.5 text-[12.5px] text-neutral-500 shadow-[0_2px_12px_rgba(0,0,0,0.06)] backdrop-blur-sm">
          re-simulating London…
        </div>
      )}

      {/* coverage / scenario legend */}
      {!result && showHeat && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-[1090] flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-white/90 px-3 py-1.5 text-[11px] text-neutral-500 shadow-sm backdrop-blur-sm">
          <span className="font-medium text-neutral-400">predicted response</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "#0d9488" }} />≤6 min</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "#f59e0b" }} />6–8 min</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "#dc2626" }} />8 min+</span>
          <span className="text-neutral-400">· size = demand</span>
        </div>
      )}
      {result && !running && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-[1090] flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-white/90 px-3 py-1.5 text-[11px] text-neutral-500 shadow-sm backdrop-blur-sm">
          <span className="font-medium text-neutral-400">added response</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#facc15" }} />3–20s</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#f97316" }} />20–60s</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#dc2626" }} />60s+</span>
        </div>
      )}

      {/* launcher — reopens the briefing/decisions panel after it's been closed */}
      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          className="animate-fade-up absolute right-3 top-[72px] z-[1100] flex items-center gap-2 rounded-full border border-neutral-200 bg-white/95 px-3.5 py-2 text-[12.5px] font-medium text-neutral-700 shadow-[0_2px_12px_rgba(0,0,0,0.10)] backdrop-blur-sm transition-colors hover:border-neutral-300"
        >
          <span className="h-2 w-2 rounded-full" style={{ background: accent }} />
          Coverage &amp; decisions
        </button>
      )}

      {/* briefing → sandbox panel (closeable; width aligned to the composer's right-[336px] shift) */}
      {panelOpen && (
      <div className="animate-fade-up absolute bottom-3 right-3 top-[72px] z-[1100] w-[320px]">
        <button
          onClick={() => {
            resetBoard();
            setPanelOpen(false);
          }}
          title="Close panel"
          className="absolute right-2 top-2 z-[1101] flex h-7 w-7 items-center justify-center rounded-lg text-[15px] leading-none text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
        >
          ✕
        </button>
        <AmbulancePanel
          accent={accent}
          baseline={baseline}
          hours={hours}
          onHours={onHours}
          closed={closed}
          onReopen={toggleStation}
          result={result}
          running={running}
          station={station}
          coverage={coverage}
          category={category}
          covHour={covHour}
          onCoverage={onCoverage}
          showHeat={showHeat}
          onShowHeat={setShowHeat}
          colocate={colocate}
          onColocate={onColocate}
          hospitals={hospitals}
          posture={posture}
          postureBusy={postureBusy}
          onRunPlaybook={runPlaybook}
          onClearPosture={clearPosture}
        />
      </div>
      )}
    </div>
  );
});

/** Karaoke-style subtitle: words appear at the pace of the audio segment. */
function Subtitle({ seg, accent }: { seg: { text: string; dur: number; t0: number }; accent: string }) {
  const words = seg.text.split(/\s+/).filter(Boolean);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const iv = window.setInterval(() => {
      const p = Math.min(1, (performance.now() - seg.t0) / (seg.dur * 0.92));
      setShown(Math.ceil(p * words.length));
      if (p >= 1) window.clearInterval(iv);
    }, 60);
    return () => window.clearInterval(iv);
  }, [seg.t0, seg.dur, words.length]);
  return (
    <div className="mx-auto w-fit max-w-3xl">
      <div
        className="animate-fade-up rounded-2xl border border-neutral-200/70 bg-white/95 px-5 py-3 text-center shadow-[0_8px_30px_rgba(0,0,0,0.10)] backdrop-blur-md"
        style={{ borderTopColor: accent, borderTopWidth: 2 }}
      >
        <div className="text-[17px] font-medium leading-7 tracking-[-0.01em] text-neutral-900">
          {words.slice(0, shown).join(" ")}
          <span className="text-neutral-300">{shown < words.length ? " " + words.slice(shown).join(" ") : ""}</span>
        </div>
      </div>
    </div>
  );
}

export default AmbulanceMap;
