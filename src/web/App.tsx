import * as React from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, Copy, Eye, EyeOff, FileText, GripVertical, Moon, Plus, Search, Sun, Trash2, X } from "lucide-react";
import type { ContextBlock, ContextBlockCategory, ContextPack, ContextPackItem } from "../types";
import { CATEGORY_ORDER, CATEGORY_TITLES, packItem, renderContextPackOutput } from "../pack";
import { formatTokens } from "../text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type TaskSummary = { task: string; handoffCount: number; latestAt: string };
type Panel = "library" | "preview";
type Theme = "light" | "dark";

const CATEGORY_DOT: Record<ContextBlockCategory, string> = {
  intent: "bg-blue",
  instruction: "bg-blue",
  "next-action": "bg-amber",
  decision: "bg-green",
  constraint: "bg-purple",
  verification: "bg-green",
  risk: "bg-red",
  "changed-file": "bg-faint",
  transcript: "bg-faint"
};

export function App() {
  const [tasks, setTasks] = React.useState<TaskSummary[]>([]);
  const [packs, setPacks] = React.useState<ContextPack[]>([]);
  const [blocks, setBlocks] = React.useState<ContextBlock[]>([]);
  const [source, setSource] = React.useState("");
  const [pack, setPack] = React.useState<ContextPack>(newDraft);
  const [savedSnapshot, setSavedSnapshot] = React.useState("");
  const [panel, setPanel] = React.useState<Panel>("library");
  // Below 1280px the panel slides over the document instead of docking beside it.
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<ContextBlockCategory | "all">("all");
  const [toast, setToast] = React.useState("");
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState("");
  const [theme, setTheme] = React.useState<Theme>(initialTheme);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const output = React.useMemo(() => renderContextPackOutput(pack), [pack]);
  const dirty = snapshot(pack) !== savedSnapshot;
  const addedBlockIds = React.useMemo(() => new Set(pack.items.map((item) => item.blockId)), [pack.items]);
  const visibleBlocks = React.useMemo(() => filterBlocks(blocks, query, category), [blocks, query, category]);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("ctxpool.theme", theme);
    } catch {
      // Storage can be unavailable; the theme still applies for this visit.
    }
  }, [theme]);

  React.useEffect(() => {
    void load();
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function load() {
    setStatus("loading");
    try {
      const [taskData, packData] = await Promise.all([api<{ tasks: TaskSummary[] }>("/api/tasks"), api<{ packs: ContextPack[] }>("/api/context-packs")]);
      setTasks(taskData.tasks);
      setPacks(packData.packs);
      openPack(packData.packs[0] || newDraft());
      await loadBlocks("");
      setStatus("ready");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not reach the ContextPool server.");
      setStatus("error");
    }
  }

  async function loadBlocks(task: string) {
    setSource(task);
    const data = await api<{ blocks: ContextBlock[] }>(`/api/context-blocks${task ? `?task=${encodeURIComponent(task)}` : ""}`);
    setBlocks(data.blocks);
  }

  function openPack(next: ContextPack) {
    setPack(next);
    setSavedSnapshot(snapshot(next));
  }

  function update(change: (current: ContextPack) => ContextPack) {
    setPack((current) => {
      const next = change(current);
      return { ...next, items: next.items.map((item, order) => ({ ...item, order })) };
    });
  }

  function addBlock(block: ContextBlock) {
    update((current) => ({ ...current, items: [...current.items, packItem(block, current.items.length, current.id)] }));
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    update((current) => {
      const from = current.items.findIndex((item) => item.id === active.id);
      const to = current.items.findIndex((item) => item.id === over.id);
      return from < 0 || to < 0 ? current : { ...current, items: arrayMove(current.items, from, to) };
    });
  }

  async function save() {
    try {
      const data = await api<{ pack: ContextPack }>("/api/context-packs", { method: "POST", body: JSON.stringify(pack) });
      openPack(data.pack);
      setPacks((await api<{ packs: ContextPack[] }>("/api/context-packs")).packs);
      notify("Saved");
    } catch (saveError) {
      notify(saveError instanceof Error ? saveError.message : "Could not save");
    }
  }

  async function removePack(id: string) {
    if (!window.confirm("Delete this pack? This can't be undone.")) return;
    await api(`/api/context-packs/${encodeURIComponent(id)}`, { method: "DELETE" });
    const remaining = packs.filter((candidate) => candidate.id !== id);
    setPacks(remaining);
    if (pack.id === id) openPack(remaining[0] || newDraft());
    notify("Deleted");
  }

  async function copy(format: "markdown" | "json") {
    await navigator.clipboard.writeText(format === "json" ? JSON.stringify(output.json, null, 2) : output.markdown);
    notify(format === "json" ? "Copied JSON" : "Copied to clipboard");
  }

  function openPanel(name: Panel) {
    setPanel(name);
    setPanelOpen(true);
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? "" : current)), 1800);
  }

  if (status === "loading") return <div className="grid h-full place-items-center text-[13px] text-muted-foreground">Loading…</div>;
  if (status === "error") {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="max-w-sm text-center">
          <h1 className="font-serif text-2xl font-semibold">Can’t reach ContextPool</h1>
          <p className="mt-2 text-muted-foreground">{error}</p>
          <p className="mt-1 text-[13px] text-faint">Make sure `ctxpool ui` is still running.</p>
          <Button variant="outline" className="mt-5" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <Sidebar
        packs={packs}
        activePackId={pack.id}
        tasks={tasks}
        source={source}
        theme={theme}
        onNewPack={() => openPack(newDraft())}
        onOpenPack={openPack}
        onDeletePack={(id) => void removePack(id)}
        onSelectSource={(task) => void loadBlocks(task)}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />

      <div className="flex min-w-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center justify-between gap-3 px-3">
            <div className="hidden min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground sm:flex">
              <span>Packs</span>
              <span className="text-faint">/</span>
              <span className="truncate text-foreground">{pack.name || "Untitled"}</span>
              <span className="ml-2 text-[12px] text-faint">{dirty ? "Unsaved" : "Saved"}</span>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" className="xl:hidden" onClick={() => openPanel("library")}>
                Library
              </Button>
              <Button size="sm" className="xl:hidden" onClick={() => openPanel("preview")}>
                Preview
              </Button>
              <Button size="sm" onClick={() => void copy("markdown")} disabled={!output.json.items.length}>
                <Copy /> <span className="hidden sm:inline">Copy</span>
              </Button>
              <Button size="sm" variant="default" onClick={() => void save()} disabled={!dirty}>
                Save
              </Button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <article className="mx-auto w-full max-w-[720px] px-6 pb-32 pt-10 sm:px-12 sm:pt-16">
              <input
                value={pack.name}
                onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
                placeholder="Untitled"
                aria-label="Pack name"
                className="w-full bg-transparent font-serif text-[34px] font-semibold leading-tight tracking-[-0.01em] outline-none placeholder:text-faint"
              />
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
                <span>
                  {output.json.items.length} {output.json.items.length === 1 ? "block" : "blocks"} · ~{formatTokens(output.estimatedTokens)} tokens
                </span>
                <Toggle
                  checked={pack.includeRawTranscript}
                  onChange={(checked) => update((current) => ({ ...current, includeRawTranscript: checked }))}
                  label="Include transcript"
                />
              </div>

              <div className="mt-8 border-t border-border pt-4">
                {pack.items.length ? (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={pack.items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                      <ul className="space-y-0.5">
                        {pack.items.map((item) => (
                          <PackRow
                            key={item.id}
                            item={item}
                            withheld={!pack.includeRawTranscript && item.block.category === "transcript"}
                            onToggle={() => update((current) => ({ ...current, items: current.items.map((entry) => (entry.id === item.id ? { ...entry, enabled: !entry.enabled } : entry)) }))}
                            onRemove={() => update((current) => ({ ...current, items: current.items.filter((entry) => entry.id !== item.id) }))}
                          />
                        ))}
                      </ul>
                    </SortableContext>
                  </DndContext>
                ) : (
                  <EmptyPack hasBlocks={blocks.length > 0} />
                )}
              </div>
            </article>
          </div>
        </main>

        {panelOpen && <div className="fixed inset-0 z-20 bg-black/20 xl:hidden" onClick={() => setPanelOpen(false)} />}
        <aside
          className={cn(
            "fixed inset-y-0 right-0 z-30 flex w-full max-w-[400px] flex-col border-l border-border bg-background shadow-2xl transition-transform duration-200 xl:static xl:z-auto xl:w-[400px] xl:translate-x-0 xl:shadow-none",
            panelOpen ? "translate-x-0" : "translate-x-full"
          )}
        >
          <div className="flex h-11 shrink-0 items-center gap-1 px-3">
            {(["library", "preview"] as Panel[]).map((name) => (
              <button
                key={name}
                onClick={() => setPanel(name)}
                className={cn("rounded-md px-2.5 py-1 text-[13px] transition-colors", panel === name ? "bg-hover font-medium text-foreground" : "text-muted-foreground hover:bg-hover")}
              >
                {name === "library" ? "Library" : "Preview"}
              </button>
            ))}
            <IconButton label="Close" onClick={() => setPanelOpen(false)} icon={<X />} className="ml-auto xl:hidden" />
          </div>
          {panel === "library" ? (
            <Library
              blocks={visibleBlocks}
              total={blocks.length}
              query={query}
              category={category}
              added={addedBlockIds}
              onQuery={setQuery}
              onCategory={setCategory}
              onAdd={addBlock}
            />
          ) : (
            <Preview markdown={output.markdown} warnings={output.warnings} onCopy={(format) => void copy(format)} />
          )}
        </aside>
      </div>

      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-ink px-3 py-1.5 text-[13px] text-ink-foreground shadow-lg transition-all duration-200",
          toast ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
        )}
      >
        {toast}
      </div>
    </div>
  );
}

