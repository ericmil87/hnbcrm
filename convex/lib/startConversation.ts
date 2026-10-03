/**
 * "Nova conversa" (inbox): regras PURAS compartilhadas entre a query de prévia,
 * a mutation e os testes. Nada aqui toca o banco.
 */
import { normalizeCampaignPhone } from "./phone";
import { phoneFromJid } from "./bridgeSession";

export type StartConversationProvider = "meta" | "bridge";

/**
 * A primeira mensagem pode ser texto livre? Só no bridge. Na Cloud API (Meta)
 * uma conversa NOVA está sempre fora da janela de 24 h de atendimento — o
 * contato não escreveu nada ainda —, então a abertura só pode ser template.
 */
export function canSendFreeTextOnStart(provider: StartConversationProvider): boolean {
  return provider === "bridge";
}

export const META_FREE_TEXT_ERROR =
  "Canal oficial: a conversa será aberta, mas a primeira mensagem precisa ser um template (envie pelo composer)";

/** Prefixo estável que a UI usa para trocar o erro pelo fluxo de aceite. */
export const OPT_OUT_ERROR_PREFIX = "OPT_OUT:";

export type ResolvedStartPhone =
  | { ok: true; phone: string }
  | { ok: false; error: string };

/** Normaliza o telefone digitado (E.164 sem "+", Brasil por padrão). */
export function resolveStartPhone(raw: string | undefined | null): ResolvedStartPhone {
  const n = normalizeCampaignPhone(String(raw ?? ""));
  if (n.ok) return { ok: true, phone: n.phone };
  switch (n.reason) {
    case "empty":
      return { ok: false, error: "Informe o telefone do contato" };
    case "too_short":
      return { ok: false, error: "Telefone curto demais — inclua o DDD (ex.: 85 99999-9999)" };
    case "too_long":
      return { ok: false, error: "Telefone longo demais — confira os dígitos" };
    default:
      return { ok: false, error: "Telefone inválido — confira o DDD e o número" };
  }
}

/**
 * Grafias sob as quais o MESMO número pode já estar gravado. O ingest grava o
 * que o WhatsApp devolve, e para celulares antigos o WhatsApp às vezes devolve
 * o número BR SEM o 9º dígito (558588887777) — a normalização daqui sempre
 * acrescenta o 9 (5585988887777). Procurar as duas evita duplicar o contato.
 * Vale nos dois sentidos: o número canônico do gateway (sem o 9) também acha o
 * contato gravado COM o 9. A forma recebida vem primeiro (é a preferida).
 */
export function phoneLookupCandidates(phone: string): string[] {
  const out = [phone];
  if (/^55\d{2}9\d{8}$/.test(phone)) {
    out.push(`${phone.slice(0, 4)}${phone.slice(5)}`);
  } else if (/^55\d{2}[6-9]\d{7}$/.test(phone)) {
    out.push(`${phone.slice(0, 4)}9${phone.slice(4)}`);
  }
  return out;
}

/**
 * Grafias a perguntar ao WhatsApp numa ÚNICA chamada `/user/check`: a forma
 * normalizada (com o 9) e a antiga (sem o 9). Uma conta registrada de qualquer
 * um dos jeitos é encontrada; quem decide qual vale é o JID devolvido.
 */
export function phoneSpellingVariants(phone: string): string[] {
  return phoneLookupCandidates(phone);
}

export type CheckedWhatsappUser = { phone: string; onWhatsapp: boolean; jid?: string };

export type CanonicalPick = {
  onWhatsapp: boolean;
  canonicalPhone?: string;
  /** JID de TELEFONE (`@s.whatsapp.net`) — só ele prova qual grafia é a real. */
  jid?: string;
  /** LID (`@lid`) devolvido pelo gateway: identidade interna, NÃO é telefone. */
  lid?: string;
  /** O gateway confirmou mais de uma grafia e nenhum JID de telefone desempatou. */
  ambiguous?: boolean;
};

const CANONICAL_PHONE_RE = /^\d{8,15}$/;

/**
 * JID cujo usuário é o TELEFONE. Caso real (03/10/2026): o wuzapi devolveu
 * `180002129735765@lid` para o número do Eric — um LID, a identidade interna
 * que o WhatsApp usa em vez do telefone por privacidade — e os dígitos viraram
 * "+180002129735765" no CRM. Só `@s.whatsapp.net`/`@c.us` (ou um JID sem
 * servidor cujos dígitos sejam exatamente uma das grafias) valem como telefone.
 */
export function isPhoneJid(jid: string | undefined, candidates: string[] = []): boolean {
  if (!jid) return false;
  const at = jid.indexOf("@");
  if (at < 0) return candidates.includes(jid.replace(/\D+/g, ""));
  const server = jid.slice(at + 1).toLowerCase();
  return server === "s.whatsapp.net" || server === "c.us";
}

export function isLidJid(jid: string | undefined): boolean {
  return !!jid && /@lid$/i.test(jid);
}

/**
 * Resultado do `/user/check` → número canônico, nesta ordem:
 * 1. usuário no WhatsApp com JID de TELEFONE plausível (8–15 dígitos) — prova;
 * 2. sem JID de telefone (hoje o gateway costuma devolver LID): a grafia que o
 *    gateway confirmou. Se confirmou MAIS de uma (o servidor do WhatsApp
 *    normaliza o 9º dígito BR e diz "sim" para as duas), desempata pela grafia
 *    que JÁ é contato na org (`knownPhones`) e, sem isso, pela primeira
 *    pedida (a normalizada) — marcando `ambiguous`.
 * Nenhuma grafia no WhatsApp → `onWhatsapp: false`.
 */
export function pickCanonicalFromCheck(
  users: CheckedWhatsappUser[],
  candidates: string[],
  knownPhones: string[] = []
): CanonicalPick {
  const rank = (u: CheckedWhatsappUser) => {
    const i = candidates.indexOf(u.phone);
    return i < 0 ? candidates.length : i;
  };
  const onWa = users.filter((u) => u.onWhatsapp).sort((a, b) => rank(a) - rank(b));
  const lid = onWa.map((u) => u.jid).find((j) => isLidJid(j));
  const extra = lid ? { lid } : {};
  for (const u of onWa) {
    const fromJid = phoneFromJid(u.jid);
    if (u.jid && isPhoneJid(u.jid, candidates) && fromJid && CANONICAL_PHONE_RE.test(fromJid)) {
      return { onWhatsapp: true, canonicalPhone: fromJid, jid: u.jid, ...extra };
    }
  }
  const confirmed = onWa.filter((u) => CANONICAL_PHONE_RE.test(u.phone));
  if (confirmed.length === 0) return { onWhatsapp: onWa.length > 0, ...extra };
  if (confirmed.length === 1) return { onWhatsapp: true, canonicalPhone: confirmed[0].phone, ...extra };
  const known = confirmed.find((u) => knownPhones.includes(u.phone));
  return { onWhatsapp: true, canonicalPhone: (known ?? confirmed[0]).phone, ambiguous: true, ...extra };
}

/** Telefone já canônico (veio do gateway): só dígitos, 8–15 — nunca re-normalizar. */
export function isCanonicalPhone(phone: string | undefined | null): phone is string {
  return typeof phone === "string" && CANONICAL_PHONE_RE.test(phone);
}

export const NOT_ON_WHATSAPP_ERROR = "Este número não tem WhatsApp — confira os dígitos";

/** Nome digitado → partes do contato (vazio = undefined, nunca string vazia). */
export function cleanNamePart(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  return s ? s.slice(0, 80) : undefined;
}
