/**
 * Normalização de telefone — E.164 SEM o "+" (o formato que o ingest do
 * WhatsApp usa em `contacts.phone`/`whatsappNumber`). Fonte única para
 * campanhas, supressão, "Nova conversa", formulário público e follow-up.
 *
 * Regras (puras, sem dependência):
 *  - DDI EXPLÍCITO ("+", "00" e, só em org NANP, "011") é respeitado: o número
 *    nunca ganha o DDI padrão da org nem passa pela regra de DDD brasileiro;
 *  - sem DDI → prefixa `defaultCountry` (o DDI padrão da org, 55 = Brasil),
 *    depois de tirar UM "0" de tronco (07911… no Reino Unido, 0412… na
 *    Austrália) — exceto NANP ("1"), que não tem tronco;
 *  - Brasil (o país RESOLVIDO é 55, qualquer que seja o padrão da org):
 *    celular = DDD (2) + 9 dígitos começando em 9. Número com DDD + 8 dígitos
 *    cujo primeiro é 6-9 é celular antigo → ganha o 9º dígito. Fixo (2-5) fica
 *    com 8 dígitos e NÃO é celular (`isMobile` = false);
 *  - NANP ("1" — EUA/Canadá): 10 dígitos nacionais, código de área começando
 *    em 2-9;
 *  - demais países: parte nacional de 6 a 12 dígitos, total de 8 a 15.
 *
 * Com o padrão 55 o comportamento para número sem "+" é idêntico ao anterior.
 * Dígitos que JÁ carregam DDI com 12+ dígitos (o que o WhatsApp devolve)
 * passam intactos qualquer que seja o padrão da org.
 *
 * `normalizePhone` (só dígitos) continua exportado de lib/importMapping.ts para
 * o import de contatos — aqui é `normalizeCampaignPhone`, mais estrita.
 */

export const DEFAULT_COUNTRY_CODE = "55";

const BR_DDD_MIN = 11;
const BR_DDD_MAX = 99;

// ── Códigos de discagem (ITU-T E.164) ─────────────────────────────────────
// No plano da ITU os prefixos não se sobrepõem: 1 e 7 são os únicos de 1
// dígito, os de 2 dígitos são um conjunto fixo e o resto tem 3. Por isso
// "maior casamento" NÃO é o critério — 1 seguido de qualquer coisa é NANP.

const ONE_DIGIT_CODES = new Set(["1", "7"]);

function range(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(String(i));
  return out;
}

const TWO_DIGIT_CODES = new Set<string>([
  "20", "27",
  ...range(30, 34), "36", "39",
  "40", "41", ...range(43, 49),
  ...range(51, 58),
  ...range(60, 66),
  "81", "82", "84", "86",
  ...range(90, 95), "98",
]);

const THREE_DIGIT_CODES = new Set<string>([
  ...range(211, 218),
  ...range(220, 269),
  ...range(290, 299),
  ...range(350, 359),
  ...range(370, 389),
  "420", "421", "423",
  ...range(500, 509),
  ...range(590, 599),
  ...range(670, 689),
  ...range(690, 699),
  "850", "852", "853", "855", "856",
  ...range(870, 880),
  "886",
  ...range(960, 968),
  ...range(970, 979),
  ...range(992, 998),
]);

/** O código (só dígitos) é um DDI conhecido da tabela? */
export function isKnownCountryCode(code: string): boolean {
  return ONE_DIGIT_CODES.has(code) || TWO_DIGIT_CODES.has(code) || THREE_DIGIT_CODES.has(code);
}

/**
 * Separa DDI e parte nacional de um número que JÁ começa com o DDI.
 * Devolve null quando o prefixo não é um código conhecido (ou não sobra
 * parte nacional).
 */
export function splitCountryCode(digits: string): { country: string; national: string } | null {
  const d = digitsOnly(digits);
  if (!d) return null;
  let country: string | null = null;
  if (ONE_DIGIT_CODES.has(d.slice(0, 1))) country = d.slice(0, 1);
  else if (TWO_DIGIT_CODES.has(d.slice(0, 2))) country = d.slice(0, 2);
  else if (THREE_DIGIT_CODES.has(d.slice(0, 3))) country = d.slice(0, 3);
  if (!country || d.length <= country.length) return null;
  return { country, national: d.slice(country.length) };
}

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

/**
 * Parte nacional NANP: 10 dígitos com código de área começando em 2-9. O
 * prefixo (3 dígitos seguintes) NÃO é checado de propósito: os números de
 * teste da Meta são +1 555 0xx/1xx xxxx, e recusá-los faria a checagem de
 * supressão de um contato gravado falhar ABERTA.
 */
function isValidNanpNational(national: string): boolean {
  return /^[2-9]\d{9}$/.test(national);
}

export type NormalizedPhone =
  | { ok: true; phone: string; country: string; isMobile: boolean }
  | { ok: false; reason: "empty" | "too_short" | "too_long" | "invalid" };

function brResult(national: string): NormalizedPhone {
  return { ok: true, phone: `55${national}`, country: "55", isMobile: national.length === 11 };
}

/**
 * Valida/normaliza um número que JÁ começa com o DDI (só dígitos), aplicando
 * as regras do país resolvido.
 */
