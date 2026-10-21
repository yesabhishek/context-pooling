import * as React from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeftRight, Check, ChevronLeft, Copy, Eye, EyeOff, GripVertical, Layers, MoreHorizontal, PanelRightClose, PanelRightOpen, Plus, Search, Trash2, X } from "lucide-react";
import type { ContextBlock, ContextBlockCategory, ContextPack, ContextPackItem, HandoffListItem } from "../../types";
import { CATEGORY_ORDER, CATEGORY_TITLES, renderContextPackOutput } from "../../pack";
import { deletePack, savePack } from "@/lib/api";
import { useData } from "@/lib/data";
import { compact, plural, timeAgo } from "@/lib/format";
import { addBlocks, blockAgent, drafts, newDraft, PROVENANCE_LABELS } from "@/lib/packs";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AgentLogo, AgentStack } from "@/components/agent-logo";
import { BlockPicker } from "@/components/add-to-pack";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Card, Code, EmptyState, PageHeader, Switch } from "@/components/ui/misc";
import { useCopy, useToast } from "@/components/ui/toast";

export function PacksView({ id }: { id?: string }) {
  const { packs } = useData();

  React.useEffect(() => {
    if (id !== "new") return;
    const draft = newDraft();
    drafts.set(draft.id, draft);
    navigate(`/packs/${draft.id}`, undefined, { replace: true });
  }, [id]);

  if (!id) return <PackList />;
  if (id === "new") return null;
  const pack = packs.find((candidate) => candidate.id === id) || drafts.get(id);
  if (!pack) {
    return (
      <div className="mx-auto max-w-[960px] px-4 pt-8 sm:px-8">
        <EmptyState icon={<Layers />} title="Pack not found" action={<Button variant="secondary" onClick={() => navigate("/packs")}>See all packs</Button>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );
  }
  return <PackEditor initial={pack} saved={packs.some((candidate) => candidate.id === id)} />;
}

// ---------------------------------------------------------------------------
// List

function PackList() {
  const { packs, handoffs } = useData();
  return (
    <div className="mx-auto w-full max-w-[1160px] px-4 pb-20 pt-8 sm:px-8">
      <PageHeader
        title="Context packs"
        description="Combine the decisions, constraints, and next steps from several handoffs into one prompt you can reuse."
        actions={
          <Button variant="primary" onClick={() => navigate("/packs/new")}>
            <Plus /> New pack
          </Button>
        }
      />
      {packs.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {packs.map((pack) => {
            const output = renderContextPackOutput(pack);
            return (
              <li key={pack.id}>
                <a href={href(`/packs/${pack.id}`)} className="block h-full rounded-lg border border-border p-4 transition-colors hover:border-border-strong hover:bg-hover">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="min-w-0 truncate text-[14px] font-medium">{pack.name}</h2>
                    <AgentStack sources={pack.items.map((item) => blockAgent(item.block, handoffs))} size={14} />
                  </div>
                  <p className="mt-2 line-clamp-2 min-h-[40px] text-[13px] leading-5 text-muted-foreground">
                    {pack.items.find((item) => item.block.category === "intent" || item.block.category === "next-action")?.block.text || "No blocks yet."}
                  </p>
                  <div className="mt-3 flex items-center gap-3 text-[12px] text-faint">
                    <span>{plural(pack.items.length, "block")}</span>
                    <span>~{compact(output.estimatedTokens)} tokens</span>
                    <span className="ml-auto">Edited {timeAgo(pack.updatedAt)}</span>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong">
          <EmptyState
            icon={<Layers />}
            title="No context packs yet"
            action={
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => navigate("/packs/new")}>
                  <Plus /> New pack
                </Button>
                <Button variant="secondary" onClick={() => navigate("/handoffs")}>
                  Browse handoffs
                </Button>
              </div>
            }
          >
            A pack is a prompt built from the parts of past handoffs that still matter. Agents can also fetch packs over MCP.
          </EmptyState>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor

type SaveState = "idle" | "saving" | "saved" | "error";

function PackEditor({ initial, saved: initiallySaved }: { initial: ContextPack; saved: boolean }) {
  const { handoffs, reloadPacks } = useData();
  const notify = useToast();
  const copy = useCopy();
  const [pack, setPack] = React.useState(initial);
  const [saveState, setSaveState] = React.useState<SaveState>(initiallySaved ? "saved" : "idle");
  const [persisted, setPersisted] = React.useState(initiallySaved);
  const [adding, setAdding] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(() => window.matchMedia("(min-width: 1280px)").matches);
  const lastSaved = React.useRef(initiallySaved ? snapshot(initial) : "");
  const output = React.useMemo(() => renderContextPackOutput({ ...pack, name: pack.name || "Untitled pack" }), [pack]);

  const update = (change: (current: ContextPack) => ContextPack) =>
    setPack((current) => {
      const next = change(current);
      return { ...next, items: next.items.map((item, order) => ({ ...item, order })) };
    });

  // Autosave, once the pack has a name or content worth keeping.
  React.useEffect(() => {
    const current = snapshot(pack);
    if (current === lastSaved.current) return;
    if (!persisted && !pack.name.trim() && !pack.items.length) return;
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await savePack({ ...pack, name: pack.name.trim() || "Untitled pack" });
        lastSaved.current = current;
        drafts.delete(pack.id);
        setPersisted(true);
        setSaveState("saved");
        void reloadPacks();
      } catch {
        setSaveState("error");
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [pack, persisted, reloadPacks]);

  async function remove() {
    if (!window.confirm(`Delete “${pack.name || "Untitled pack"}”? This can’t be undone.`)) return;
    if (persisted) await deletePack(pack.id);
    drafts.delete(pack.id);
    await reloadPacks();
    notify("Pack deleted");
    navigate("/packs");
  }

  const groups = CATEGORY_ORDER.map((category) => ({ category, items: pack.items.filter((item) => item.block.category === category) })).filter((group) => group.items.length);
  const sources = pack.items.map((item) => blockAgent(item.block, handoffs));
  const handoffCount = new Set(pack.items.map((item) => item.block.sourceHandoffId)).size;

  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[820px] px-4 pb-24 pt-6 sm:px-8">
          <div className="flex items-center gap-2">
            <a href="#/packs" className="mr-auto inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
              <ChevronLeft className="size-4" /> Context packs
            </a>
            <SaveIndicator state={saveState} persisted={persisted} />
            <Button variant="secondary" size="sm" onClick={() => void copy(output.markdown, "Pack copied. Paste it into any agent.")} disabled={!output.json.items.length}>
              <Copy /> Copy
            </Button>
            <IconButton label={previewOpen ? "Hide preview" : "Show preview"} onClick={() => setPreviewOpen(!previewOpen)}>
              {previewOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </IconButton>
            <Menu trigger={({ toggle, open, ref }) => (
              <IconButton ref={ref} label="More" onClick={toggle} aria-expanded={open}>
                <MoreHorizontal />
              </IconButton>
            )}>
              {(close) => (
                <>
                  <MenuItem icon={<Copy />} onSelect={() => (close(), void copy(JSON.stringify(output.json, null, 2), "Copied as JSON"))}>
                    Copy as JSON
                  </MenuItem>
                  {persisted && (
                    <MenuItem icon={<Copy />} onSelect={() => (close(), void copy(pack.id, "Pack id copied"))}>
                      Copy pack id
                    </MenuItem>
                  )}
                  <MenuItem icon={<Trash2 className="!text-bad" />} className="text-bad" onSelect={() => (close(), void remove())}>
                    Delete pack
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>

          <input
            value={pack.name}
            onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
            placeholder="Untitled pack"
            aria-label="Pack name"
            autoFocus={!pack.name}
            className="mt-8 w-full bg-transparent text-[30px] font-semibold leading-tight tracking-[-0.025em] outline-none placeholder:text-faint"
          />
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
            <span>
              {plural(output.json.items.length, "block")} exported, ~{compact(output.estimatedTokens)} tokens
            </span>
            {handoffCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <AgentStack sources={sources} size={13} /> from {plural(handoffCount, "handoff")}
              </span>
            )}
            <Switch checked={pack.includeRawTranscript} onChange={(checked) => update((current) => ({ ...current, includeRawTranscript: checked }))} label="Include transcript" />
          </div>

          {pack.items.length > 0 && <Composition pack={pack} />}

          <div className="mt-8">
            {groups.length ? (
              <div className="space-y-8">
                {groups.map((group) => (
                  <CategoryGroup
                    key={group.category}
                    category={group.category}
                    items={group.items}
                    handoffs={handoffs}
                    withheld={!pack.includeRawTranscript && group.category === "transcript"}
                    onReorder={(from, to) => update((current) => reorder(current, group.category, from, to))}
                    onToggle={(itemId) => update((current) => ({ ...current, items: current.items.map((item) => (item.id === itemId ? { ...item, enabled: !item.enabled } : item)) }))}
                    onRemove={(itemId) => update((current) => ({ ...current, items: current.items.filter((item) => item.id !== itemId) }))}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
                <p className="text-[14px] font-medium">Start with a handoff</p>
                <p className="mx-auto mt-1 max-w-sm text-[13px] leading-5 text-muted-foreground">Pick the objective, decisions, constraints, and checks you want the next agent to know.</p>
              </div>
            )}
            <Button variant="secondary" className="mt-6" onClick={() => setAdding(true)} disabled={!handoffs.length}>
              <Plus /> Add from a handoff
            </Button>
            {!handoffs.length && <p className="mt-2 text-[12.5px] text-faint">Capture a handoff with ctxpool handoff first.</p>}
          </div>

          {persisted && (
            <p className="mt-12 border-t border-border pt-4 text-[12.5px] text-faint">
              Agents connected over MCP can read this pack with <Code>get_context_pack</Code> and id <Code>{pack.id}</Code>.
            </p>
          )}
        </div>
      </div>

      {previewOpen && <Preview markdown={output.markdown} warnings={output.warnings} onClose={() => setPreviewOpen(false)} />}
      <AddContextDialog open={adding} onClose={() => setAdding(false)} pack={pack} onAdd={(blocks) => update((current) => addBlocks(current, blocks))} />
    </div>
  );
}

function SaveIndicator({ state, persisted }: { state: SaveState; persisted: boolean }) {
  if (state === "saving") return <span className="text-[12.5px] text-faint">Saving…</span>;
  if (state === "error") return <span className="text-[12.5px] text-bad">Couldn’t save</span>;
  if (!persisted) return <span className="text-[12.5px] text-faint">Draft</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[12.5px] text-faint">
      <Check className="size-3.5" /> Saved
    </span>
  );
}

/** Where the pack's tokens go, by section. */
function Composition({ pack }: { pack: ContextPack }) {
  const rows = CATEGORY_ORDER.map((category) => {
    const items = pack.items.filter((item) => item.enabled && item.block.category === category && (pack.includeRawTranscript || category !== "transcript"));
    return { category, tokens: Math.ceil(items.reduce((sum, item) => sum + item.block.text.length + 24, 0) / 4) };
  }).filter((row) => row.tokens > 0);
  const max = Math.max(1, ...rows.map((row) => row.tokens));
  if (!rows.length) return null;
  return (
    <Card className="mt-6 p-4">
      <h2 className="text-[12.5px] font-medium text-muted-foreground">Where the tokens go</h2>
      <ul className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <li key={row.category} className="grid grid-cols-[110px_minmax(0,1fr)_52px] items-center gap-3 text-[12.5px]">
            <span className="truncate text-muted-foreground">{CATEGORY_TITLES[row.category]}</span>
            <span className="h-1.5 rounded-full bg-muted">
              <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${(row.tokens / max) * 100}%` }} />
            </span>
            <span className="tabular text-right text-muted-foreground">~{compact(row.tokens)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CategoryGroup(props: {
  category: ContextBlockCategory;
  items: ContextPackItem[];
  handoffs: HandoffListItem[];
  withheld: boolean;
  onReorder: (from: string, to: string) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }: DragEndEvent) => over && active.id !== over.id && props.onReorder(String(active.id), String(over.id));
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{CATEGORY_TITLES[props.category]}</h2>
        <span className="text-[12px] text-faint">{props.items.length}</span>
        {props.withheld && <span className="ml-auto text-[12px] text-warn">Left out of the export until you include the transcript</span>}
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={props.items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-px">
            {props.items.map((item) => (
              <PackRow key={item.id} item={item} handoffs={props.handoffs} withheld={props.withheld} onToggle={() => props.onToggle(item.id)} onRemove={() => props.onRemove(item.id)} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function PackRow({ item, handoffs, withheld, onToggle, onRemove }: { item: ContextPackItem; handoffs: HandoffListItem[]; withheld: boolean; onToggle: () => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const muted = !item.enabled || withheld;
  const handoff = handoffs.find((candidate) => candidate.id === item.block.sourceHandoffId);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group relative -mx-2 flex gap-1 rounded-md px-2 py-2 hover:bg-hover", isDragging && "z-10 bg-background shadow-lg ring-1 ring-border")}
    >
      <button {...attributes} {...listeners} aria-label="Drag to reorder" className="-ml-1 mt-0.5 flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-faint opacity-0 hover:bg-hover focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing">
        <GripVertical className="size-4" />
      </button>
      <div className={cn("min-w-0 flex-1", muted && "opacity-45")}>
        <p className={cn("whitespace-pre-wrap break-words text-[14px] leading-6", item.block.category === "changed-file" && "font-mono text-[12.5px]")}>{item.block.text}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-faint">
          <AgentLogo source={blockAgent(item.block, handoffs)} size={12} />
          {handoff ? (
            <a href={href(`/handoffs/${handoff.id}`)} className="hover:text-muted-foreground hover:underline hover:underline-offset-2">
              {item.block.sourceTask}
            </a>
          ) : (
            <span>{item.block.sourceTask}</span>
          )}
          <span>{timeAgo(item.block.sourceCreatedAt)}</span>
          <span>{PROVENANCE_LABELS[item.block.provenance.kind]}</span>
          {!item.enabled && <span className="text-muted-foreground">Excluded</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label={item.enabled ? "Exclude from export" : "Include in export"} size="icon-sm" onClick={onToggle}>
          {item.enabled ? <Eye /> : <EyeOff />}
        </IconButton>
        <IconButton label="Remove from pack" size="icon-sm" onClick={onRemove}>
          <X />
        </IconButton>
      </div>
    </li>
  );
}

function Preview({ markdown, warnings, onClose }: { markdown: string; warnings: string[]; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 xl:hidden" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col border-l border-border bg-subtle shadow-2xl xl:sticky xl:top-0 xl:z-auto xl:h-screen xl:w-[420px] xl:shadow-none">
        <div className="flex h-12 shrink-0 items-center justify-between px-4">
          <h2 className="text-[13px] font-medium">What the next agent gets</h2>
          <IconButton label="Close preview" size="icon-sm" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        {warnings.length > 0 && (
          <ul className="mx-4 mb-3 space-y-1 rounded-md border border-border bg-background px-3 py-2 text-[12.5px] leading-5 text-muted-foreground">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-4 pb-8 text-[12px] leading-[1.7] text-muted-foreground">{markdown}</pre>
      </aside>
    </>
  );
}

/** Choose a handoff, then the blocks to take from it. */
function AddContextDialog({ open, onClose, pack, onAdd }: { open: boolean; onClose: () => void; pack: ContextPack; onAdd: (blocks: ContextBlock[]) => void }) {
  const { handoffs } = useData();
  const [selected, setSelected] = React.useState<string>();
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setSelected(undefined);
      setQuery("");
    }
  }, [open]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = handoffs.filter((handoff) => words.every((word) => `${handoff.title || ""} ${handoff.task} ${handoff.repoName} ${handoff.nextAction}`.toLowerCase().includes(word))).slice(0, 60);
  const chosen = handoffs.find((handoff) => handoff.id === selected);

  return (
    <Dialog open={open} onClose={onClose} label="Add from a handoff" className="max-w-2xl">
      {chosen ? (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <IconButton label="Back to handoffs" size="icon-sm" onClick={() => setSelected(undefined)}>
              <ChevronLeft />
            </IconButton>
            <AgentLogo source={chosen.source} size={16} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{chosen.title || chosen.task}</span>
            <span className="shrink-0 text-[12px] text-faint">{timeAgo(chosen.createdAt)}</span>
          </div>
          <BlockPicker
            handoffId={chosen.id}
            existing={pack}
            onCancel={onClose}
            onAdd={(blocks) => {
              onAdd(blocks);
              onClose();
            }}
          />
        </>
      ) : (
        <>
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-faint" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a handoff" aria-label="Find a handoff" className="h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-faint" />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {visible.map((handoff) => (
              <li key={handoff.id}>
                <button onClick={() => setSelected(handoff.id)} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover">
                  <AgentLogo source={handoff.source} size={18} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px]">{handoff.title || handoff.task}</span>
                    <span className="block truncate text-[12px] text-faint">{handoff.nextAction}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-faint">{timeAgo(handoff.createdAt)}</span>
                </button>
              </li>
            ))}
            {!visible.length && (
              <li className="flex flex-col items-center gap-1 px-3 py-10 text-center text-[13px] text-faint">
                <ArrowLeftRight className="size-4" />
                No handoffs match.
              </li>
            )}
          </ul>
        </>
      )}
    </Dialog>
  );
}

function reorder(pack: ContextPack, category: ContextBlockCategory, fromId: string, toId: string): ContextPack {
  const inCategory = pack.items.filter((item) => item.block.category === category);
  const from = inCategory.findIndex((item) => item.id === fromId);
  const to = inCategory.findIndex((item) => item.id === toId);
  if (from < 0 || to < 0) return pack;
  const moved = arrayMove(inCategory, from, to);
  let index = 0;
  return { ...pack, items: pack.items.map((item) => (item.block.category === category ? moved[index++] : item)) };
}

function snapshot(pack: ContextPack): string {
  return JSON.stringify([pack.name, pack.includeRawTranscript, pack.items.map((item) => [item.blockId, item.enabled])]);
}
