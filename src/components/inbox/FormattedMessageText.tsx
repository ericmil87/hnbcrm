import { memo, useMemo, type ReactNode } from "react";
import { parseWhatsApp, type WaInlineNode } from "@/lib/whatsappFormat";
import { cn } from "@/lib/utils";

/**
 * Texto de bolha com a formatação do WhatsApp (*negrito*, _itálico_,
 * ~riscado~, `mono`, ```bloco```), URL solta como link e quebra de linha —
 * o que o cliente vê no celular. Mesmo parser do preview de campanhas
 * (`lib/whatsappFormat.ts`), elementos React, nunca HTML cru. As cores do link
 * seguem a bolha do inbox (laranja na saída, superfície escura na entrada).
 */
export const FormattedMessageText = memo(function FormattedMessageText({
  text,
  variant,
  className,
}: {
  text: string;
  variant: "inbound" | "outbound";
  className?: string;
}) {
  const nodes = useMemo(() => parseWhatsApp(text), [text]);
  return <p className={cn("whitespace-pre-wrap break-words", className)}>{renderNodes(nodes, variant)}</p>;
});

function renderNodes(nodes: WaInlineNode[], variant: "inbound" | "outbound"): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "break":
        return <br key={i} />;
      case "bold":
        return <strong key={i} className="font-semibold">{renderNodes(node.children, variant)}</strong>;
      case "italic":
        return <em key={i}>{renderNodes(node.children, variant)}</em>;
      case "strike":
        return <s key={i}>{renderNodes(node.children, variant)}</s>;
      case "code":
        return (
          <code key={i} className="font-mono text-[0.92em]">
            {node.value}
          </code>
        );
      case "codeBlock":
        return (
          <code
            key={i}
            className={cn(
              "my-1 block whitespace-pre-wrap rounded-md px-2 py-1.5 font-mono text-[0.92em]",
              variant === "outbound" ? "bg-black/15" : "bg-surface-sunken"
            )}
          >
            {node.value}
          </code>
        );
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "break-all underline underline-offset-2",
              variant === "outbound" ? "text-white hover:text-white/80" : "text-brand-400 hover:text-brand-500"
            )}
          >
            {node.href}
          </a>
        );
      default:
        return null;
    }
  });
}
