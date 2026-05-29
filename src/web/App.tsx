import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Copy,
  FileText,
  GripVertical,
  Moon,
  Plus,
  Save,
  Search,
  Sun,
  Trash2,
  X
} from "lucide-react";
import type { ContextBlock, ContextPack, ContextPackItem, ContextPackOutput } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TaskSummary = {
  task: string;
  handoffCount: number;
  latestAt: string;
};

const categoryOrder: ContextBlock["category"][] = [
  "intent",
  "instruction",
  "decision",
  "constraint",
  "verification",
  "risk",
  "next-action",
  "changed-file",
  "transcript"
];

function ContextPoolLogo() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-300/60 bg-zinc-950 shadow-sm shadow-cyan-500/20 dark:border-cyan-400/40" aria-hidden="true">
      <svg viewBox="0 0 32 32" className="h-7 w-7" role="img">
        <defs>
          <linearGradient id="ctxpool-mark" x1="7" y1="6" x2="25" y2="26" gradientUnits="userSpaceOnUse">
            <stop stopColor="#67e8f9" />
            <stop offset="1" stopColor="#22c55e" />
          </linearGradient>
        </defs>
        <rect x="3" y="3" width="26" height="26" rx="7" fill="#09090b" />
        <path d="M10 11.5h5.3c2.8 0 4.9 2.3 4.9 5.1v1.2" fill="none" stroke="url(#ctxpool-mark)" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M10 20.5h4.3c1.6 0 3-.7 4-1.9l2.1-2.7" fill="none" stroke="#f8fafc" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M12.8 16h8.4" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="1 3" />
        <circle cx="9" cy="11.5" r="2.5" fill="#09090b" stroke="#f8fafc" strokeWidth="1.6" />
        <circle cx="9" cy="20.5" r="2.5" fill="#09090b" stroke="url(#ctxpool-mark)" strokeWidth="1.6" />
        <circle cx="22.5" cy="16" r="4" fill="#09090b" stroke="url(#ctxpool-mark)" strokeWidth="1.8" />
        <circle cx="22.5" cy="16" r="1.45" fill="#f8fafc" />
      </svg>
    </div>
  );
}