function Sidebar(props: {
  packs: ContextPack[];
  activePackId: string;
  tasks: TaskSummary[];
  source: string;
  theme: Theme;
  onNewPack: () => void;
  onOpenPack: (pack: ContextPack) => void;
  onDeletePack: (id: string) => void;
  onSelectSource: (task: string) => void;
  onToggleTheme: () => void;
}) {
  return (
    <nav className="hidden w-[248px] shrink-0 flex-col bg-sidebar md:flex">
      <div className="flex h-11 items-center gap-2 px-4">
        <Mark />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">ContextPool</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <SectionLabel action={<IconButton label="New pack" onClick={props.onNewPack} icon={<Plus />} />}>Packs</SectionLabel>
        {props.packs.map((pack) => (
          <div key={pack.id} className={cn("group flex items-center rounded-md", pack.id === props.activePackId ? "bg-hover" : "hover:bg-hover")}>
            <button onClick={() => props.onOpenPack(pack)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[13.5px]">
              <FileText className="size-4 shrink-0 text-faint" />
              <span className={cn("truncate", pack.id === props.activePackId ? "font-medium text-foreground" : "text-muted-foreground")}>{pack.name || "Untitled"}</span>
            </button>
            <IconButton label="Delete pack" onClick={() => props.onDeletePack(pack.id)} icon={<Trash2 />} className="mr-1 opacity-0 group-hover:opacity-100" />
          </div>
        ))}
        {!props.packs.length && <p className="px-2 py-1 text-[13px] text-faint">No saved packs yet</p>}

        <SectionLabel className="mt-6">Sources</SectionLabel>
        <SourceButton active={props.source === ""} onClick={() => props.onSelectSource("")} label="All handoffs" />
        {props.tasks.map((task) => (
          <SourceButton
            key={task.task}
            active={props.source === task.task}
            onClick={() => props.onSelectSource(task.task)}
            label={task.task}
            detail={`${task.handoffCount} · ${relativeTime(task.latestAt)}`}
          />
        ))}
        {!props.tasks.length && <p className="px-2 py-1 text-[13px] leading-5 text-faint">Run `ctxpool handoff` in a repo to add a source.</p>}
      </div>

      <div className="flex items-center justify-between px-3 py-2 text-[12px] text-faint">
        <span>Local only</span>
        <IconButton label={props.theme === "dark" ? "Light theme" : "Dark theme"} onClick={props.onToggleTheme} icon={props.theme === "dark" ? <Sun /> : <Moon />} />
      </div>
    </nav>
  );
}

function SourceButton({ active, onClick, label, detail }: { active: boolean; onClick: () => void; label: string; detail?: string }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[13.5px]", active ? "bg-hover font-medium text-foreground" : "text-muted-foreground hover:bg-hover")}>
      <span className="truncate">{label}</span>
      {detail && <span className="shrink-0 text-[12px] font-normal text-faint">{detail}</span>}
    </button>
  );
}

