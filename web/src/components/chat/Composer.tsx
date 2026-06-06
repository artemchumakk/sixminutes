import { useRef, useState } from "react";
import type { Workspace } from "../../lib/types";
import { cx } from "../ui/primitives";
import { ArrowUp, ChevronDown, Folder, FolderPlus, Mic, Nvidia, Plus } from "../ui/icons";

export type Mode = "agentic" | "local";

export default function Composer({
  value,
  onChange,
  onSubmit,
  ws,
  onToggleVoice,
  voiceActive,
  busy,
  autoFocus,
  folders,
  activeFolder,
  onSelectFolder,
  onAddFolder,
  header,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  ws: Workspace;
  onToggleVoice: () => void;
  voiceActive: boolean;
  busy: boolean;
  autoFocus?: boolean;
  folders: string[];
  activeFolder: string;
  onSelectFolder: (f: string) => void;
  onAddFolder: () => void;
  /** optional content rendered inside the bar, above the input (e.g. a transcript) */
  header?: React.ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [models, setModels] = useState<string[]>(["Nemotron"]);
  const [activeModel, setActiveModel] = useState("Nemotron");
  const canSend = value.trim().length > 0 && !busy;

  void ws;

  function addModel() {
    const localCount = models.filter((m) => m.startsWith("Local model")).length;
    const name = `Local model ${localCount + 1}`;
    setModels((m) => [...m, name]);
    setActiveModel(name);
    setModelOpen(false);
  }

  function modelBadge(m: string) {
    if (m === "Nemotron") return <Nvidia size={20} />;
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-neutral-900 text-[10px] text-white">
        {m[0]}
      </span>
    );
  }

  return (
    <div className="rounded-[26px] border border-neutral-200/80 bg-neutral-100/70 p-1.5">
      <div className="rounded-[20px] border border-neutral-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        {header && <div className="border-b border-neutral-100">{header}</div>}
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSubmit();
            }
          }}
          rows={1}
          placeholder="What would you like to know?"
          className="block max-h-44 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 text-neutral-900 outline-none placeholder:text-neutral-400"
        />
        <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
          {/* left: attach + folder */}
          <div className="flex items-center gap-1">
            <IconBtn title="Attach">
              <Plus size={18} />
            </IconBtn>
            <div className="relative">
              <FootPill onClick={() => setFolderOpen((o) => !o)} active={folderOpen}>
                <Folder size={15} className="text-neutral-500" />
                {activeFolder}
                <ChevronDown size={13} className="text-neutral-400" />
              </FootPill>
              {folderOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setFolderOpen(false)} />
                  <div className="absolute bottom-full left-0 z-20 mb-1.5 w-56 rounded-xl border border-neutral-200 bg-white p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
                    {folders.map((f) => (
                      <button
                        key={f}
                        onClick={() => {
                          onSelectFolder(f);
                          setFolderOpen(false);
                        }}
                        className={cx(
                          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-neutral-100",
                          f === activeFolder ? "text-neutral-900" : "text-neutral-600"
                        )}
                      >
                        <Folder size={15} className="text-neutral-500" />
                        <span className="truncate">{f}</span>
                        {f === activeFolder && <span className="ml-auto text-neutral-400">✓</span>}
                      </button>
                    ))}
                    <div className="my-1 h-px bg-neutral-100" />
                    <button
                      onClick={() => {
                        onAddFolder();
                        setFolderOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-neutral-700 hover:bg-neutral-100"
                    >
                      <FolderPlus size={15} className="text-neutral-500" />
                      New workspace
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* right: model + send + mic */}
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <button
                onClick={() => setModelOpen((o) => !o)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-neutral-100"
              >
                {activeModel === "Nemotron" && <Nvidia size={18} />}
                <span className="text-neutral-700">{activeModel}</span>
                <ChevronDown size={14} className="text-neutral-400" />
              </button>
              {modelOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setModelOpen(false)} />
                  <div className="absolute bottom-full right-0 z-20 mb-1.5 w-52 rounded-xl border border-neutral-200 bg-white p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
                    {models.map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          setActiveModel(m);
                          setModelOpen(false);
                        }}
                        className={cx(
                          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-neutral-100",
                          m === activeModel ? "text-neutral-900" : "text-neutral-600"
                        )}
                      >
                        {modelBadge(m)}
                        <span className="truncate">{m}</span>
                        {m === activeModel && <span className="ml-auto text-neutral-400">✓</span>}
                      </button>
                    ))}
                    <div className="my-1 h-px bg-neutral-100" />
                    <button
                      onClick={addModel}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-neutral-700 hover:bg-neutral-100"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-md border border-dashed border-neutral-300 text-neutral-500">
                        <Plus size={13} />
                      </span>
                      Add model
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              onClick={onSubmit}
              disabled={!canSend}
              title="Send"
              className={cx(
                "ml-0.5 flex h-8 w-8 items-center justify-center rounded-full transition-colors",
                canSend ? "bg-neutral-900 text-white hover:bg-neutral-700" : "bg-neutral-200 text-white"
              )}
            >
              <ArrowUp size={17} />
            </button>
            <IconBtn title="Voice" onClick={onToggleVoice} active={voiceActive}>
              <Mic size={18} />
            </IconBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  active,
}: {
  children: React.ReactNode;
  title?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cx(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
        active ? "bg-violet-50 text-violet-600" : "text-neutral-500 hover:bg-neutral-100"
      )}
    >
      {children}
    </button>
  );
}

function FootPill({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors",
        active ? "bg-neutral-100 text-neutral-800" : "text-neutral-600 hover:bg-neutral-100"
      )}
    >
      {children}
    </button>
  );
}