export function App() {
  const [tasks, setTasks] = React.useState<TaskSummary[]>([]);
  const [blocks, setBlocks] = React.useState<ContextBlock[]>([]);
  const [packs, setPacks] = React.useState<ContextPack[]>([]);
  const [selectedTask, setSelectedTask] = React.useState("");
  const [selectedPackId, setSelectedPackId] = React.useState("");
  const [pack, setPack] = React.useState<ContextPack>(() => newDraftPack());
  const [preview, setPreview] = React.useState<ContextPackOutput | undefined>();
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<ContextBlock["category"] | "all">("all");
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [theme, setTheme] = React.useState<"light" | "dark">(() => (localStorage.getItem("ctxpool.web.theme") === "dark" ? "dark" : "light"));

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("ctxpool.web.theme", theme);
  }, [theme]);

  React.useEffect(() => {
    void loadInitial();
  }, []);

  React.useEffect(() => {
    setPreview(renderLocalPreview(pack));
  }, [pack]);

  const visibleBlocks = React.useMemo(() => filterBlocks(blocks, query, category), [blocks, query, category]);
  const enabledCount = pack.items.filter((item) => item.enabled).length;

  async function loadInitial() {
    setLoading(true);
    setError("");
    try {
      const [taskResponse, packsResponse] = await Promise.all([
        fetchJson<{ tasks: TaskSummary[] }>("/api/tasks"),
        fetchJson<{ packs: ContextPack[] }>("/api/context-packs")
      ]);
      setTasks(taskResponse.tasks);
      setPacks(packsResponse.packs);
      if (packsResponse.packs[0]) {
        setSelectedPackId(packsResponse.packs[0].id);
        setPack(packsResponse.packs[0]);
      }
      const task = taskResponse.tasks[0]?.task || "";
      setSelectedTask(task);
      await loadBlocks(task);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load ContextPool data.");
    } finally {
      setLoading(false);
    }
  }

  async function loadBlocks(task: string) {
    const response = await fetchJson<{ blocks: ContextBlock[] }>(`/api/context-blocks${task ? `?task=${encodeURIComponent(task)}` : ""}`);
    setBlocks(response.blocks);
  }

  async function selectTask(task: string) {
    setSelectedTask(task);
    setQuery("");
    await loadBlocks(task);
  }

  function addBlock(block: ContextBlock) {
    setPack((current) => {
      const item: ContextPackItem = {
        id: `item_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        blockId: block.id,
        block,
        order: current.items.length,
        enabled: true
      };
      return normalizePackItems({ ...current, items: [...current.items, item] });
    });
  }

  function duplicateItem(item: ContextPackItem) {
    setPack((current) =>
      normalizePackItems({
        ...current,
        items: [
          ...current.items,
          {
            ...item,
            id: `item_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            order: current.items.length
          }
        ]
      })
    );
  }

  function removeItem(id: string) {
    setPack((current) => normalizePackItems({ ...current, items: current.items.filter((item) => item.id !== id) }));
  }

  function toggleItem(id: string) {
    setPack((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item))
    }));
  }

  function moveItem(id: string, direction: -1 | 1) {
    setPack((current) => {
      const index = current.items.findIndex((item) => item.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.items.length) return current;
      return normalizePackItems({ ...current, items: arrayMove(current.items, index, nextIndex) });
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setPack((current) => {
      const oldIndex = current.items.findIndex((item) => item.id === active.id);
      const newIndex = current.items.findIndex((item) => item.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return current;
      return normalizePackItems({ ...current, items: arrayMove(current.items, oldIndex, newIndex) });
    });
  }

  async function savePack() {
    const response = await fetch("/api/context-packs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pack)
    });
    if (!response.ok) throw new Error(`Save failed: ${response.status}`);
    const saved = (await response.json()) as { pack: ContextPack };
    setPack(saved.pack);
    setSelectedPackId(saved.pack.id);
    const packsResponse = await fetchJson<{ packs: ContextPack[] }>("/api/context-packs");
    setPacks(packsResponse.packs);
    showNotice("Saved pack");
  }

  async function loadPack(id: string) {
    const response = await fetchJson<{ pack: ContextPack }>(`/api/context-packs/${encodeURIComponent(id)}`);
    setSelectedPackId(response.pack.id);
    setPack(response.pack);
  }

  function newPack() {
    const draft = newDraftPack();
    setSelectedPackId("");
    setPack(draft);
  }

  async function copyPreview(format: "markdown" | "json") {
    const output = renderLocalPreview(pack);
    await navigator.clipboard.writeText(format === "json" ? JSON.stringify(output.json, null, 2) : output.markdown);
    showNotice(format === "json" ? "Copied JSON" : "Copied markdown");
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 1800);
  }

  if (loading) return <LoadingShell />;

  if (error) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>ContextPool could not load</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>{error}</p>
            <Button type="button" onClick={() => void loadInitial()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <ContextPoolLogo />
            <div>
              <div className="text-sm font-semibold">ContextPool</div>
              <div className="hidden text-xs text-muted-foreground sm:block">Reusable agent context builder</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
            <Button type="button" variant="ghost" size="icon" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="Toggle theme">
              {theme === "light" ? <Moon /> : <Sun />}
            </Button>
          </div>
        </header>

        <div className="grid min-h-[calc(100vh-3rem)] lg:grid-cols-[300px_minmax(420px,1fr)_420px]">
          <SourcePane
            tasks={tasks}
            selectedTask={selectedTask}
            blocks={visibleBlocks}
            query={query}
            category={category}
            onSelectTask={(task) => void selectTask(task)}
            onQueryChange={setQuery}
            onCategoryChange={setCategory}
            onAddBlock={addBlock}
          />

          <main className="min-w-0 border-r border-border">
            <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-col">
              <div className="border-b border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Input
                      value={pack.name}
                      onChange={(event) => setPack((current) => ({ ...current, name: event.target.value }))}
                      aria-label="Context pack name"
                      className="h-9 max-w-xl text-base font-semibold"
                    />
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">{pack.items.length} blocks</Badge>
                      <Badge variant="secondary">{enabledCount} enabled</Badge>
                      <Badge variant={pack.includeRawTranscript ? "warning" : "success"}>{pack.includeRawTranscript ? "raw transcript included" : "transcript redacted"}</Badge>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" onClick={newPack}>
                      <Plus />
                      New
                    </Button>
                    <Button type="button" onClick={() => void savePack()}>
                      <Save />
                      Save
                    </Button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={pack.includeRawTranscript}
                      onChange={(event) => setPack((current) => ({ ...current, includeRawTranscript: event.target.checked }))}
                    />
                    Include raw transcript text in exports
                  </label>
                </div>
              </div>

              <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)]">
                <SavedPacks packs={packs} selectedPackId={selectedPackId} onSelect={(id) => void loadPack(id)} />
                <ScrollArea className="min-h-0 border-l border-border">
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={pack.items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                      <div className="space-y-3 p-4">
                        {pack.items.map((item) => (
                          <SortablePackCard
                            key={item.id}
                            item={item}
                            onToggle={() => toggleItem(item.id)}
                            onDuplicate={() => duplicateItem(item)}
                            onRemove={() => removeItem(item.id)}
                            onMoveUp={() => moveItem(item.id, -1)}
                            onMoveDown={() => moveItem(item.id, 1)}
                          />
                        ))}
                        {!pack.items.length ? <EmptyPack /> : null}
                      </div>
                    </SortableContext>
                  </DndContext>
                </ScrollArea>
              </div>
            </div>
          </main>

          <PreviewPane preview={preview} onCopyMarkdown={() => void copyPreview("markdown")} onCopyJson={() => void copyPreview("json")} />
        </div>
      </div>
    </TooltipProvider>
  );
}

