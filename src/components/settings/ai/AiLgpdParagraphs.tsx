import { AI_LGPD_PARAGRAPHS } from "@/lib/aiLgpdText";

/** Parágrafos do aceite de IA/LGPD (texto em `lib/aiLgpdText.ts`, fonte única). */
export function AiLgpdParagraphs({ className = "text-sm text-text-secondary" }: { className?: string }) {
  return (
    <>
      {AI_LGPD_PARAGRAPHS.map((parts, i) => (
        <p key={i} className={className}>
          {parts.map((part, j) => (typeof part === "string" ? part : <strong key={j}>{part.strong}</strong>))}
        </p>
      ))}
    </>
  );
}
