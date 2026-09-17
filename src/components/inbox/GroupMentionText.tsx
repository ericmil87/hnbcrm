import { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * Texto de mensagem de grupo com as menções em negrito.
 *
 * O WhatsApp não marca a menção dentro do texto: ela viaja em
 * `ContextInfo.MentionedJID` (em `messages.mentions`) e o corpo traz só
 * "@558181392929" — ou "@Eric", quando quem escreveu digitou o nome. Por isso
 * a marcação é feita por TOKEN: o chamador resolve os JIDs mencionados nos
 * rótulos possíveis (dígitos do telefone, dígitos do LID, nome do membro) e
 * aqui só se procura "@" + um desses rótulos.
 *
 * Nada de regex montada com o conteúdo: o texto vem de terceiros e uma regex
 * derivada dele seria entrada não-confiável virando código.
 */
export function GroupMentionText({
  text,
  tokens,
  className,
}: {
  text: string;
  tokens: string[];
  className?: string;
}) {
  if (!text) return null;
  if (tokens.length === 0) {
    return <p className={cn("text-sm whitespace-pre-wrap break-words", className)}>{text}</p>;
  }

  // Do mais longo para o mais curto: "@Eric Milfont" tem de vencer "@Eric".
  const ordered = [...new Set(tokens.filter(Boolean))].sort((a, b) => b.length - a.length);
  const lowerText = text.toLowerCase();

  const parts: { text: string; mention: boolean }[] = [];
  let cursor = 0;
  let plainStart = 0;

  while (cursor < text.length) {
    if (text[cursor] !== "@") {
      cursor += 1;
      continue;
    }
    const match = ordered.find((token) =>
      lowerText.startsWith(token.toLowerCase(), cursor + 1)
    );
    if (!match) {
      cursor += 1;
      continue;
    }
    if (cursor > plainStart) parts.push({ text: text.slice(plainStart, cursor), mention: false });
    parts.push({ text: text.slice(cursor, cursor + 1 + match.length), mention: true });
    cursor += 1 + match.length;
    plainStart = cursor;
  }
  if (plainStart < text.length) parts.push({ text: text.slice(plainStart), mention: false });

  return (
    <p className={cn("text-sm whitespace-pre-wrap break-words", className)}>
      {parts.map((part, index) =>
        part.mention ? (
          <strong key={index} className="font-semibold underline decoration-current underline-offset-2">
            {part.text}
          </strong>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        )
      )}
    </p>
  );
}

/**
 * Rótulos que podem aparecer depois do "@" para um conjunto de JIDs
 * mencionados. Um JID "558181392929@s.whatsapp.net" vira "558181392929";
 * um "@lid" vira os dígitos do LID; e, quando o membro é conhecido, o nome
 * entra junto (quem escreve pelo CRM digita "@Fulano", não o número).
 */
export function mentionTokensFor(
  mentions: string[] | undefined,
  nameByKey: Map<string, string>
): string[] {
  if (!mentions || mentions.length === 0) return [];
  const tokens: string[] = [];
  for (const jid of mentions) {
    if (typeof jid !== "string" || jid.length === 0) continue;
    const user = jid.split("@")[0].split(":")[0];
    if (user) tokens.push(user);
    const name = nameByKey.get(jid) ?? nameByKey.get(user);
    if (name) tokens.push(name);
  }
  return tokens;
}
