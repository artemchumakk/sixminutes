import { useState, type ReactNode } from "react";
import type { Workspace } from "../lib/types";
import { cx } from "./ui/primitives";
import {
  ChevronDown,
  Folder,
  Home,
  NewChat,
  Plus,
  RedCross,
  Search,
  Waveform,
} from "./ui/icons";

interface WorkspaceFolderData {
  name: string;
  chats: { title: string; live?: boolean }[];
}

const INITIAL_WORKSPACES: WorkspaceFolderData[] = [
  {
    name: "London Bridge Hospital",
    chats: [
      { title: "Closure damage audit", live: true },
      { title: "C2 response tail · Lambeth" },
      { title: "Reroute · Westminster Bridge closure" },
      { title: "Night cover gap · Southwark" },
      { title: "Cardiac-arrest coverage map" },
    ],
  },
];

// fire workspace: the warden's board, grouped by time horizon — click your
// station on the map first and "my ground / my pumps" resolve to it
const FIRE_ANALYSES: { group: string; items: { title: string; hint: string; ask: string }[] }[] = [
  {
    group: "Right now",
    items: [
      {
        title: "Who covers my ground?",
        hint: "your pumps just committed",
        ask: "My pumps just committed — who covers my ground?",
      },
      {
        title: "Best cover move",
        hint: "six pumps gone from my patch",
        ask: "A big job takes six pumps from my patch — knock-on and best cover?",
      },
    ],
  },
  {
    group: "Tonight",
    items: [
      {
        title: "Where does the promise break?",
        hint: "the night map's thin ice",
        ask: "Where does the 6-minute promise break tonight?",
      },
      {
        title: "My station: night vs day",
        hint: "the after-dark difference",
        ask: "Compare closing my station at night versus during the day.",
      },
    ],
  },
  {
    group: "Planning",
    items: [
      {
        title: "Rank irreplaceable stations",
        hint: "the criticality league",
        ask: "Rank stations by how irreplaceable they are",
      },
      {
        title: "The crying-wolf buildings",
        hint: "false alarms, in pounds",
        ask: "Which buildings keep crying wolf — and what does it cost?",
      },
      {
        title: "Why trust this?",
        hint: "validation, plainly",
        ask: "Why should I trust this?",
      },
    ],
  },
];

