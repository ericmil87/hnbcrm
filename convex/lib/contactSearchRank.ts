/**
 * Regras puras da busca de Conversas por contato
 * (`conversations.searchConversationsByContact`).
 */

/** Termo com cara de telefone: só dígitos e pontuação de número, com 8+ dígitos. */
export function phoneLikeDigits(term: string): string | null {
  const trimmed = term.trim();
  if (!/^[\d\s()+\-.]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function words(text: string): string[] {
  return fold(text).split(/[^a-z0-9@._-]+/).filter(Boolean);
}

/**
 * O contato casou pelo que identifica a pessoa (nome, telefone, e-mail,
 * empresa, @ do Instagram) e não só por cidade/bio/setor/cargo. Cada palavra
 * do termo precisa ser prefixo de alguma palavra desses campos (o índice de
 * busca casa assim); telefone compara por dígitos contidos.
 */
export function matchesIdentity(
  contact: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    whatsappNumber?: string;
    company?: string;
    instagramUsername?: string;
  },
  term: string
): boolean {
  const termWords = words(term);
  if (termWords.length === 0) return false;
  const pool = words(
    [contact.firstName, contact.lastName, contact.email, contact.company, contact.instagramUsername]
      .filter(Boolean)
      .join(" ")
  );
  const phones = [contact.phone, contact.whatsappNumber]
    .filter(Boolean)
    .map((p) => (p as string).replace(/\D/g, ""));
  return termWords.every((tw) => {
    if (pool.some((w) => w.startsWith(tw))) return true;
    const digits = tw.replace(/\D/g, "");
    return digits.length >= 2 && digits === tw && phones.some((p) => p.includes(digits));
  });
}

/**
 * Ordem final dos contatos: os achados pelo telefone exato primeiro, depois
 * os que casaram pela identidade, depois o resto (só cidade/bio/setor…),
 * mantendo a relevância do índice dentro de cada grupo e sem repetir.
 */
export function rankContacts<C extends { _id: string }>(
  exactPhone: readonly C[],
  searched: readonly C[],
  isIdentityMatch: (c: C) => boolean
): C[] {
  const seen = new Set<string>();
  const out: C[] = [];
  const push = (c: C) => {
    if (seen.has(c._id)) return;
    seen.add(c._id);
    out.push(c);
  };
  exactPhone.forEach(push);
  searched.filter(isIdentityMatch).forEach(push);
  searched.forEach(push);
  return out;
}

/** Nome de reserva para contato sem nome: @ do Instagram, senão título do lead. */
export function contactFallbackName(
  contact: { instagramUsername?: string },
  leadTitle: string | undefined
): string | null {
  const ig = contact.instagramUsername?.trim().replace(/^@/, "");
  if (ig) return `@${ig}`;
  const title = leadTitle?.trim();
  return title ? title : null;
}
