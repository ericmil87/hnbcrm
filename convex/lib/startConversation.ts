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

export type CanonicalPick = { onWhatsapp: boolean; canonicalPhone?: string; jid?: string };

const CANONICAL_PHONE_RE = /^\d{8,15}$/;

/**
 * Resultado do `/user/check` → número canônico. Prefere um usuário que está no
 * WhatsApp E tem JID com telefone plausível (8–15 dígitos), na ordem das
 * grafias perguntadas; sem JID, cai na grafia que o próprio gateway confirmou.
 * Nenhuma grafia no WhatsApp → `onWhatsapp: false`.
 */
export function pickCanonicalFromCheck(users: CheckedWhatsappUser[], candidates: string[]): CanonicalPick {
  const rank = (u: CheckedWhatsappUser) => {
    const i = candidates.indexOf(u.phone);
    return i < 0 ? candidates.length : i;
  };
  const onWa = users.filter((u) => u.onWhatsapp).sort((a, b) => rank(a) - rank(b));
  for (const u of onWa) {
    const fromJid = phoneFromJid(u.jid);
    if (u.jid && fromJid && CANONICAL_PHONE_RE.test(fromJid)) {
      return { onWhatsapp: true, canonicalPhone: fromJid, jid: u.jid };
    }
  }
  for (const u of onWa) {
    if (CANONICAL_PHONE_RE.test(u.phone)) return { onWhatsapp: true, canonicalPhone: u.phone };
  }
  return { onWhatsapp: onWa.length > 0 };
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