export default function Sidebar({
  ws,
  onNewChat,
  onSearch,
  onVoice,
  onExit,
  onQuickAsk,
}: {
  ws: Workspace;
  onNewChat: () => void;
  onSearch: () => void;
  onVoice: () => void;
  onExit: () => void;
  onQuickAsk?: (text: string) => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceFolderData[]>(INITIAL_WORKSPACES);
  const fire = ws.id === "fire";

  function addWorkspace() {
    const n = workspaces.filter((w) => w.name.startsWith("New workspace")).length + 1;
    setWorkspaces((w) => [...w, { name: `New workspace ${n}`, chats: [] }]);
  }

  function deleteWorkspace(idx: number) {
    setWorkspaces((w) => w.filter((_, i) => i !== idx));
  }
  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-neutral-200 bg-white">
      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        <div className="mb-2 flex w-full items-center justify-between rounded-full bg-neutral-100 px-3 py-1.5 text-[14px] font-medium text-neutral-700">
          <span className="flex items-center gap-2">
            {fire ? (
              <span className="text-[15px] leading-none" style={{ color: ws.accent }}>
                {ws.icon}
              </span>
            ) : (
              <RedCross size={16} className="text-red-600" />
            )}
            {ws.short}
          </span>
          <button
            onClick={onExit}
            title="Choose service"
            className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-800"
          >
            <Home size={16} />
          </button>
        </div>

        <nav className="flex flex-col gap-0.5">
          <Item icon={<NewChat size={18} />} onClick={onNewChat}>
            New chat
          </Item>
          {!fire && (
            <Item icon={<Search size={18} />} onClick={onSearch}>
              Search
            </Item>
          )}
          <Item icon={<Waveform size={18} />} onClick={onVoice}>
            Voice agent
          </Item>
        </nav>

        {!fire && (
          <>
            <Section>Workspaces</Section>
            <nav className="flex flex-col gap-0.5">
              {workspaces.map((w, i) => (
                <WorkspaceFolder key={w.name} data={w} onDelete={() => deleteWorkspace(i)} />
              ))}
              <Item icon={<Plus size={18} />} onClick={addWorkspace}>
                Add workspace
              </Item>
            </nav>
          </>
        )}

        {fire ? (
          <>
            {FIRE_ANALYSES.map((g) => (
              <div key={g.group}>
                <Section>{g.group}</Section>
                <nav className="flex flex-col gap-1.5">
                  {g.items.map((it) => (
                    <button
                      key={it.title}
                      onClick={() => onQuickAsk?.(it.ask)}
                      className="group rounded-lg border border-neutral-200 px-2.5 py-2 text-left transition-all hover:border-neutral-300 hover:bg-neutral-50 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
                    >
                      <div className="text-[13px] font-medium text-neutral-800 group-hover:text-neutral-900">
                        {it.title}
                      </div>
                      <div className="mt-0.5 text-[11px] text-neutral-400">{it.hint}</div>
                    </button>
                  ))}
                </nav>
              </div>
            ))}
            <div className="mt-4 px-2.5">
              <button
                onClick={() => onQuickAsk?.("Reset the board")}
                className="text-[12px] text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
              >
                Reset the board
              </button>
            </div>
          </>
        ) : (
          <>
            <Section>Recent</Section>
            <nav className="flex flex-col gap-0.5">
              <PlainItem>Close Wembley NW base</PlainItem>
              <PlainItem>Strike-day posture · NE London</PlainItem>
              <PlainItem>Rank bases by closure damage</PlainItem>
              <PlainItem>Croydon C2 tail analysis</PlainItem>
              <PlainItem>Pre-position unit at Greenwich</PlainItem>
              <PlainItem>Storm scenario · Thames flood</PlainItem>
              <PlainItem>Edmonton coverage hole</PlainItem>
              <PlainItem>Move pump from Waterloo HQ</PlainItem>
              <PlainItem>Fleet sizing experiment</PlainItem>
            </nav>
          </>
        )}
      </div>

    </aside>
  );
}

function Item({
  icon,
  children,
  onClick,
  dot,
  compact,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  dot?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex items-center gap-2.5 rounded-lg px-2.5 text-[14px] text-neutral-700 transition-colors hover:bg-neutral-100",
        compact ? "py-1.5" : "py-[7px]"
      )}
    >
      <span className="relative text-neutral-500">
        {icon}
        {dot && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" />}
      </span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function WorkspaceFolder({ data, onDelete }: { data: WorkspaceFolderData; onDelete: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={onDelete}
        title="Double-click to delete"
        className="flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[14px] text-neutral-700 transition-colors hover:bg-neutral-100"
      >
        <Folder size={18} className="text-neutral-500" />
        <span className="flex-1 truncate text-left">{data.name}</span>
        <ChevronDown
          size={14}
          className={cx("text-neutral-400 transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open &&
        (data.chats.length > 0 ? (
          data.chats.map((c) => (
            <SubItem key={c.title} live={c.live}>
              {c.title}
            </SubItem>
          ))
        ) : (
          <div className="py-1.5 pl-9 pr-2.5 text-[13px] text-neutral-400">No chats yet</div>
        ))}
    </>
  );
}

function SubItem({ children, live }: { children: ReactNode; live?: boolean }) {
  return (
    <button className="flex items-center justify-between rounded-lg py-[7px] pl-9 pr-2.5 text-[14px] text-neutral-600 transition-colors hover:bg-neutral-100">
      <span className="truncate">{children}</span>
      {live && <span className="ml-2 shrink-0 text-[12px] text-neutral-400">live</span>}
    </button>
  );
}

function PlainItem({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center rounded-lg px-2.5 py-[7px] text-left text-[14px] text-neutral-700 transition-colors hover:bg-neutral-100"
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-5 text-[12px] font-medium text-neutral-400">{children}</div>
  );
}