function PackRow({ item, withheld, onToggle, onRemove }: { item: ContextPackItem; withheld: boolean; onToggle: () => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const muted = !item.enabled || withheld;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group relative -mx-2 flex gap-2 rounded-md px-2 py-2 hover:bg-hover", isDragging && "z-10 bg-background shadow-lg ring-1 ring-border")}
    >
      <button {...attributes} {...listeners} aria-label="Drag to reorder" className="absolute -left-6 top-2 flex h-6 w-5 cursor-grab items-center justify-center rounded text-faint opacity-0 hover:bg-hover group-hover:opacity-100 active:cursor-grabbing">
        <GripVertical className="size-4" />
      </button>
      <div className={cn("min-w-0 flex-1", muted && "opacity-45")}>
        <CategoryLabel category={item.block.category} />
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-[1.6]">{item.block.text}</p>
        <p className="mt-1 text-[12px] text-faint">
          {item.block.sourceTask} · {item.block.provenance.kind}
          {withheld && item.enabled ? " · left out of export" : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label={item.enabled ? "Exclude from export" : "Include in export"} onClick={onToggle} icon={item.enabled ? <Eye /> : <EyeOff />} />
        <IconButton label="Remove" onClick={onRemove} icon={<X />} />
      </div>
    </li>
  );
}

function Library(props: {
  blocks: ContextBlock[];
  total: number;
  query: string;
  category: ContextBlockCategory | "all";
  added: Set<string>;
  onQuery: (query: string) => void;
  onCategory: (category: ContextBlockCategory | "all") => void;
  onAdd: (block: ContextBlock) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2.5 px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-faint" />
          <Input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Search blocks" className="pl-8" aria-label="Search blocks" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(["all", ...CATEGORY_ORDER] as const).map((value) => (
            <button
              key={value}
              onClick={() => props.onCategory(value)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[12px] transition-colors",
                props.category === value ? "border-transparent bg-ink text-ink-foreground" : "border-border text-muted-foreground hover:bg-hover"
              )}
            >
              {value === "all" ? "All" : CATEGORY_TITLES[value]}
            </button>
          ))}
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {props.blocks.map((block) => {
          const added = props.added.has(block.id);
          return (
            <li key={block.id}>
              <button onClick={() => props.onAdd(block)} className="group flex w-full gap-2 rounded-md px-2 py-2 text-left hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <CategoryLabel category={block.category} />
                  <p className="mt-0.5 line-clamp-3 text-[13px] leading-5">{block.text}</p>
                  <p className="mt-0.5 truncate text-[11.5px] text-faint">{block.sourceTask}</p>
                </div>
                <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-faint", added ? "text-green" : "opacity-0 group-hover:opacity-100")}>
                  {added ? <Check className="size-4" /> : <Plus className="size-4" />}
                </span>
              </button>
            </li>
          );
        })}
        {!props.blocks.length && (
          <p className="px-2 py-6 text-center text-[13px] text-faint">{props.total ? "Nothing matches this filter." : "No handoffs yet. Run `ctxpool handoff` to capture one."}</p>
        )}
      </ul>
    </div>
  );
}

