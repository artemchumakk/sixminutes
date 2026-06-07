import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Workspace } from "../../lib/types";
import { agentReply, SUGGESTIONS } from "../../lib/mock";
import { transcribeVoice } from "../../lib/api";
import { cx } from "../ui/primitives";
import Composer from "./Composer";
import ResultCard from "./ResultCard";
import { RecordingBar, SpeakingOrb } from "./VoiceMode";
import FireMap, { type FireMapHandle, type FireMsg } from "../fire/FireMap";
import PoliceMap, { type PoliceMapHandle, type PoliceMsg } from "../police/PoliceMap";
import { policeTtsReady, policeTtsUrl } from "../../lib/policeApi";

let idc = 0;
const nid = () => `m${++idc}`;

// minimal shape of the (non-standard, vendor-prefixed) Web Speech API we touch
interface SpeechRecResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecResultList {
  length: number;
  [i: number]: SpeechRecResult;
}
interface SpeechRecEvent {
  results: SpeechRecResultList;
}
interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: (e: SpeechRecEvent) => void;
  onerror: () => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

// ── police browser text-to-speech ───────────────────────────────────────────
// Fire speaks via server-side ElevenLabs (needs API keys we don't have); the police
// side uses the browser's SpeechSynthesis. Two things stop it sounding asthmatic:
// (1) speak sentence-by-sentence — Chrome truncates/"gasps" on one long utterance;
// (2) prefer a real, natural voice over the default robotic one.
const VOICE_PREFS = [
  "Google UK English Female",
  "Google UK English Male",
  "Microsoft Libby Online (Natural) - English (United Kingdom)",
  "Microsoft Sonia Online (Natural) - English (United Kingdom)",
  "Serena (Premium)",
  "Serena (Enhanced)",
  "Samantha",
  "Daniel (Enhanced)",
  "Daniel",
  "Google US English",
];

