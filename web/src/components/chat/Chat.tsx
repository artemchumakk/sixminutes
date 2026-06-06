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
  const handleVoiceUtterance = useCallback(async (blob: Blob) => {
    // hands-free loop: we STAY in voice mode; the loop resumes listening after the answer
    try {
      const { text } = await transcribeVoice(blob);
      if (text.trim()) fireRef.current?.ask(text, true);
      else
        fireRef.current?.note(
          "🎙 I heard only silence — check which microphone Chrome is using (🎙 icon in the address bar)."
        );
    } catch {
      fireRef.current?.note("🎙 Transcription failed — is the engine running on :8095?");
    }
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
        <div
          className={
            "pointer-events-none absolute bottom-4 left-0 z-[1100] px-4 transition-[right] duration-300 " +
            (fireAnalysing ? "right-[336px]" : "right-0")
          }
        >
          <div className="pointer-events-auto mx-auto w-full max-w-3xl">
            {voiceActive ? (
              <FireVoiceLoop
                accent={ws.accent}
                busy={fireBusy}
                audioPlaying={fireAudioPlaying}
                onUtterance={handleVoiceUtterance}
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

/** Hands-free conversational voice: VAD listens -> silence sends -> agent speaks ->
 *  listening resumes. Mic is deaf while the agent talks (no self-hearing).
 *  Wears ynkvch's RecordingBar while listening. ■ exits the loop. */
type VoicePhase = "listening" | "thinking" | "speaking";

function FireVoiceLoop({
  accent,
  busy,
  audioPlaying,
  onUtterance,
  onExit,
}: {
  accent: string;
  busy: boolean;
  audioPlaying: boolean;
  onUtterance: (blob: Blob) => void;
  onExit: () => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>("listening");
  const [err, setErr] = useState(false);
  const phaseRef = useRef<VoicePhase>("listening");
  phaseRef.current = phase;
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const meterRef = useRef<number | null>(null);
  const utterRef = useRef(onUtterance);
  utterRef.current = onUtterance;

  const stopMeter = () => {
    if (meterRef.current) window.clearInterval(meterRef.current);
    meterRef.current = null;
  };

  const startListening = async () => {
    try {
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = new Ctx();
        const src = ctxRef.current.createMediaStreamSource(streamRef.current);
        analyserRef.current = ctxRef.current.createAnalyser();
        analyserRef.current.fftSize = 1024;
        src.connect(analyserRef.current);
      }
      await ctxRef.current?.resume();
      setPhase("listening");
      const chunks: BlobPart[] = [];
      const rec = new MediaRecorder(streamRef.current);
      recRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        stopMeter();
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const spoke = (rec as MediaRecorder & { _spoke?: boolean })._spoke;
        if (spoke && blob.size > 1500) {
          setPhase("thinking");
          utterRef.current(blob);
        } else if (phaseRef.current === "listening") {
          void startListening(); // heard nothing real -> keep listening
        }
      };
      rec.start();

      // --- VAD: calibrate noise floor, then speech-end on ~1.1s of quiet ---
      const buf = new Uint8Array(analyserRef.current!.fftSize);
      const t0 = performance.now();
      let floor = 4;
      let speech = false;
      let lastLoud = performance.now();
      meterRef.current = window.setInterval(() => {
        analyserRef.current!.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = buf[i] - 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (now - t0 < 350) {
          floor = Math.max(floor, rms * 1.4);
          return;
        }
        const thr = Math.max(6, floor * 2.0);
        if (rms > thr) {
          (rec as MediaRecorder & { _spoke?: boolean })._spoke = true;
          speech = true;
          lastLoud = now;
        }
        const quietFor = now - lastLoud;
        if ((speech && quietFor > 1100) || now - t0 > 25_000) {
          if (rec.state === "recording") rec.stop();
        }
      }, 90);
    } catch {
      setErr(true);
    }
  };

  // boot once; teardown on exit
  useEffect(() => {
    void startListening();
    return () => {
      stopMeter();
      try {
        if (recRef.current?.state === "recording") {
          recRef.current.onstop = null;
          recRef.current.stop();
        }
      } catch {
        /* already stopped */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void ctxRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // after the agent finishes (no busy, no audio) -> resume listening
  useEffect(() => {
    if (phase === "listening") return;
    if (audioPlaying) {
      setPhase("speaking");
      return;
    }
    if (busy) {
      setPhase("thinking");
      return;
    }
    const t = window.setTimeout(() => {
      if (phaseRef.current !== "listening") void startListening();
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, audioPlaying, phase]);

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

  if (phase === "listening") {
    return <RecordingBar accent={accent} onStop={onExit} />;
  }
  return (
    <div className="flex items-center gap-3 rounded-[26px] border border-neutral-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex-1 text-[13.5px] text-neutral-500">
        {phase === "speaking" ? "Speaking…" : "Thinking…"}
        <span className="caret" />
      </div>
      <button
        onClick={onExit}
        title="End voice"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700"
      >
        <span className="h-3 w-3 rounded-[3px] bg-white" />
      </button>
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
