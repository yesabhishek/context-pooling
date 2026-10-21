import * as React from "react";
import { Check, ChevronDown, Layers, Plus } from "lucide-react";
import type { ContextBlock, ContextBlockCategory, ContextPack, HandoffListItem } from "../../types";
import { CATEGORY_ORDER, CATEGORY_TITLES } from "../../pack";
import { fetchBlocks, savePack } from "@/lib/api";
import { useData } from "@/lib/data";
import { addBlocks, newDraft } from "@/lib/packs";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AgentLogo } from "@/components/agent-logo";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";

/** Pick blocks from one handoff and add them to a new or existing pack. */
export function AddToPackDialog({ open, onClose, handoff }: { open: boolean; onClose: () => void; handoff: HandoffListItem }) {
  const { packs, reloadPacks } = useData();
  const notify = useToast();
  const [target, setTarget] = React.useState<string>("new");
  const [saving, setSaving] = React.useState(false);
  const close = React.useCallback(() => !saving && onClose(), [saving, onClose]);

  async function add(blocks: ContextBlock[]) {
    setSaving(true);
    try {
      const existing = packs.find((pack) => pack.id === target);
      const base = existing || newDraft(handoff.title || handoff.task);
      const saved = await savePack(addBlocks(base, blocks));
      await reloadPacks();
      notify(`Added ${blocks.length} ${blocks.length === 1 ? "block" : "blocks"} to ${saved.name}`);
      onClose();
      navigate(`/packs/${saved.id}`);
    } catch (saveError) {
      notify(saveError instanceof Error ? saveError.message : "Couldn’t save the pack");
    } finally {
      setSaving(false);
    }
  }

  const targetPack = packs.find((pack) => pack.id === target);
  return (
    <Dialog open={open} onClose={close} label="Add to context pack" className="max-w-2xl">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <AgentLogo source={handoff.source} size={18} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-medium">Add to a context pack</h2>
          <p className="truncate text-[12.5px] text-muted-foreground">From {handoff.title || handoff.task}</p>
        </div>
        <Menu
          trigger={({ toggle, open: menuOpen, ref }) => (
            <Button ref={ref} variant="secondary" size="sm" onClick={toggle} aria-expanded={menuOpen} aria-haspopup="menu">
              <Layers className="text-faint" />
              <span className="max-w-[160px] truncate">{targetPack ? targetPack.name : "New pack"}</span>
              <ChevronDown className="text-faint" />
            </Button>
          )}
        >
          {(closeMenu) => (
            <>
              <MenuItem icon={target === "new" ? <Check /> : <Plus />} onSelect={() => (closeMenu(), setTarget("new"))}>
                New pack
              </MenuItem>
              {packs.length > 0 && <MenuSeparator />}
              {packs.map((pack) => (
                <MenuItem key={pack.id} icon={target === pack.id ? <Check /> : <span className="size-4" />} hint={pack.items.length} onSelect={() => (closeMenu(), setTarget(pack.id))}>
                  <span className="block truncate">{pack.name}</span>
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
      </div>
      {open && <BlockPicker handoffId={handoff.id} existing={targetPack} busy={saving} onCancel={close} onAdd={(blocks) => void add(blocks)} />}
    </Dialog>
  );
}

/** Blocks from a handoff, grouped the way they export, with transcript lines off by default. */
export function BlockPicker({ handoffId, existing, busy, onCancel, onAdd }: { handoffId: string; existing?: ContextPack; busy?: boolean; onCancel: () => void; onAdd: (blocks: ContextBlock[]) => void }) {
  const [blocks, setBlocks] = React.useState<ContextBlock[]>();
  const [error, setError] = React.useState<string>();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const present = React.useMemo(() => new Set(existing?.items.map((item) => item.blockId)), [existing]);

  React.useEffect(() => {
    let live = true;
    setBlocks(undefined);
    fetchBlocks(handoffId).then(
      (next) => {
        if (!live) return;
        setBlocks(next);
        setSelected(new Set(next.filter((block) => block.category !== "transcript" && block.category !== "changed-file").map((block) => block.id)));
      },
      (loadError: unknown) => live && setError(loadError instanceof Error ? loadError.message : "Couldn’t load blocks")
    );
    return () => {
      live = false;
    };
  }, [handoffId]);

  const groups = React.useMemo(() => CATEGORY_ORDER.map((category) => ({ category, blocks: (blocks || []).filter((block) => block.category === category) })).filter((group) => group.blocks.length), [blocks]);
  const choosable = (block: ContextBlock) => !present.has(block.id);
  const picked = (blocks || []).filter((block) => selected.has(block.id) && choosable(block));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleGroup = (category: ContextBlockCategory, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const block of blocks || []) if (block.category === category) (on ? next.add(block.id) : next.delete(block.id));
      return next;
    });

  return (
    <>
      <div className="min-h-[240px] flex-1 overflow-y-auto px-2 py-2">
        {error && <p className="px-3 py-10 text-center text-[13px] text-bad">{error}</p>}
        {!blocks && !error && (
          <div className="grid h-40 place-items-center">
            <Spinner />
          </div>
        )}
        {groups.map((group) => {
          const all = group.blocks.filter(choosable).every((block) => selected.has(block.id));
          return (
            <section key={group.category} className="mb-2">
              <div className="flex items-center justify-between px-2 py-1.5">
                <h3 className="text-[12.5px] font-medium text-muted-foreground">
                  {CATEGORY_TITLES[group.category]} <span className="text-faint">{group.blocks.length}</span>
                </h3>
                <button onClick={() => toggleGroup(group.category, !all)} className="text-[12px] text-faint hover:text-foreground">
                  {all ? "Select none" : "Select all"}
                </button>
              </div>
              <ul>
                {group.blocks.map((block) => {
                  const inPack = present.has(block.id);
                  const checked = inPack || selected.has(block.id);
                  return (
                    <li key={block.id}>
                      <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover", inPack && "cursor-default opacity-60")}>
                        <input type="checkbox" className="mt-[3px] size-3.5 shrink-0 accent-[var(--ink)]" checked={checked} disabled={inPack} onChange={() => toggle(block.id)} />
                        <span className={cn("min-w-0 flex-1 text-[13px] leading-5", block.category === "changed-file" && "font-mono text-[12px]")}>
                          <span className="line-clamp-3 break-words">{block.text}</span>
                          {inPack && <span className="text-[11.5px] text-faint">Already in this pack</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-[12.5px] text-muted-foreground">{picked.length} selected</span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!picked.length || busy} onClick={() => onAdd(picked)}>
            {busy ? <Spinner className="size-3.5 border-ink-foreground/40 border-t-ink-foreground" /> : <Plus />} Add {picked.length || ""} {picked.length === 1 ? "block" : "blocks"}
          </Button>
        </div>
      </div>
    </>
  );
}
