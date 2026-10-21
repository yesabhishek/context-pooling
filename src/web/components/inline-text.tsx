import * as React from "react";

/** Render `code` spans the way agents write them; everything else stays plain text. */
export function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="rounded bg-muted px-1 py-px font-mono text-[0.86em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        )
      )}
    </>
  );
}
