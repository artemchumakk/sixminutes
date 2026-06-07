import { useMemo, useState } from "react";
import { CHATS } from "../lib/mock";
import { Folder, Search } from "./ui/icons";

export default function SearchView({ onOpen }: { onOpen?: (text: string) => void }) {
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return CHATS;
    return CHATS.filter(
      (c) => c.title.toLowerCase().includes(t) || c.folder.toLowerCase().includes(t)
    );
  }, [q]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="mb-5 text-[26px] font-medium tracking-tight text-neutral-900">
          What chat would you like to find?
        </h1>
        {/* search bar */}
        <div className="flex items-center gap-2.5 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus-within:border-neutral-300">
          <Search size={18} className="text-neutral-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search chats…"
            className="flex-1 bg-transparent text-[15px] text-neutral-900 outline-none placeholder:text-neutral-400"
          />
          {q && (
            <button onClick={() => setQ("")} className="text-[13px] text-neutral-400 hover:text-neutral-700">
              Clear
            </button>
          )}
        </div>

        <div className="mb-3 mt-6 text-[12px] font-medium uppercase tracking-wide text-neutral-400">
          {results.length} {results.length === 1 ? "chat" : "chats"}
        </div>

        {/* grid — 4 per row, larger cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {results.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpen?.(c.title)}
              className="group flex h-56 flex-col rounded-2xl border border-neutral-200 bg-white p-5 text-left transition-all hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)]"
            >
              <div className="text-[16px] font-medium leading-snug text-neutral-900">{c.title}</div>
              <p className="mt-2.5 flex-1 text-[13.5px] leading-relaxed text-neutral-500 line-clamp-5">
                {c.summary}
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3 text-[12px] text-neutral-400">
                <span className="flex items-center gap-1.5">
                  <Folder size={13} className="text-neutral-400" />
                  {c.folder}
                </span>
                <span>{c.when}</span>
              </div>
            </button>
          ))}
        </div>

        {results.length === 0 && (
          <div className="py-16 text-center text-[14px] text-neutral-400">No chats match “{q}”.</div>
        )}
      </div>
    </div>
  );
}
