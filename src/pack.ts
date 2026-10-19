// Context-pack logic shared by the server and the web UI. Keep this module free of Node imports.
import type { ContextBlock, ContextBlockCategory, ContextPack, ContextPackItem, ContextPackOutput } from "./types.js";
import { hasRedactions, redactSecrets } from "./redact.js";
import { estimateTokens, formatTokens, labelize } from "./text.js";

export const CATEGORY_ORDER: ContextBlockCategory[] = [
  "intent",
  "instruction",
  "next-action",
  "decision",
  "constraint",
  "verification",
  "risk",
  "changed-file",
  "transcript"
];

export const CATEGORY_TITLES: Record<ContextBlockCategory, string> = {
  intent: "Intent",
  instruction: "Instructions",
  "next-action": "Next actions",
  decision: "Decisions",
  constraint: "Constraints",
  verification: "Verification",
  risk: "Risks",
  "changed-file": "Changed files",
  transcript: "Transcript"
};

export function createContextPack(name: string, blocks: ContextBlock[] = [], options: { includeRawTranscript?: boolean; now?: string } = {}): ContextPack {
  const now = options.now || new Date().toISOString();
  const id = `pack_${shortHash(`${name}:${now}:${Math.random()}`)}`;
  return {
    id,
    name: name.trim() || "Untitled pack",
    createdAt: now,
    updatedAt: now,
    includeRawTranscript: options.includeRawTranscript === true,
    items: blocks.map((block, index) => packItem(block, index, id))
  };
}

export function packItem(block: ContextBlock, order: number, seed = ""): ContextPackItem {
  return { id: `item_${shortHash(`${seed}:${block.id}:${order}:${Math.random()}`)}`, blockId: block.id, block, order, enabled: true };
}

export function normalizeContextPack(pack: ContextPack): ContextPack {
  return {
    ...pack,
    includeRawTranscript: pack.includeRawTranscript === true,
    name: pack.name.trim() || "Untitled pack",
    items: pack.items
      .map((item, index) => ({
        ...item,
        order: Number.isFinite(item.order) ? item.order : index,
        enabled: item.enabled !== false,
        block: { ...item.block, text: redactSecrets(item.block.text), estimatedChars: item.block.text.length }
      }))
      .sort((a, b) => a.order - b.order)
      .map((item, index) => ({ ...item, order: index }))
  };
}

/**
 * Render the agent-ready prompt for a pack. Transcript blocks are left out unless the pack opts in,
 * so a pack can be shared without leaking raw conversation.
 */
export function renderContextPackOutput(pack: ContextPack): ContextPackOutput {
  const normalized = normalizeContextPack(pack);
  const enabled = normalized.items.filter((item) => item.enabled);
  const exported = enabled.filter((item) => normalized.includeRawTranscript || item.block.category !== "transcript");
  const withheld = enabled.length - exported.length;

  const warnings: string[] = [];
  if (withheld) warnings.push(`${withheld} transcript ${withheld === 1 ? "block is" : "blocks are"} left out. Turn on “Include transcript” to export ${withheld === 1 ? "it" : "them"}.`);
  if (exported.some((item) => hasRedactions(item.block.text))) warnings.push("Possible secrets were redacted.");
  if (!exported.length) warnings.push("Nothing to export yet. Add or enable blocks.");

  const body = renderBody(exported);
  const estimatedChars = body.length;
  const estimatedTokens = estimateTokens(body);
  const header = [
    `# Context: ${normalized.name}`,
    "",
    `${exported.length} ${exported.length === 1 ? "block" : "blocks"} · ~${formatTokens(estimatedTokens)} tokens · transcript ${normalized.includeRawTranscript ? "included" : "excluded"}`,
    "",
    "Use this context to continue the work without re-deriving earlier decisions, checks, or next steps."
  ];
  const markdown = [...header, ...(body ? ["", body] : [])].join("\n");

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
      estimatedTokens,
      warnings,
      items: exported
    },
    estimatedChars,
    estimatedTokens,
    warnings
  };
}

function renderBody(items: ContextPackItem[]): string {
  const sections: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const inCategory = items.filter((item) => item.block.category === category);
    if (!inCategory.length) continue;
    sections.push(
      [`## ${CATEGORY_TITLES[category] || labelize(category)}`, ...inCategory.map((item) => `- ${item.block.text} _(${item.block.sourceTask}, ${item.block.provenance.kind})_`)].join("\n")
    );
  }
  return sections.join("\n\n");
}

/** FNV-1a, enough for collision-resistant local ids without a crypto dependency. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + Date.now().toString(36);
}