function SourcePane({
  tasks,
  selectedTask,
  blocks,
  query,
  category,
  onSelectTask,
  onQueryChange,
  onCategoryChange,
  onAddBlock
}: {
  tasks: TaskSummary[];
  selectedTask: string;
  blocks: ContextBlock[];
  query: string;
  category: ContextBlock["category"] | "all";
  onSelectTask: (task: string) => void;
  onQueryChange: (query: string) => void;
  onCategoryChange: (category: ContextBlock["category"] | "all") => void;
  onAddBlock: (block: ContextBlock) => void;
}) {
  return (
    <aside className="border-r border-border bg-muted/25">
      <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-col">
        <div className="border-b border-border p-4">
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Source Handoffs</div>
          <div className="space-y-1">
            {tasks.slice(0, 6).map((task) => (
              <button
                key={task.task}
                type="button"
                onClick={() => onSelectTask(task.task)}
                className={cn(
                  "w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selectedTask === task.task && "border-border bg-background shadow-sm"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{task.task}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{task.handoffCount} handoff(s)</div>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 border-b border-border p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search reusable context" className="pl-8" />
          </div>
          <select
            value={category}
            onChange={(event) => onCategoryChange(event.target.value as ContextBlock["category"] | "all")}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">All categories</option>
            {categoryOrder.map((value) => (
              <option key={value} value={value}>
                {labelize(value)}
              </option>
            ))}
          </select>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 p-3">
            {blocks.map((block) => (
              <SourceBlockCard key={block.id} block={block} onAdd={() => onAddBlock(block)} />
            ))}
            {!blocks.length ? <div className="p-4 text-sm text-muted-foreground">No reusable context matches this filter.</div> : null}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
}

function SourceBlockCard({ block, onAdd }: { block: ContextBlock; onAdd: () => void }) {
  return (
    <Card className="rounded-md">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <Badge variant={categoryVariant(block.category)}>{labelize(block.category)}</Badge>
          <Button type="button" variant="ghost" size="icon" onClick={onAdd} aria-label={`Add ${block.title}`}>
            <Plus />
          </Button>
        </div>
        <div className="text-sm font-medium">{block.title}</div>
        <p className="line-clamp-4 text-xs leading-5 text-muted-foreground">{block.text}</p>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">{block.provenance.kind}</Badge>
          <Badge variant="secondary">{block.provenance.confidence}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function SavedPacks({ packs, selectedPackId, onSelect }: { packs: ContextPack[]; selectedPackId: string; onSelect: (id: string) => void }) {
  return (
    <aside className="hidden min-h-0 bg-muted/20 lg:block">
      <div className="border-b border-border p-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Saved Packs</div>
      <ScrollArea className="h-[calc(100vh-10rem)]">
        <div className="space-y-1 p-2">
          {packs.map((pack) => (
            <button
              key={pack.id}
              type="button"
              onClick={() => onSelect(pack.id)}
              className={cn(
                "w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedPackId === pack.id && "bg-background shadow-sm"
              )}
            >
              <div className="truncate font-medium">{pack.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{pack.items.length} block(s)</div>
            </button>
          ))}
          {!packs.length ? <div className="p-3 text-xs text-muted-foreground">No saved packs yet.</div> : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

function SortablePackCard({
  item,
  onToggle,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown
}: {
  item: ContextPackItem;
  onToggle: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-70", !item.enabled && "opacity-60")}>
    <Card className={cn("rounded-md", isDragging && "ring-2 ring-ring")}>
      <CardContent className="p-3">
        <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-3">
          <button
            type="button"
            className="mt-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Drag context block"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={categoryVariant(item.block.category)}>{labelize(item.block.category)}</Badge>
              <Badge variant="outline">{item.block.provenance.kind}</Badge>
              <Badge variant="secondary">{item.block.provenance.confidence}</Badge>
            </div>
            <div className="text-sm font-medium">{item.block.title}</div>
            <p className="text-sm leading-6">{item.block.text}</p>
            <div className="truncate font-mono text-xs text-muted-foreground">{item.block.sourceTask}</div>
          </div>
          <div className="flex flex-col gap-1">
            <Tooltip>
              <TooltipTrigger>
                <Button type="button" variant="ghost" size="icon" onClick={onToggle} aria-label={item.enabled ? "Disable block" : "Enable block"}>
                  {item.enabled ? <Check /> : <X />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{item.enabled ? "Disable block" : "Enable block"}</TooltipContent>
            </Tooltip>
            <Button type="button" variant="ghost" size="icon" onClick={onDuplicate} aria-label="Duplicate block">
              <Copy />
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={onMoveUp} aria-label="Move block up">
              ↑
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={onMoveDown} aria-label="Move block down">
              ↓
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Remove block">
              <Trash2 />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}

function PreviewPane({ preview, onCopyMarkdown, onCopyJson }: { preview?: ContextPackOutput; onCopyMarkdown: () => void; onCopyJson: () => void }) {
  return (
    <aside className="hidden min-h-0 bg-background xl:block">
      <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-col">
        <div className="border-b border-border p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Agent Prompt Pack</div>
              <div className="mt-1 text-xs text-muted-foreground">{preview?.estimatedChars || 0} estimated characters</div>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onCopyMarkdown}>
                <Clipboard />
                Markdown
              </Button>
              <Button type="button" onClick={onCopyJson}>
                <Code2 />
                JSON
              </Button>
            </div>
          </div>
          {preview?.warnings.length ? (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {preview.warnings.map((warning) => (
                <div key={warning} className="flex gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5">{preview?.markdown || "Add context blocks to build an agent prompt pack."}</pre>
        </ScrollArea>
      </div>
    </aside>
  );
}

function EmptyPack() {
  return (
    <div className="grid min-h-[360px] place-items-center rounded-md border border-dashed border-border p-6 text-center">
      <div className="max-w-sm">
        <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <h2 className="text-base font-semibold">Build a reusable context pack</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Add context blocks from the left pane, then drag to reorder and copy the generated prompt pack.</p>
      </div>
    </div>
  );
}

function LoadingShell() {
  return (
    <div className="grid min-h-screen grid-cols-[300px_minmax(0,1fr)_420px] bg-background">
      <aside className="border-r border-border bg-muted/25 p-4">
        <Skeleton className="mb-6 h-8 w-32" />
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </aside>
      <main className="space-y-4 p-5">
        <Skeleton className="h-20" />
        <Skeleton className="h-48" />
        <Skeleton className="h-64" />
      </main>
      <aside className="border-l border-border p-4">
        <Skeleton className="h-20" />
        <Separator className="my-4" />
        <Skeleton className="h-80" />
      </aside>
    </div>
  );
}

function newDraftPack(): ContextPack {
  const now = new Date().toISOString();
  return {
    id: `pack_${Date.now()}`,
    name: "New context pack",
    createdAt: now,
    updatedAt: now,
    includeRawTranscript: false,
    items: []
  };
}

function normalizePackItems(pack: ContextPack): ContextPack {
  return {
    ...pack,
    updatedAt: new Date().toISOString(),
    items: pack.items.map((item, index) => ({ ...item, order: index }))
  };
}

function filterBlocks(blocks: ContextBlock[], query: string, category: ContextBlock["category"] | "all") {
  const needle = query.trim().toLowerCase();
  return blocks
    .filter((block) => category === "all" || block.category === category)
    .filter((block) => !needle || `${block.title} ${block.text} ${block.sourceTask}`.toLowerCase().includes(needle))
    .slice(0, 120);
}

function renderLocalPreview(pack: ContextPack): ContextPackOutput {
  const normalized = {
    ...normalizePackItems(pack),
    items: normalizePackItems(pack).items.map((item) => ({
      ...item,
      block: {
        ...item.block,
        text: pack.includeRawTranscript || item.block.category !== "transcript" ? item.block.text : redactText(item.block.text),
        estimatedChars: item.block.text.length
      }
    }))
  };
  const enabledItems = normalized.items.filter((item) => item.enabled);
  const estimatedChars = enabledItems.reduce((total, item) => total + item.block.text.length, 0);
  const warnings = [
    ...(!normalized.includeRawTranscript && normalized.items.some((item) => item.block.category === "transcript") ? ["Raw transcript blocks are redacted by default."] : []),
    ...(normalized.items.some((item) => item.block.text.includes("[redacted")) ? ["Potential secrets were redacted from one or more blocks."] : [])
  ];
  const markdown = [
    `# Context Pack: ${normalized.name}`,
    "",
    `Pack ID: ${normalized.id}`,
    `Updated: ${normalized.updatedAt}`,
    `Estimated characters: ${estimatedChars}`,
    `Raw transcript: ${normalized.includeRawTranscript ? "included" : "excluded/redacted"}`,
    "",
    "## Use This Context",
    "Reuse the selected context below without re-discovering prior decisions, verification, changed files, or next actions.",
    "",
    ...(warnings.length ? ["## Warnings", ...warnings.map((warning) => `- ${warning}`), ""] : []),
    ...categoryOrder.flatMap((cat) => {
      const categoryItems = enabledItems.filter((item) => item.block.category === cat);
      if (!categoryItems.length) return [];
      return [
        `## ${labelize(cat)}`,
        ...categoryItems.flatMap((item) => [
          `- ${item.block.text}`,
          `  - Source: ${item.block.sourceTask} / ${item.block.sourceHandoffId}`,
          `  - Provenance: ${item.block.provenance.kind}, ${item.block.provenance.confidence}`
        ]),
        ""
      ];
    })
  ].join("\n").trimEnd();

  return {
    pack: normalized,
    markdown,
    json: {
      id: normalized.id,
      name: normalized.name,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      includeRawTranscript: normalized.includeRawTranscript,
      estimatedChars,
      warnings,
      items: enabledItems
    },
    estimatedChars,
    warnings
  };
}

function redactText(text: string) {
  return text
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|DSN)[A-Z0-9_]*\s*=\s*[^\s,;]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key.trim()}=[redacted]`;
    })
    .replace(/\b(?:sk|pk|rk|ghp|gho|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[redacted-token]");
}

function categoryVariant(category: ContextBlock["category"]): "outline" | "secondary" | "success" | "warning" | "destructive" | "info" {
  if (category === "decision" || category === "verification") return "success";
  if (category === "risk") return "destructive";
  if (category === "next-action" || category === "instruction") return "warning";
  if (category === "changed-file") return "info";
  return "outline";
}

function labelize(value: string) {
  return value.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
}
