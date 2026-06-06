import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Workspace } from "../../lib/types";
import { agentReply, SUGGESTIONS } from "../../lib/mock";
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
}: {
  ws: Workspace;
  voiceActive: boolean;
  onToggleVoice: () => void;
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

  // ---- voice mode (PREVIEW for ElevenLabs) ----
  if (voiceActive) {
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
            {/* the bar extends into a chat window once a conversation exists */}
            {fireMsgs.length > 0 && (
              <div className="relative mb-2 rounded-2xl border border-neutral-200 bg-white/95 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-sm">
                <button
                  onClick={() => fireRef.current?.clearChat()}
                  className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md text-[13px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
                  title="Clear conversation"
                >
                  ✕
                </button>
                <div ref={fireScrollRef} className="max-h-[40vh] overflow-y-auto px-4 py-4">
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
            )}
            {fireComposer}
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
