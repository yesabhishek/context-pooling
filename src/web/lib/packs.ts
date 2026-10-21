import type { ContextBlock, ContextPack, HandoffListItem, SourceAgent } from "../../types";
import { packItem } from "../../pack";
import { AGENT_ORDER } from "./agents";

/** Unsaved packs, so a new pack keeps its id across the redirect from /packs/new. */
export const drafts = new Map<string, ContextPack>();

export function newDraft(name = ""): ContextPack {
  const now = new Date().toISOString();
  return { id: `pack_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, name, createdAt: now, updatedAt: now, includeRawTranscript: false, items: [] };
}

/** Append blocks that aren't in the pack yet. */
export function addBlocks(pack: ContextPack, blocks: ContextBlock[]): ContextPack {
  const present = new Set(pack.items.map((item) => item.blockId));
  const fresh = blocks.filter((block) => !present.has(block.id));
  return { ...pack, items: [...pack.items, ...fresh.map((block, index) => packItem(block, pack.items.length + index, pack.id))].map((item, order) => ({ ...item, order })) };
}

export function blockAgent(block: ContextBlock, handoffs: HandoffListItem[]): SourceAgent | undefined {
  const handoff = handoffs.find((candidate) => candidate.id === block.sourceHandoffId);
  if (handoff) return handoff.source;
  const prefix = block.provenance.source.split(":")[0];
  return (AGENT_ORDER as string[]).includes(prefix) ? (prefix as SourceAgent) : undefined;
}

export const PROVENANCE_LABELS: Record<ContextBlock["provenance"]["kind"], string> = {
  "user-authored": "You wrote this",
  "transcript-derived": "From the conversation",
  "diff-derived": "From the git diff",
  "command-derived": "From command results",
  "ai-inferred": "Inferred"
};
