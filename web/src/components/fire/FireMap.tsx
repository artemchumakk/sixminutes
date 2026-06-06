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
  /** drop a system-style agent note into the thread without invoking the LLM */
  note: (text: string) => void;
  /** silence any playing TTS immediately */
  stopAudio: () => void;
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
    onAudioStateChange?: (playing: boolean) => void;
  }
>(function FireMap(
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
        a = 0.45 + 0.35 * Math.abs(Math.sin(performance.now() / 260)); // graceful fallback
      }
      setAmp((prev) => prev * 0.55 + a * 0.45);
    }, 80);
  }, []);

  const stopAmpMeter = useCallback(() => {
    if (ampTimer.current) window.clearInterval(ampTimer.current);
    ampTimer.current = null;
    setAmp(0);
  }, []);

  // pulse a marker's radius (close/arrival emphasis)
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

  // animated pump relocation: progressive arc + traveling dot + arrival pulse
  const animateMove = useCallback(
    (fromName: string, toName: string) => {
      const map = mapRef.current;
      const A = stationsRef.current[fromName]?.getLatLng();
      const B = stationsRef.current[toName]?.getLatLng();
      if (!map || !A || !B) return;
      // quadratic bezier control point, offset perpendicular for a gentle arc
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
        const ease = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2; // easeInOutQuad
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
            // QUEUE segments — never cut one narration with the next
            audioQueue.current.push({ url: `${API}${c.url}`, text: c.text });
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
              voiceAudio.current = a;
              a.onloadedmetadata = () => {
                if (next.text) {
                  setSpeakSeg({ text: next.text, dur: Math.max(600, a.duration * 1000), t0: performance.now() });
                }
              };
              a.onended = playNext;
              a.onerror = playNext;
              // audio-reactive: tap the element into a shared analyser (best effort)
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
          break; // 2014/compare verbs live on the wall; harmless to skip here
      }
    },
    [paintWards, run, setClosedSet, animateMove, pulse]
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
        window.setTimeout(stopBusPolling, 8000); // generous: final-verdict TTS lags the answer
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

  const analysing = closed.length > 0;

  useEffect(() => {
    onAnalysingChange?.(analysing);
  }, [analysing, onAnalysingChange]);

  const speaking = speakSeg !== null;

  return (
    <div className="absolute inset-0">
      <div ref={divRef} className="h-full w-full" />

      {/* ambient edge glow — the room breathes while the agent speaks */}
      <div
        className="pointer-events-none absolute inset-0 z-[1060] transition-opacity duration-500"
        style={{
          opacity: speaking ? 0.25 + amp * 0.55 : 0,
          boxShadow: `inset 0 0 140px 10px ${accent}`,
        }}
      />

      {/* corner presence — replaces the blocking center card */}
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
            {speaking ? "Brigade Watch · speaking" : "Brigade Watch · thinking"}
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

      {/* cinematic subtitle — word-reveal paced to the segment's real duration */}
      {speakSeg && (
        <div
          className={
            "pointer-events-none absolute bottom-32 left-0 z-[1090] px-4 transition-[right] duration-300 " +
            (analysing ? "right-[336px]" : "right-0")
          }
        >
          <Subtitle key={speakSeg.t0} seg={speakSeg} accent={accent} />
        </div>
      )}

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
        <div className="animate-fade-up absolute bottom-3 right-3 top-14 z-[1100] w-[320px]">
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

export default FireMap;
