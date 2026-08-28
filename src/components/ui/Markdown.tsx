import { memo, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  parseMarkdown,
  type BlockNode,
  type InlineNode,
  type TableAlign,
} from "@/lib/markdown";
import { cn } from "@/lib/utils";

/**
 * Renderiza Markdown como elementos React (nunca HTML cru) com os tokens do
 * tema. Pensado para a saída de LLM no chat: tabela rola na horizontal em vez
 * de espremer o painel, e bloco de código tem botão de copiar.
 */
export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  return (
    <div className={cn("space-y-2.5 break-words", className)}>
      {blocks.map((block, i) => (
        <Block key={i} node={block} />
      ))}
    </div>
  );
});

const HEADING_CLASSES: Record<number, string> = {
  1: "text-base font-semibold text-text-primary",
  2: "text-base font-semibold text-text-primary",
  3: "text-sm font-semibold text-text-primary",
  4: "text-sm font-semibold text-text-secondary",
  5: "text-xs font-semibold uppercase tracking-wide text-text-secondary",
  6: "text-xs font-semibold uppercase tracking-wide text-text-muted",
};

function Block({ node }: { node: BlockNode }) {
  switch (node.type) {
    case "paragraph":
      return (
        <p className="leading-relaxed">
          <Inlines nodes={node.children} />
        </p>
      );

    case "heading": {
      const Tag = (`h${Math.min(node.level + 2, 6)}` as "h3");
      return (
        <Tag className={cn("mt-1 first:mt-0", HEADING_CLASSES[node.level])}>
          <Inlines nodes={node.children} />
        </Tag>
      );
    }

    case "codeBlock":
      return <CodeBlock lang={node.lang} value={node.value} />;

    case "list":
      return <List node={node} />;

    case "table":
      return <Table node={node} />;

    case "blockquote":
      return (
        <blockquote className="border-l-2 border-brand-500/60 pl-3 text-text-secondary space-y-2">
          {node.children.map((child, i) => (
            <Block key={i} node={child} />
          ))}
        </blockquote>
      );

    case "hr":
      return <hr className="border-border" />;
  }
}

function List({ node }: { node: Extract<BlockNode, { type: "list" }> }) {
  const Tag = node.ordered ? "ol" : "ul";
  return (
    <Tag
      start={node.ordered && node.start !== 1 ? node.start : undefined}
      className={cn(
        "space-y-1 pl-5 marker:text-text-muted",
        node.ordered ? "list-decimal" : "list-disc"
      )}
    >
      {node.items.map((blocks, i) => (
        <li key={i} className="leading-relaxed [&>ul]:mt-1 [&>ol]:mt-1">
          {/* Item de uma linha só não ganha <p> — evita respiro extra na lista */}
          {blocks.length === 1 && blocks[0].type === "paragraph" ? (
            <Inlines nodes={blocks[0].children} />
          ) : (
            <div className="space-y-2">
              {blocks.map((block, j) => (
                <Block key={j} node={block} />
              ))}
            </div>
          )}
        </li>
      ))}
    </Tag>
  );
}

const ALIGN_CLASS: Record<Exclude<TableAlign, null>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function Table({ node }: { node: Extract<BlockNode, { type: "table" }> }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface-base/40">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-surface-sunken">
            {node.header.map((cell, i) => (
              <th
                key={i}
                className={cn(
                  "whitespace-nowrap border-b border-border px-2.5 py-2 font-semibold text-text-secondary",
                  ALIGN_CLASS[node.align[i] ?? "left"]
                )}
              >
                <Inlines nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row, r) => (
            <tr key={r} className="even:bg-surface-overlay/40">
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={cn(
                    "whitespace-nowrap border-b border-border/50 px-2.5 py-1.5 text-text-primary",
                    ALIGN_CLASS[node.align[c] ?? "left"]
                  )}
                >
                  <Inlines nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ lang, value }: { lang: string | null; value: string }) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-surface-sunken">
      {lang && (
        <div className="border-b border-border px-3 py-1 font-mono text-[11px] text-text-muted">
          {lang}
        </div>
      )}
      <pre className="overflow-x-auto p-3">
        <code className="font-mono text-xs leading-relaxed text-text-secondary">
          {value}
        </code>
      </pre>
      <CopyButton
        text={value}
        label="Copiar código"
        className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
      />
    </div>
  );
}

export function CopyButton({
  text,
  label = "Copiar",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md border border-border bg-surface-raised p-1.5 text-text-muted transition-colors hover:text-text-primary",
        className
      )}
    >
      {copied ? (
        <Check size={13} className="text-semantic-success" />
      ) : (
        <Copy size={13} />
      )}
    </button>
  );
}

function Inlines({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        <Inline key={i} node={node} />
      ))}
    </>
  );
}

function Inline({ node }: { node: InlineNode }) {
  switch (node.type) {
    case "text":
      return <>{node.value}</>;

    case "break":
      return <br />;

    case "strong":
      return (
        <strong className="font-semibold text-text-primary">
          <Inlines nodes={node.children} />
        </strong>
      );

    case "em":
      return (
        <em className="italic">
          <Inlines nodes={node.children} />
        </em>
      );

    case "del":
      return (
        <del className="text-text-muted line-through">
          <Inlines nodes={node.children} />
        </del>
      );

    case "codeSpan":
      return (
        <code className="rounded border border-border/70 bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em] text-text-primary">
          {node.value}
        </code>
      );

    case "link":
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-brand-400 underline underline-offset-2 hover:text-brand-300"
        >
          <Inlines nodes={node.children} />
        </a>
      );
  }
}