function validateWithCountry(d: string): NormalizedPhone {
  if (d.length < 8) return { ok: false, reason: "too_short" };
  if (d.length > 15) return { ok: false, reason: "too_long" };
  const split = splitCountryCode(d);
  if (!split) return { ok: false, reason: "invalid" };
  const { country, national } = split;
  if (country === "55") {
    if (national.length < 10 || national.length > 11) {
      return { ok: false, reason: national.length < 10 ? "too_short" : "invalid" };
    }
    const n = normalizeBrNational(national);
    return n ? brResult(n) : { ok: false, reason: "invalid" };
  }
  if (country === "1") {
    if (national.length < 10) return { ok: false, reason: "too_short" };
    if (!isValidNanpNational(national)) return { ok: false, reason: "invalid" };
    return { ok: true, phone: d, country, isMobile: true };
  }
  if (national.length < 6) return { ok: false, reason: "too_short" };
  if (national.length > 12) return { ok: false, reason: "too_long" };
  return { ok: true, phone: d, country, isMobile: true };
}

/**
 * Normaliza para E.164 sem "+". `defaultCountry` = DDI a prefixar quando o
 * número vem sem DDI (default 55; use `resolveDefaultCountry(org.settings)`
 * de lib/orgPhone.ts).
 */
export function normalizeCampaignPhone(
  raw: string,
  defaultCountry: string = DEFAULT_COUNTRY_CODE
): NormalizedPhone {
  const text = String(raw ?? "").trim();
  let d = digitsOnly(text);
  if (!d) return { ok: false, reason: "empty" };
  const cc = /^\d{1,3}$/.test(defaultCountry) ? defaultCountry : DEFAULT_COUNTRY_CODE;

  // DDI explícito: "+", "00" (internacional) ou "011" (saída dos EUA/Canadá).
  let explicit = text.startsWith("+");
  if (!explicit && d.startsWith("00")) {
    d = d.slice(2);
    explicit = true;
  } else if (!explicit && cc === "1" && d.startsWith("011") && d.length > 11) {
    d = d.slice(3);
    explicit = true;
  }
  if (d.length < 8) return { ok: false, reason: "too_short" };
  if (d.length > 15) return { ok: false, reason: "too_long" };
  if (explicit) return validateWithCountry(d);

  // ── Sem DDI: padrão Brasil (comportamento histórico, inalterado) ──
  if (cc === "55") {
    if (d.startsWith("55") && d.length >= 12 && d.length <= 13) {
      const national = normalizeBrNational(d.slice(2));
      if (!national) return { ok: false, reason: "invalid" };
      return brResult(national);
    }
    if (d.length === 10 || d.length === 11 || (d.length === 12 && d.startsWith("0"))) {
      const national = normalizeBrNational(d);
      if (national) return brResult(national);
      // 11 dígitos que não são BR (ex.: 1 212 555 1234) → tratar como internacional
    }
    if (d.length < 10) return { ok: false, reason: "too_short" };
    return validateWithCountry(d);
  }

  // ── Sem DDI: padrão NANP ──
  if (cc === "1") {
    if (d.length === 10) return validateWithCountry(`1${d}`);
    if (d.length === 11 && d.startsWith("1")) return validateWithCountry(d);
    if (d.length < 10) return { ok: false, reason: "too_short" };
    // 11+ dígitos sem o "1": só pode ser número estrangeiro digitado sem "+".
    return validateWithCountry(d);
  }

  // ── Sem DDI: outros países ──
  if (!d.startsWith(cc) && d.length <= 11) {
    // um "0" de tronco antes do código de área (07911…, 0412…, 0151…)
    const national = d.startsWith("0") ? d.slice(1) : d;
    if (national.length < 6) return { ok: false, reason: "too_short" };
    return validateWithCountry(`${cc}${national}`);
  }
  // já começa com o DDI padrão, ou é longo demais para ser só nacional
  return validateWithCountry(d);
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

/** Agrupa a parte nacional em blocos de 3–4 dígitos (os maiores no fim). */
function groupNational(national: string): string {
  const L = national.length;
  if (L <= 4) return national;
  const groups = Math.ceil(L / 4);
  const base = Math.floor(L / groups);
  const extra = L % groups;
  const out: string[] = [];
  let i = 0;
  for (let g = 0; g < groups; g++) {
    const size = base + (g >= groups - extra ? 1 : 0);
    out.push(national.slice(i, i + size));
    i += size;
  }
  return out.join(" ");
}

/**
 * Formata para exibição: +55 (11) 99999-9999, +1 (212) 555-1234 ou
 * +<ddi> <nacional em blocos>. Sem DDI reconhecível → +<dígitos>.
 */
export function formatPhoneForDisplay(phone: string): string {
  const d = digitsOnly(phone);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const sub = d.slice(4);
    const split = sub.length === 9 ? 5 : 4;
    return `+55 (${ddd}) ${sub.slice(0, split)}-${sub.slice(split)}`;
  }
  if (d.startsWith("1") && d.length === 11) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  const split = d.length >= 8 ? splitCountryCode(d) : null;
  if (split && split.country !== "55" && split.country !== "1") {
    return `+${split.country} ${groupNational(split.national)}`;
  }
  return d ? `+${d}` : "";
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