function Preview({ markdown, warnings, onCopy }: { markdown: string; warnings: string[]; onCopy: (format: "markdown" | "json") => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-4 pb-3">
        <Button size="sm" variant="outline" onClick={() => onCopy("markdown")}>
          <Copy /> Markdown
        </Button>
        <Button size="sm" variant="outline" onClick={() => onCopy("json")}>
          JSON
        </Button>
      </div>
      {warnings.length > 0 && (
        <div className="mx-4 mb-3 space-y-1 rounded-md bg-muted px-3 py-2 text-[12.5px] leading-5 text-muted-foreground">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-4 pb-8 text-[12px] leading-[1.7] text-muted-foreground">{markdown}</pre>
    </div>
  );
}

function EmptyPack({ hasBlocks }: { hasBlocks: boolean }) {
  return (
    <div className="py-10 text-[15px] leading-7 text-muted-foreground">
      <p>A pack is reusable context for your next agent: the objective, decisions, constraints, and checks that matter.</p>
      <p className="text-faint">{hasBlocks ? "Pick blocks from the Library to start." : "Capture a handoff with `ctxpool handoff`, then pick blocks from the Library."}</p>
    </div>
  );
}

function CategoryLabel({ category }: { category: ContextBlockCategory }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", CATEGORY_DOT[category])} />
      {CATEGORY_TITLES[category]}
    </span>
  );
}

function SectionLabel({ children, action, className }: { children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-1 flex h-7 items-center justify-between px-2 text-[12px] font-medium text-faint", className)}>
      <span>{children}</span>
      {action}
    </div>
  );
}

function IconButton({ label, onClick, icon, className }: { label: string; onClick: () => void; icon: React.ReactNode; className?: string }) {
  return (
    <Button size="icon" aria-label={label} title={label} onClick={onClick} className={cn("size-6 [&_svg]:size-3.5", className)}>
      {icon}
    </Button>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2">
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn("relative h-4 w-7 rounded-full transition-colors", checked ? "bg-blue" : "bg-border")}
      >
        <span className={cn("absolute top-0.5 size-3 rounded-full bg-white shadow transition-transform", checked ? "translate-x-3.5" : "translate-x-0.5")} />
      </button>
      {label}
    </label>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
      <rect width="20" height="20" rx="5" className="fill-ink" />
      <path d="M6 7.5h4.2a2.8 2.8 0 0 1 0 5.6H6" fill="none" className="stroke-ink-foreground" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="14" cy="10.3" r="1.3" className="fill-ink-foreground" />
    </svg>
  );
}

function newDraft(): ContextPack {
  const now = new Date().toISOString();
  return { id: `pack_${crypto.randomUUID().slice(0, 12)}`, name: "", createdAt: now, updatedAt: now, includeRawTranscript: false, items: [] };
}

function snapshot(pack: ContextPack): string {
  return JSON.stringify([pack.name, pack.includeRawTranscript, pack.items.map((item) => [item.blockId, item.enabled])]);
}

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem("ctxpool.theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the system preference.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function filterBlocks(blocks: ContextBlock[], query: string, category: ContextBlockCategory | "all"): ContextBlock[] {
  const needle = query.trim().toLowerCase();
  return blocks
    .filter((block) => category === "all" || block.category === category)
    .filter((block) => !needle || `${block.title} ${block.text} ${block.sourceTask}`.toLowerCase().includes(needle))
    .slice(0, 200);
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