function pickVoice(): SpeechSynthesisVoice | null {
  const synth = window.speechSynthesis;
  if (!synth) return null;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  for (const name of VOICE_PREFS) {
    const v = voices.find((x) => x.name === name);
    if (v) return v;
  }
  return (
    voices.find((v) => /^en-GB/i.test(v.lang) && !/compact/i.test(v.name)) ||
    voices.find((v) => /^en/i.test(v.lang) && !/compact/i.test(v.name)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    null
  );
}

// strip any residual data notation so the voice never reads "slash" or "p90" aloud
function speechClean(text: string): string {
  return text
    .replace(/≈/g, "about ")
    .replace(/→/g, " to ")
    .replace(/×/g, " times ")
    .replace(/%/g, " percent")
    .replace(/\/mo\b/gi, " a month")
    .replace(/\/yr\b/gi, " a year")
    .replace(/\bp90\b/gi, "the slowest calls")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function speakBrowser(text: string) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  try {
    synth.cancel();
    const voice = pickVoice();
    const clean = speechClean(text);
    const chunks = clean.match(/[^.!?]+[.!?]*/g) ?? [clean];
    for (const c of chunks) {
      const s = c.trim();
      if (!s) continue;
      const u = new SpeechSynthesisUtterance(s);
      u.lang = "en-GB";
      if (voice) u.voice = voice;
      u.rate = 1.0;
      u.pitch = 1.0;
      synth.speak(u);
    }
  } catch {
    /* no speech synthesis available */
  }
}

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

  // ---- police: Watch Commander chat (text + browser voice), drives PoliceMap ----
  const policeRef = useRef<PoliceMapHandle>(null);
  const [policeMsgs, setPoliceMsgs] = useState<PoliceMsg[]>([]);
  const [policeBusy, setPoliceBusy] = useState(false);
  const [policeListening, setPoliceListening] = useState(false);
  const policeScrollRef = useRef<HTMLDivElement>(null);
  const recogRef = useRef<{ stop: () => void } | null>(null);
  const pVoiceMode = useRef(false);
  const lastSpoke = useRef(-1);
  const policeAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsReadyRef = useRef(false); // server-side ElevenLabs available (a key is set)?

  // barge-in: stop any ElevenLabs playback AND any browser speech in flight
  const stopPoliceAudio = useCallback(() => {
    const a = policeAudioRef.current;
    if (a) {
      a.onended = null;
      a.onerror = null;
      try {
        a.pause();
      } catch {
        /* already stopped */
      }
      policeAudioRef.current = null;
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* no speech synthesis */
    }
  }, []);

  // speak an answer: prefer ElevenLabs (identical voice/model to fire) when a key is
  // configured; otherwise — or on any playback failure — fall back to the browser voice.
  const speakPolice = useCallback(
    (text: string) => {
      stopPoliceAudio();
      if (ttsReadyRef.current) {
        try {
          const a = new Audio(policeTtsUrl(text));
          policeAudioRef.current = a;
          const fallback = () => {
            policeAudioRef.current = null;
            speakBrowser(text);
          };
          a.onerror = fallback;
          a.play().catch(fallback);
          return;
        } catch {
          /* fall through to the browser voice */
        }
      }
      speakBrowser(text);
    },
    [stopPoliceAudio]
  );

  useEffect(() => {
    fireScrollRef.current?.scrollTo({ top: fireScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [fireMsgs]);

  useEffect(() => {
    policeScrollRef.current?.scrollTo({ top: policeScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [policeMsgs]);

  useEffect(() => {
    if (ws.id === "fire") onRegisterAsk?.((t) => fireRef.current?.ask(t));
    if (ws.id === "police") onRegisterAsk?.((t) => policeRef.current?.ask(t));
  }, [ws.id, onRegisterAsk]);

  // warm the browser's voice list so the first answer already has a natural voice
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.getVoices();
    const onChange = () => synth.getVoices();
    synth.addEventListener?.("voiceschanged", onChange);
    return () => synth.removeEventListener?.("voiceschanged", onChange);
  }, []);

  // probe once whether the backend has an ElevenLabs key — decides MP3 vs browser voice
  useEffect(() => {
    let alive = true;
    policeTtsReady().then((ok) => {
      if (alive) ttsReadyRef.current = ok;
    });
    return () => {
      alive = false;
    };
  }, []);

  // speak the commander's answers when the dispatcher used voice (ElevenLabs if keyed,
  // else browser voice)
  useEffect(() => {
    if (ws.id !== "police" || !pVoiceMode.current) return;
    const last = policeMsgs[policeMsgs.length - 1];
    if (last && last.role === "agent" && !last.pending && last.text && last.id !== lastSpoke.current) {
      lastSpoke.current = last.id;
      speakPolice(last.text);
    }
  }, [policeMsgs, ws.id, speakPolice]);

  // mic → browser SpeechRecognition (the ElevenLabs slot; works key-free in Chrome).
  // SpeechRecognition isn't in the standard TS DOM lib, so we shape it locally.
  const startPoliceVoice = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return; // no Web Speech in this browser → mic is a graceful no-op
    if (policeListening) {
      try {
        recogRef.current?.stop();
      } catch {
        /* already stopped */
      }
      stopPoliceAudio(); // barge-in: silence any answer still playing
      pVoiceMode.current = false; // explicit voice-off → stop auto-speaking answers
      setPoliceListening(false);
      return;
    }
    const r = new SR();
    r.lang = "en-GB";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onresult = (e: SpeechRecEvent) => {
      let txt = "";
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(txt);
      if (e.results[e.results.length - 1].isFinal) {
        const t = txt.trim();
        try {
          r.stop();
        } catch {
          /* already stopped */
        }
        setPoliceListening(false);
        if (t) {
          setInput("");
          policeRef.current?.ask(t);
        }
      }
    };
    r.onerror = () => setPoliceListening(false);
    r.onend = () => setPoliceListening(false);
    recogRef.current = r;
    pVoiceMode.current = true;
    try {
      r.start();
      setPoliceListening(true);
    } catch {
      setPoliceListening(false);
    }
  }, [policeListening, stopPoliceAudio]);

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

  // ---- police workspace: full-bleed twin + Watch Commander chat bar (Tier B) ----
  // map-first like fire; the chat is answered by our own police endpoints (forecast +
  // relocation), and every question drives this same map.
  if (ws.id === "police") {
    const transcript =
      policeMsgs.length > 0 ? (
        <div className="relative">
          <button
            onClick={() => policeRef.current?.clearChat()}
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md text-[13px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
            title="Clear conversation"
          >
            ✕
          </button>
          <div ref={policeScrollRef} className="max-h-[34vh] overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-5">
              {policeMsgs.map((m) =>
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
                        <span className="text-neutral-400">Reading the twin…</span>
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

    const policeComposer = (
      <Composer
        value={input}
        onChange={setInput}
        onSubmit={() => {
          const t = input.trim();
          if (!t || policeBusy) return;
          setInput("");
          policeRef.current?.ask(t);
        }}
        ws={ws}
        onToggleVoice={startPoliceVoice}
        voiceActive={policeListening}
        busy={policeBusy}
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
        <PoliceMap
          ref={policeRef}
          accent={ws.accent}
          onMessagesChange={setPoliceMsgs}
          onBusyChange={setPoliceBusy}
        />
        {/* chat bar floats over the map, left of the 360px analyst panel */}
        <div className="pointer-events-none absolute bottom-4 left-0 right-[372px] z-[1100] px-4">
          <div className="pointer-events-auto mx-auto w-full max-w-2xl">{policeComposer}</div>
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

/** Live-narration voice: transcribes WHILE you speak (chunked ElevenLabs every
 *  ~1.3s), YOU press Enter to send. Esc or ■ exits. After the agent answers,
 *  listening resumes automatically. No VAD, no surprises. */
type VoicePhase = "live" | "thinking" | "speaking";

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
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const inflightRef = useRef(false);
  const lastLenRef = useRef(0);
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
    if (inflightRef.current || chunksRef.current.length === lastLenRef.current) return;
    inflightRef.current = true;
    lastLenRef.current = chunksRef.current.length;
    try {
      const blob = new Blob(chunksRef.current, { type: recRef.current?.mimeType || "audio/webm" });
      if (blob.size > 2000) {
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
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      }
      chunksRef.current = [];
      lastLenRef.current = 0;
      captionRef.current = "";
      setCaption("");
      setPhase("live");
      const rec = new MediaRecorder(streamRef.current);
      recRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.start(900); // chunk every 0.9s -> near-live captions
      tickRef.current = window.setInterval(liveTranscribe, 1300);
    } catch {
      setErr(true);
    }
  };

  const sawAudioRef = useRef(false);

  const send = async () => {
    if (phaseRef.current !== "live") return;
    stopTick();
    sawAudioRef.current = false; // fresh turn: we don't yet know if audio is coming
    const rec = recRef.current;
    setPhase("thinking");
    const finalize = async () => {
      try {
        const blob = new Blob(chunksRef.current, { type: rec?.mimeType || "audio/webm" });
        let text = captionRef.current;
        if (blob.size > 2000) {
          try {
            const r = await transcribeVoice(blob); // one last full pass catches trailing words
            if (r.text.trim()) text = r.text;
          } catch {
            /* fall back to live caption */
          }
        }
        if (text.trim()) submitRef.current(text.trim());
        else {
          setPhase("live");
          void startLive();
        }
      } catch {
        setPhase("live");
        void startLive();
      }
    };
    if (rec && rec.state === "recording") {
      rec.onstop = () => void finalize();
      rec.stop();
    } else void finalize();
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
    return () => {
      stopTick();
      try {
        if (recRef.current?.state === "recording") {
          recRef.current.onstop = null;
          recRef.current.stop();
        }
      } catch {
        /* already stopped */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // resume listening once the agent has TRULY finished talking
  useEffect(() => {
    if (audioPlaying) sawAudioRef.current = true;
    if (phase === "live") {
      // straggler audio arrived after we resumed: pause the take, let it speak
      if (audioPlaying) {
        stopTick();
        try {
          if (recRef.current?.state === "recording") {
            recRef.current.onstop = null;
            recRef.current.stop();
          }
        } catch {
          /* already stopped */
        }
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
    // queue drained & ask resolved. If audio played this turn, short tail;
    // if none arrived YET, wait long enough for the TTS to land (then give up).
    const grace = sawAudioRef.current ? 900 : 4000;
    const t = window.setTimeout(() => {
      if (phaseRef.current !== "live") void startLive();
    }, grace);
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
