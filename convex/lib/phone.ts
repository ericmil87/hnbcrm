/**
 * Normalização de telefone para campanhas — E.164 SEM o "+" (o formato que o
 * ingest do WhatsApp usa em `contacts.phone`/`whatsappNumber`).
 *
 * Regras (puras, sem dependência):
 *  - só dígitos; "+" e formatação caem fora;
 *  - "00" / "0" de tronco antes do DDD são removidos;
 *  - sem código de país → prefixa `defaultCountry` (55 = Brasil);
 *  - Brasil: celular = DDD (2) + 9 dígitos começando em 9. Número com DDD + 8
 *    dígitos cujo primeiro é 6-9 é celular antigo → ganha o 9º dígito. Fixo
 *    (2-5) fica com 8 dígitos e NÃO é celular (`isValidBrMobile` = false).
 *
 * `normalizePhone` (só dígitos) continua exportado de lib/importMapping.ts para
 * o import de contatos — aqui é `normalizeCampaignPhone`, mais estrita.
 */

export const DEFAULT_COUNTRY_CODE = "55";

const BR_DDD_MIN = 11;
const BR_DDD_MAX = 99;

function digitsOnly(raw: string): string {
  return String(raw ?? "").replace(/\D+/g, "");
}

/** Parece um telefone? (8 a 15 dígitos depois de limpar) — filtro barato. */
export function looksLikePhone(raw: string): boolean {
  const d = digitsOnly(raw);
  return d.length >= 8 && d.length <= 15;
}

function isBrDdd(ddd: string): boolean {
  const n = Number(ddd);
  return Number.isInteger(n) && n >= BR_DDD_MIN && n <= BR_DDD_MAX;
}

/**
 * Normaliza um número brasileiro já SEM código de país (DDD + assinante).
 * Devolve null quando não é um número BR plausível.
 */
function normalizeBrNational(national: string): string | null {
  // "0" de tronco (011 99999-9999)
  let n = national.replace(/^0+/, "");
  if (n.length === 10) {
    const ddd = n.slice(0, 2);
    const sub = n.slice(2);
    if (!isBrDdd(ddd)) return null;
    // celular antigo (8 dígitos, 6-9) → 9º dígito; fixo (2-5) fica
    if (/^[6-9]/.test(sub)) n = `${ddd}9${sub}`;
    return n;
  }
  if (n.length === 11) {
    const ddd = n.slice(0, 2);
    const sub = n.slice(2);
    if (!isBrDdd(ddd)) return null;
    if (!/^9[0-9]{8}$/.test(sub)) return null;
    return n;
  }
  return null;
}

export type NormalizedPhone =
  | { ok: true; phone: string; country: string; isMobile: boolean }
  | { ok: false; reason: "empty" | "too_short" | "too_long" | "invalid" };

/**
 * Normaliza para E.164 sem "+". `defaultCountry` = código a prefixar quando o
 * número vem sem DDI (default 55).
 */
export function normalizeCampaignPhone(
  raw: string,
  defaultCountry: string = DEFAULT_COUNTRY_CODE
): NormalizedPhone {
  let d = digitsOnly(raw);
  if (!d) return { ok: false, reason: "empty" };
  // prefixo internacional "00"
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length < 8) return { ok: false, reason: "too_short" };
  if (d.length > 15) return { ok: false, reason: "too_long" };

  // Brasil (default ou explícito)
  if (defaultCountry === "55") {
    if (d.startsWith("55") && d.length >= 12 && d.length <= 13) {
      const national = normalizeBrNational(d.slice(2));
      if (!national) return { ok: false, reason: "invalid" };
      return { ok: true, phone: `55${national}`, country: "55", isMobile: national.length === 11 };
    }
    if (d.length === 10 || d.length === 11 || (d.length === 12 && d.startsWith("0"))) {
      const national = normalizeBrNational(d);
      if (national) {
        return { ok: true, phone: `55${national}`, country: "55", isMobile: national.length === 11 };
      }
      // 11 dígitos que não são BR (ex.: 1 555 000 0001) → tratar como internacional
    }
  } else if (!d.startsWith(defaultCountry) && d.length <= 11) {
    d = `${defaultCountry}${d}`;
  }

  // Internacional genérico: 8–15 dígitos, já com DDI
  if (d.length < 10) return { ok: false, reason: "too_short" };
  return { ok: true, phone: d, country: d.slice(0, 2), isMobile: true };
}

/** Celular brasileiro válido (55 + DDD + 9 dígitos começando em 9). */
export function isValidBrMobile(phone: string): boolean {
  const d = digitsOnly(phone);
  return /^55[1-9][0-9]9[0-9]{8}$/.test(d) && isBrDdd(d.slice(2, 4));
}

/** Compat: só dígitos (mesmo comportamento de lib/importMapping.normalizePhone). */
export function normalizePhone(raw: string): string {
  return digitsOnly(raw);
}

/** Formata para exibição: +55 (11) 99999-9999 ou +<ddi> <resto>. */
export function formatPhoneForDisplay(phone: string): string {
  const d = digitsOnly(phone);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const sub = d.slice(4);
    const split = sub.length === 9 ? 5 : 4;
    return `+55 (${ddd}) ${sub.slice(0, split)}-${sub.slice(split)}`;
  }
  return d ? `+${d}` : "";
}
