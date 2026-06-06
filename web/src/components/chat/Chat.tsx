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

  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const handleVoiceSend = useCallback(
    async (blob: Blob) => {
      onToggleVoice(); // back to the composer immediately; the thread takes over
      try {
        const { text } = await transcribeVoice(blob);
        if (text.trim()) fireRef.current?.ask(text, true);
        else setVoiceErr("Didn't catch that — try again.");
      } catch {
        setVoiceErr("Transcription failed — is the engine running?");
      }
      window.setTimeout(() => setVoiceErr(null), 4000);
    },
    [onToggleVoice]
  );
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
        />
        <div
          className={
            "pointer-events-none absolute bottom-4 left-0 z-[1100] px-4 transition-[right] duration-300 " +
            (fireAnalysing ? "right-[336px]" : "right-0")
          }
        >
          <div className="pointer-events-auto mx-auto w-full max-w-3xl">
            {voiceErr && (
              <div className="mb-2 w-fit rounded-full border border-neutral-200 bg-white/95 px-3.5 py-1.5 text-[12.5px] text-neutral-500 shadow-sm">
                {voiceErr}
              </div>
            )}
            {voiceActive ? (
              <FireVoiceBar accent={ws.accent} onSend={handleVoiceSend} onCancel={onToggleVoice} />
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

/** Real mic capture wearing ynkvch's RecordingBar. Stop = send. */
function FireVoiceBar({
  accent,
  onSend,
  onCancel,
}: {
  accent: string;
  onSend: (blob: Blob) => void;
  onCancel: () => void;
}) {
  const recRef = useRef<MediaRecorder | null>(null);
  const sendRef = useRef(onSend);
  const cancelRef = useRef(onCancel);
  sendRef.current = onSend;
  cancelRef.current = onCancel;
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    const chunks: BlobPart[] = [];
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (!alive) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const rec = new MediaRecorder(s);
        recRef.current = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        rec.onstop = () => {
          s.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          if (blob.size > 800) sendRef.current(blob);
          else cancelRef.current();
        };
        rec.start();
      })
      .catch(() => setErr(true));
    return () => {
      alive = false;
      try {
        if (recRef.current?.state === "recording") recRef.current.stop();
        stream?.getTracks().forEach((t) => t.stop());
      } catch {
        /* already stopped */
      }
    };
  }, []);

  if (err) {
    return (
      <div className="flex items-center justify-between rounded-[26px] border border-neutral-200 bg-white px-4 py-3 text-[13.5px] text-neutral-500 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        Microphone unavailable — check browser permissions.
        <button onClick={onCancel} className="rounded-lg px-2 py-1 text-neutral-600 hover:bg-neutral-100">
          back
        </button>
      </div>
    );
  }
  return <RecordingBar accent={accent} onStop={() => recRef.current?.stop()} />;
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
