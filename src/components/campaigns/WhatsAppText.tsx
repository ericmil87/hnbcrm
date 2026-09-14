import { memo, useMemo, type ReactNode } from "react";
import { parseWhatsApp, type WaInlineNode } from "@/lib/whatsappFormat";
import { cn } from "@/lib/utils";

/**
 * Renderiza texto com a formatação do WhatsApp como elementos React — nunca
 * HTML cru. `tone` controla a cor do link para ler bem na bolha verde.
 */
export const WhatsAppText = memo(function WhatsAppText({
  text,
  className,
  tone = "outbound",
}: {
  text: string;
  className?: string;
  tone?: "outbound" | "inbound";
}) {
  const nodes = useMemo(() => parseWhatsApp(text), [text]);
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {renderNodes(nodes, tone)}
    </span>
  );
});

function renderNodes(nodes: WaInlineNode[], tone: "outbound" | "inbound"): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "break":
        return <br key={i} />;
      case "bold":
        return <strong key={i}>{renderNodes(node.children, tone)}</strong>;
      case "italic":
        return <em key={i}>{renderNodes(node.children, tone)}</em>;
      case "strike":
        return <s key={i}>{renderNodes(node.children, tone)}</s>;
      case "code":
        return (
          <code key={i} className="font-mono text-[0.92em]">
            {node.value}
          </code>
        );
      case "codeBlock":
        return (
          <code key={i} className="block font-mono text-[0.92em] whitespace-pre-wrap">
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
            className={cn(
              "underline break-all",
              tone === "outbound" ? "text-[#53bdeb]" : "text-[#027eb5]"
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
