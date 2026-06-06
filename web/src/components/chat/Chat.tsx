import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Workspace } from "../../lib/types";
import { agentReply, SUGGESTIONS } from "../../lib/mock";
import { transcribeVoice } from "../../lib/api";
import { cx } from "../ui/primitives";
import Composer from "./Composer";
import ResultCard from "./ResultCard";
import { RecordingBar, SpeakingOrb } from "./VoiceMode";
import FireMap, { type FireMapHandle, type FireMsg } from "../fire/FireMap";

let idc = 0;
const nid = () => `m${++idc}`;

export default function Chat({
  ws,
  voiceActive,
  onToggleVoice,
  onRegisterAsk,
}: {
  ws: Workspace;
  voiceActive: boolean;
  onToggleVoice: () => void;
  onRegisterAsk?: (fn: (text: string) => void) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<string[]>(["London Bridge Hospital"]);
  const [activeFolder, setActiveFolder] = useState("London Bridge Hospital");
  const [fireAnalysing, setFireAnalysing] = useState(false);
  const [fireBusy, setFireBusy] = useState(false);
  const [fireMsgs, setFireMsgs] = useState<FireMsg[]>([]);
  const fireRef = useRef<FireMapHandle>(null);
  const fireScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fireScrollRef.current?.scrollTo({ top: fireScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [fireMsgs]);

  useEffect(() => {
    if (ws.id === "fire") onRegisterAsk?.((t) => fireRef.current?.ask(t));
  }, [ws.id, onRegisterAsk]);

  const [fireAudioPlaying, setFireAudioPlaying] = useState(false);
  const handleVoiceText = useCallback((text: string) => {
    fireRef.current?.ask(text, true); // already transcribed live; just ask
  }, []);
  const handleVoiceExit = useCallback(() => {
    fireRef.current?.stopAudio();
    onToggleVoice();
  }, [onToggleVoice]);
  const scrollRef = useRef<HTMLDivElement>(null);

  function addFolder() {
    const name = `New workspace ${folders.length}`;
    setFolders((f) => [...f, name]);
    setActiveFolder(name);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function send(text: string) {
    if (!text.trim() || busy) return;
    setInput("");
    setBusy(true);
    const userMsg: ChatMessage = { id: nid(), role: "user", text };
    const agentMsg: ChatMessage = { id: nid(), role: "agent", text: "", pending: true };
    setMessages((m) => [...m, userMsg, agentMsg]);

    const { text: replyText, result } = agentReply(text);
    window.setTimeout(() => {
      let i = 0;
      const timer = window.setInterval(() => {
        i += 2;
        setMessages((m) =>
          m.map((msg) => (msg.id === agentMsg.id ? { ...msg, text: replyText.slice(0, i) } : msg))
        );
        if (i >= replyText.length) {
          window.clearInterval(timer);
          setMessages((m) =>
            m.map((msg) =>
              msg.id === agentMsg.id ? { ...msg, text: replyText, result, pending: false } : msg
            )
          );
          setBusy(false);
        }
      }, 12);
    }, 600);
  }

  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSubmit={() => send(input)}
      ws={ws}
      onToggleVoice={onToggleVoice}
      voiceActive={voiceActive}
      busy={busy}
      autoFocus
      folders={folders}
      activeFolder={activeFolder}
      onSelectFolder={setActiveFolder}
      onAddFolder={addFolder}
    />
  );

  // ---- voice mode (PREVIEW for ElevenLabs) — fire has the real one below ----
  if (voiceActive && ws.id !== "fire") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center px-4">
          <SpeakingOrb accent={ws.accent} />
        </div>
        <div className="px-4 pb-4">
          <div className="mx-auto w-full max-w-3xl">
            <RecordingBar accent={ws.accent} onStop={onToggleVoice} />
          </div>
        </div>
      </div>
    );
  }

  // ---- fire workspace: full-bleed twin; composer floats over the map ----
  // (composer component itself untouched, per migration plan)
  if (ws.id === "fire") {
    // transcript renders INSIDE the bar (Composer header slot): one element, growing
    const transcript =
      fireMsgs.length > 0 ? (
        <div className="relative">
          <button
            onClick={() => fireRef.current?.clearChat()}
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md text-[13px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
            title="Clear conversation"
          >
            ✕
          </button>
          <div ref={fireScrollRef} className="max-h-[38vh] overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-5">
              {fireMsgs.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[80%] rounded-3xl rounded-br-lg bg-neutral-100 px-4 py-2.5 text-[15px] leading-6 text-neutral-900">
                      {m.text}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="flex gap-3">
                    <div
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-[13px]"
                      style={{ color: ws.accent }}
                    >
                      ✦
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5 text-[15px] leading-7 text-neutral-800">
                      {m.pending && m.text === "" ? (
                        <span className="text-neutral-400">Thinking…</span>
                      ) : (
                        <span className={cx(m.pending && "caret")}>{m.text}</span>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      ) : undefined;

    const fireComposer = (
      <Composer
        value={input}
        onChange={setInput}
        onSubmit={() => {
          const t = input.trim();
          if (!t || fireBusy) return;
          setInput("");
          fireRef.current?.ask(t);
        }}
        ws={ws}
        onToggleVoice={onToggleVoice}
        voiceActive={voiceActive}
        busy={fireBusy}
        autoFocus
        folders={folders}
        activeFolder={activeFolder}
        onSelectFolder={setActiveFolder}
        onAddFolder={addFolder}
        header={transcript}
        hideAttach
        hideFolder
        staticModel
      />
    );
    return (
      <div className="relative h-full w-full">
        <FireMap
          ref={fireRef}
          accent={ws.accent}
          onAnalysingChange={setFireAnalysing}
          onBusyChange={setFireBusy}
          onMessagesChange={setFireMsgs}
          onAudioStateChange={setFireAudioPlaying}
        />
        {/* loading screen while the agent thinks/speaks in voice mode */}
        {voiceActive && (fireBusy || fireAudioPlaying) && (
          <div className="pointer-events-none absolute inset-0 z-[1080] flex items-center justify-center">
            <div className="animate-fade-up flex flex-col items-center gap-3 rounded-2xl border border-neutral-200 bg-white/90 px-9 py-6 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm">
              <div
                className="h-9 w-9 animate-spin rounded-full border-[2.5px] border-neutral-200"
                style={{ borderTopColor: ws.accent }}
              />
              <ThinkingStatus speaking={fireAudioPlaying} />
            </div>
          </div>
        )}
        <div
          className={
            "pointer-events-none absolute bottom-4 left-0 z-[1100] px-4 transition-[right] duration-300 " +
            (fireAnalysing ? "right-[336px]" : "right-0")
          }
        >
          <div className="pointer-events-auto mx-auto w-full max-w-3xl">
            {voiceActive ? (
              <FireLiveVoice
                accent={ws.accent}
                busy={fireBusy}
                audioPlaying={fireAudioPlaying}
                onSubmitText={handleVoiceText}
                onExit={handleVoiceExit}
              />
            ) : (
              fireComposer
            )}
          </div>
        </div>
      </div>
    );
  }

  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* content area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full items-center justify-center px-4">
            <div className="w-full max-w-3xl">
              <h1 className="mb-7 text-center text-[30px] font-medium tracking-tight text-neutral-900">
                What should we simulate in {ws.short}?
              </h1>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-[13.5px] text-neutral-700 transition-all duration-200 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 hover:shadow-[0_2px_8px_rgba(0,0,0,0.05)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8">
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} ws={ws} />
            ))}
          </div>
        )}
      </div>

      {/* composer pinned to bottom */}
      <div className="px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl">{composer}</div>
      </div>
    </div>
  );
}

