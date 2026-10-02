/**
 * Regras puras da edição rápida do nome do contato (inbox e painel do lead).
 *
 * O ingest do WhatsApp grava o PushName em `firstName`; quando o contato não
 * tem PushName, o lead nasce com o telefone cru como título. Ao dar nome ao
 * contato, o título do lead acompanha — mas só quando ainda é um título
 * "automático" (telefone, vazio, "Sem nome" ou o nome antigo). Título que a
 * equipe escreveu à mão ("Retiro de março — Ana") nunca é sobrescrito.
 */

export function normalizeFullName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Primeira palavra → firstName, o resto → lastName ("" se só uma palavra). */
export function splitFullName(name: string): { firstName: string; lastName: string } {
  const normalized = normalizeFullName(name);
  if (!normalized) return { firstName: "", lastName: "" };
  const space = normalized.indexOf(" ");
  if (space === -1) return { firstName: normalized, lastName: "" };
  return { firstName: normalized.slice(0, space), lastName: normalized.slice(space + 1) };
}

export function joinContactName(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string {
  return normalizeFullName(`${firstName ?? ""} ${lastName ?? ""}`);
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

/** Só dígitos, `+`, espaços e a pontuação usual de telefone — e ao menos 8 dígitos. */
function looksLikePhone(value: string): boolean {
  return /^[\d+\s().-]+$/.test(value) && digitsOf(value).length >= 8;
}

/**
 * O título do lead deve seguir o nome novo do contato?
 * `contactPhone` aceita um ou mais números (telefone e WhatsApp do contato).
 */
export function shouldSyncLeadTitle(
  leadTitle: string | null | undefined,
  contactPhone: string | null | undefined | ReadonlyArray<string | null | undefined>,
  oldContactName: string | null | undefined
): boolean {
  const title = normalizeFullName(leadTitle ?? "");
  if (!title) return true;
  if (title.toLowerCase() === "sem nome") return true;

  const oldName = normalizeFullName(oldContactName ?? "");
  if (oldName && title.toLowerCase() === oldName.toLowerCase()) return true;

  if (looksLikePhone(title)) return true;

  // Título com texto em volta do número ("WhatsApp 5585999999999",
  // "+55 85 9999-9999 (cliente)"): automático se os dígitos do título são os
  // do telefone do contato.
  const phones = (Array.isArray(contactPhone) ? contactPhone : [contactPhone]) as Array<
    string | null | undefined
  >;
  const titleDigits = digitsOf(title);
  if (titleDigits.length < 8) return false;
  return phones.some((phone) => (phone ? digitsOf(phone) === titleDigits : false));
}

/**
 * Args de `contacts.updateContact` para o nome novo. `lastName: ""` só é
 * mandado quando havia sobrenome antes (o `diffChanges` do servidor trata
 * `undefined` como "não mexer" — sem isso "Ana Souza" → "Ana" manteria o
 * "Souza").
 */
export function contactNameUpdate(
  newName: string,
  previous: { firstName?: string | null; lastName?: string | null }
): { firstName: string; lastName?: string } | null {
  const { firstName, lastName } = splitFullName(newName);
  if (!firstName) return null;
  if (lastName) return { firstName, lastName };
  return previous.lastName ? { firstName, lastName: "" } : { firstName };
}
