import { useRef, useState } from "react";
import type { Workspace } from "../lib/types";
import { ChevronDown } from "./ui/icons";
import Sidebar from "./Sidebar";
import Chat from "./chat/Chat";
import SearchView from "./SearchView";

type View = "chat" | "search";

export default function CodexApp({ ws, onExit }: { ws: Workspace; onExit: () => void }) {
  const [voice, setVoice] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [view, setView] = useState<View>("chat");
  const [menuOpen, setMenuOpen] = useState(false);
  const askFn = useRef<((text: string) => void) | null>(null);

  function newChat() {
    setChatKey((k) => k + 1);
    setView("chat");
    setVoice(false);
  }

  function startVoice() {
    setView("chat");
    setVoice(true);
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-white" style={{ ["--accent" as string]: ws.accent }}>
      <Sidebar
        ws={ws}
        onNewChat={newChat}
        onSearch={() => setView("search")}
        onVoice={startVoice}
        onExit={onExit}
        onQuickAsk={(t) => {
          setView("chat");
          askFn.current?.(t);
        }}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* top bar — hidden entirely in the fire workspace (no account chrome on the canvas) */}
        {!(ws.id === "fire" && view === "chat") && (
        <header className="flex h-14 shrink-0 items-center justify-end px-4">
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-neutral-600 hover:bg-neutral-100"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-neutral-900 text-[10px] text-white">
                D
              </span>
              Dispatcher
              <ChevronDown size={14} className="text-neutral-400" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1.5 w-44 rounded-xl border border-neutral-200 bg-white p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
                  {ws.id !== "fire" && (
                    <>
                      <MenuItem onClick={() => setMenuOpen(false)}>Account</MenuItem>
                      <MenuItem onClick={() => setMenuOpen(false)}>Settings</MenuItem>
                      <MenuItem onClick={() => setMenuOpen(false)}>Subscription</MenuItem>
                      <div className="my-1 h-px bg-neutral-100" />
                    </>
                  )}
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      onExit();
                    }}
                    danger
                  >
                    {ws.id === "fire" ? "Exit workspace" : "Log out"}
                  </MenuItem>
                </div>
              </>
            )}
          </div>
        </header>
        )}

        {/* body */}
        <main className="min-h-0 flex-1">
          {view === "search" ? (
            <SearchView />
          ) : (
            <Chat
              key={chatKey}
              ws={ws}
              voiceActive={voice}
              onToggleVoice={() => setVoice((v) => !v)}
              onRegisterAsk={(fn) => {
                askFn.current = fn;
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-neutral-100 " +
        (danger ? "text-red-600" : "text-neutral-700")
      }
    >
      {children}
    </button>
  );
}
