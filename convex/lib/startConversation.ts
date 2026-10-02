/**
 * "Nova conversa" (inbox): regras PURAS compartilhadas entre a query de prévia,
 * a mutation e os testes. Nada aqui toca o banco.
 */
import { normalizeCampaignPhone } from "./phone";

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
 * A forma normalizada vem primeiro (é a preferida).
 */
export function phoneLookupCandidates(phone: string): string[] {
  const out = [phone];
  if (/^55\d{2}9\d{8}$/.test(phone)) {
    out.push(`${phone.slice(0, 4)}${phone.slice(5)}`);
  }
  return out;
}

/** Nome digitado → partes do contato (vazio = undefined, nunca string vazia). */
export function cleanNamePart(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  return s ? s.slice(0, 80) : undefined;
}
