import React, { useMemo } from "react";
import { MENTION_REGEX } from "@/lib/mentions";

interface MentionRendererProps {
  content: string;
  className?: string;
}

/**
 * Renders content with @mention tokens as styled inline pills.
 * Mention format: @[Display Name](teamMemberId)
 */
export function MentionRenderer({ content, className }: MentionRendererProps) {
  const parts = useMemo(() => {
    const result: Array<{ type: "text"; value: string } | { type: "mention"; name: string }> = [];
    let lastIndex = 0;
    const regex = new RegExp(MENTION_REGEX.source, "g");
    let match;

    while ((match = regex.exec(content)) !== null) {
      // Add text before the mention
      if (match.index > lastIndex) {
        result.push({ type: "text", value: content.slice(lastIndex, match.index) });
      }
      result.push({ type: "mention", name: match[1] });
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      result.push({ type: "text", value: content.slice(lastIndex) });
    }

    return result;
  }, [content]);

  // If no mentions found, render as plain text
  if (parts.length === 1 && parts[0].type === "text") {
    return <p className={className}>{content}</p>;
  }

  return (
    <p className={className}>
      {parts.map((part, i) =>
        part.type === "mention" ? (
          <span
            key={i}
            className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-brand-500/15 text-brand-400 font-medium text-[0.9em]"
          >
            @{part.name}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}