function ThinkingStatus({ speaking }: { speaking: boolean }) {
  const phrases = [
    "Consulting the twin…",
    "Re-running 132,860 incidents…",
    "Weighing cover moves…",
    "Reading the wards…",
  ];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI((x) => x + 1), 1700);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="text-[13px] text-neutral-500">
      {speaking ? "Speaking…" : phrases[i % phrases.length]}
    </div>
  );
}

/** Live-narration voice: transcribes WHILE you speak, YOU press Enter to send.
 *  Capture is raw PCM -> complete WAV per upload (MediaRecorder partials are NOT
 *  valid files — ElevenLabs rejects them as corrupted; WAV never can be). */
type VoicePhase = "live" | "thinking" | "speaking";

const TARGET_RATE = 16_000;

function buildWav(buffers: Float32Array[], srcRate: number): Blob {
  let total = 0;
  for (const b of buffers) total += b.length;
  const joined = new Float32Array(total);
  let off = 0;
  for (const b of buffers) {
    joined.set(b, off);
    off += b.length;
  }
  // linear-interpolation downsample to 16 kHz mono
  const ratio = srcRate / TARGET_RATE;
  const outLen = Math.floor(joined.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(joined.length - 1, i0 + 1);
    const frac = pos - i0;
    const s = joined[i0] * (1 - frac) + joined[i1] * frac;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);          // PCM
  v.setUint16(22, 1, true);          // mono
  v.setUint32(24, TARGET_RATE, true);
  v.setUint32(28, TARGET_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  return new Blob([header, pcm.buffer], { type: "audio/wav" });
}

function FireLiveVoice({
  busy,
  audioPlaying,
  onSubmitText,
  onExit,
}: {
  accent: string;
  busy: boolean;
  audioPlaying: boolean;
  onSubmitText: (text: string) => void;
  onExit: () => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>("live");
  const [caption, setCaption] = useState("");
  const [err, setErr] = useState(false);
  const phaseRef = useRef<VoicePhase>("live");
  phaseRef.current = phase;
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const sampleCountRef = useRef(0);
  const sentCountRef = useRef(0);
  const rateRef = useRef(48_000);
  const inflightRef = useRef(false);
  const captionRef = useRef("");
  const tickRef = useRef<number | null>(null);
  const submitRef = useRef(onSubmitText);
  submitRef.current = onSubmitText;
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  const stopTick = () => {
    if (tickRef.current) window.clearInterval(tickRef.current);
    tickRef.current = null;
  };

  const liveTranscribe = async () => {
    // need ~0.6s of NEW audio before re-transcribing the take
    if (inflightRef.current || sampleCountRef.current - sentCountRef.current < rateRef.current * 0.6) return;
    inflightRef.current = true;
    sentCountRef.current = sampleCountRef.current;
    try {
      if (sampleCountRef.current > rateRef.current * 0.5) {
        const blob = buildWav(samplesRef.current, rateRef.current);
        const { text } = await transcribeVoice(blob);
        if (phaseRef.current === "live" && text.trim()) {
          captionRef.current = text;
          setCaption(text);
        }
      }
    } catch {
      /* next tick retries */
    } finally {
      inflightRef.current = false;
    }
  };

  const startLive = async () => {
    try {
      samplesRef.current = [];
      sampleCountRef.current = 0;
      sentCountRef.current = 0;
      captionRef.current = "";
      setCaption("");
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;
      rateRef.current = ctx.sampleRate;
      await ctx.resume();
      const src = ctx.createMediaStreamSource(streamRef.current);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      procRef.current = proc;
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        samplesRef.current.push(new Float32Array(d));
        sampleCountRef.current += d.length;
        // memory cap ~90s of take
        if (sampleCountRef.current > rateRef.current * 90) {
          const drop = samplesRef.current.shift();
          if (drop) sampleCountRef.current -= drop.length;
        }
      };
      const mute = ctx.createGain();
      mute.gain.value = 0; // keeps the node pulling samples without feedback
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      setPhase("live");
      tickRef.current = window.setInterval(liveTranscribe, 1300);
    } catch {
      setErr(true);
    }
  };

  const sawAudioRef = useRef(false);
  const busySeenRef = useRef(false);
  const holdStartRef = useRef(performance.now());
  const [holdTick, forceTick] = useState(0);

  const releaseMic = () => {
    stopTick();
    try {
      procRef.current?.disconnect();
    } catch {
      /* already disconnected */
    }
    procRef.current = null;
    // HARD off: release the stream so the browser's recording indicator dies too
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  };

  const send = async () => {
    if (phaseRef.current !== "live") return;
    sawAudioRef.current = false; // fresh turn: we don't yet know if audio is coming
    busySeenRef.current = false; // ...nor has the ask registered yet
    setPhase("thinking");
    const rate = rateRef.current;
    const takeSamples = samplesRef.current;
    const takeCount = sampleCountRef.current;
    releaseMic(); // mic is DEAD from this point until the agent has fully answered
    let text = captionRef.current;
    if (takeCount > rate * 0.4) {
      try {
        const blob = buildWav(takeSamples, rate); // complete valid WAV, always
        const r = await transcribeVoice(blob);
        if (r.text.trim()) text = r.text;
      } catch {
        /* fall back to live caption */
      }
    }
    samplesRef.current = [];
    sampleCountRef.current = 0;
    if (text.trim()) submitRef.current(text.trim());
    else {
      setPhase("live");
      void startLive();
    }
  };

  // keyboard: Enter = send, Esc = exit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && phaseRef.current === "live") {
        e.preventDefault();
        void send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        exitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // boot + teardown
  useEffect(() => {
    void startLive();
    return () => releaseMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // LATCHED turn machine: mic re-arms ONLY after the ask was seen busy AND
  // finished AND the audio queue (if any) fully drained, plus a tail.
  useEffect(() => {
    if (audioPlaying) sawAudioRef.current = true;
    if (busy) busySeenRef.current = true;
    if (phase === "live") {
      // straggler audio arrived after we re-armed: kill the take, let it speak
      if (audioPlaying) {
        releaseMic();
        setPhase("speaking");
      }
      return;
    }
    if (audioPlaying) {
      setPhase("speaking");
      return;
    }
    if (busy) {
      setPhase("thinking");
      return;
    }
    // idle. Three cases:
    //  1) ask not yet registered (transcribe finalizing) -> hold, re-check via timer
    //  2) ask done, audio already played -> short 900ms tail
    //  3) ask done, no audio (yet) -> wait up to 4s for TTS, then re-arm anyway
    const grace = !busySeenRef.current ? 1200 : sawAudioRef.current ? 900 : 4000;
    const t = window.setTimeout(() => {
      if (phaseRef.current === "live") return;
      if (!busySeenRef.current) {
        // ask hasn't registered yet (transcribe finalizing / slow start):
        // hold up to 8s total, re-arming this check each cycle
        if (performance.now() - holdStartRef.current > 8000) void startLive();
        else forceTick((x) => x + 1); // re-run the effect -> fresh hold timer
        return;
      }
      void startLive();
    }, grace);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, audioPlaying, phase, holdTick]);

  useEffect(() => {
    if (phase === "thinking") holdStartRef.current = performance.now();
  }, [phase]);

  if (err) {
    return (
      <div className="flex items-center justify-between rounded-[26px] border border-neutral-200 bg-white px-4 py-3 text-[13.5px] text-neutral-500 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        Microphone unavailable — check browser permissions.
        <button onClick={onExit} className="rounded-lg px-2 py-1 text-neutral-600 hover:bg-neutral-100">
          back
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-[26px] border border-neutral-200/80 bg-neutral-100/70 p-1.5">
      <div className="rounded-[20px] border border-neutral-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="min-h-[44px] px-4 pb-1 pt-3 text-[15px] leading-6 text-neutral-900">
          {phase === "live" ? (
            caption ? (
              <span>
                {caption}
                <span className="caret" />
              </span>
            ) : (
              <span className="text-neutral-400">
                Listening — speak, then press <b>Enter ↵</b> to send
                <span className="caret" />
              </span>
            )
          ) : (
            <span className="text-neutral-400">{phase === "speaking" ? "Speaking…" : "Thinking…"}</span>
          )}
        </div>
        <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
          <div className="flex items-center gap-2 pl-1.5">
            <span className="relative flex h-2.5 w-2.5">
              <span
                className={cx(
                  "absolute inline-flex h-full w-full rounded-full opacity-60",
                  phase === "live" ? "animate-ping bg-red-500" : "bg-neutral-300"
                )}
              />
              <span
                className={cx(
                  "relative inline-flex h-2.5 w-2.5 rounded-full",
                  phase === "live" ? "bg-red-500" : "bg-neutral-300"
                )}
              />
            </span>
            <span className="text-[12px] text-neutral-400">
              {phase === "live" ? "recording · Enter ↵ send · Esc exit" : "mic paused"}
            </span>
          </div>
          <button
            onClick={onExit}
            title="End voice (Esc)"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700"
          >
            <span className="h-3 w-3 rounded-[3px] bg-white" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ msg, ws }: { msg: ChatMessage; ws: Workspace }) {
  if (msg.role === "user") {
    return (
      <div className="flex animate-fade-up justify-end">
        <div className="max-w-[80%] rounded-3xl rounded-br-lg bg-neutral-100 px-4 py-2.5 text-[15px] leading-6 text-neutral-900">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex animate-fade-up gap-3">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-[13px]"
        style={{ color: ws.accent }}
      >
        ✦
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-[15px] leading-7 text-neutral-800">
          {msg.pending && msg.text === "" ? (
            <span className="text-neutral-400">Thinking…</span>
          ) : (
            <span className={cx(msg.pending && "caret")}>{msg.text}</span>
          )}
        </div>
        {msg.result && <ResultCard r={msg.result} />}
      </div>
    </div>
  );
}
