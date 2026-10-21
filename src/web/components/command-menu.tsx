import * as React from "react";
import { ArrowLeftRight, CornerDownLeft, Layers, LayoutGrid, Plug, Plus, Search } from "lucide-react";
import { useData } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AgentLogo } from "@/components/agent-logo";
import { Dialog } from "@/components/ui/dialog";

type Item = { id: string; group: string; label: string; detail?: string; icon: React.ReactNode; keywords: string; go: () => void };

/** ⌘K: jump to any page, handoff, task, or pack. */
export function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { handoffs, packs, tasks } = useData();
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const list = React.useRef<HTMLUListElement>(null);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const items = React.useMemo<Item[]>(() => {
    const pages: Item[] = [
      { id: "p-overview", group: "Go to", label: "Overview", icon: <LayoutGrid />, keywords: "overview dashboard charts", go: () => navigate("/") },
      { id: "p-handoffs", group: "Go to", label: "Handoffs", icon: <ArrowLeftRight />, keywords: "handoffs sessions list", go: () => navigate("/handoffs") },
      { id: "p-packs", group: "Go to", label: "Context packs", icon: <Layers />, keywords: "packs context", go: () => navigate("/packs") },
      { id: "p-new-pack", group: "Go to", label: "New context pack", icon: <Plus />, keywords: "new pack create", go: () => navigate("/packs/new") },
      { id: "p-connect", group: "Go to", label: "Connect agents", icon: <Plug />, keywords: "connect mcp setup install claude codex gemini cursor", go: () => navigate("/connect") }
    ];
    return [
      ...pages,
      ...handoffs.map((handoff) => ({
        id: handoff.id,
        group: "Handoffs",
        label: handoff.title || handoff.nextAction,
        detail: `${handoff.task} · ${timeAgo(handoff.createdAt)}`,
        icon: <AgentLogo source={handoff.source} size={16} />,
        keywords: `${handoff.title || ""} ${handoff.task} ${handoff.repoName} ${handoff.branch} ${handoff.nextAction} ${handoff.objective} ${handoff.source || ""}`.toLowerCase(),
        go: () => navigate(`/handoffs/${handoff.id}`)
      })),
      ...tasks.map((task) => ({ id: `t-${task.task}`, group: "Tasks", label: task.task, detail: `${task.handoffCount} handoffs`, icon: <ArrowLeftRight />, keywords: `task ${task.task}`.toLowerCase(), go: () => navigate("/handoffs", { task: task.task }) })),
      ...packs.map((pack) => ({ id: pack.id, group: "Context packs", label: pack.name, detail: `${pack.items.length} blocks`, icon: <Layers />, keywords: `pack ${pack.name}`.toLowerCase(), go: () => navigate(`/packs/${pack.id}`) }))
    ];
  }, [handoffs, packs, tasks]);

  const results = React.useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = words.length ? items.filter((item) => words.every((word) => `${item.label.toLowerCase()} ${item.keywords}`.includes(word))) : items.filter((item) => item.group === "Go to" || item.group === "Handoffs");
    const limited: Item[] = [];
    const perGroup = new Map<string, number>();
    for (const item of matches) {
      const count = perGroup.get(item.group) || 0;
      if (count >= (words.length ? 8 : 5)) continue;
      perGroup.set(item.group, count + 1);
      limited.push(item);
    }
    return limited;
  }, [items, query]);

  React.useEffect(() => setIndex(0), [query]);
  React.useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function choose(item: Item | undefined) {
    if (!item) return;
    onClose();
    item.go();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => Math.min(results.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[index]);
    }
  }

  let lastGroup = "";
  return (
    <Dialog open={open} onClose={onClose} label="Search">
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search handoffs, tasks, packs…"
          aria-label="Search"
          role="combobox"
          aria-expanded
          aria-controls="command-results"
          aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
          className="h-12 w-full bg-transparent text-[14.5px] outline-none placeholder:text-faint"
        />
      </div>
      <ul ref={list} id="command-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {results.map((item, position) => {
          const header = item.group !== lastGroup ? item.group : undefined;
          lastGroup = item.group;
          return (
            <React.Fragment key={item.id}>
              {header && <li className="px-2.5 pb-1 pt-2.5 text-[11.5px] font-medium text-faint">{header}</li>}
              <li
                id={`cmd-${item.id}`}
                role="option"
                aria-selected={position === index}
                data-index={position}
                onPointerMove={() => setIndex(position)}
                onClick={() => choose(item)}
                className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground", position === index && "bg-hover")}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.detail && <span className="max-w-[40%] shrink-0 truncate text-[12px] text-faint">{item.detail}</span>}
                {position === index && <CornerDownLeft className="!size-3.5 !text-faint" />}
              </li>
            </React.Fragment>
          );
        })}
        {!results.length && <li className="px-3 py-8 text-center text-[13px] text-faint">Nothing matches “{query}”.</li>}
      </ul>
    </Dialog>
  );
}
