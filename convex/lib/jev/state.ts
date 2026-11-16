/**
 * Estado enviado ao Jev — PII mínima por construção (D8 do plano).
 *
 *  - LISTA DE CAMPOS PERMITIDOS (`STATE_SCHEMA`): qualquer chave fora dela é
 *    REJEITADA (nome, telefone, e-mail, documento, id interno… nunca entram por
 *    descuido de quem monta o estado). `state` chega como `v.any()` na action —
 *    esta função é a validação real.
 *  - Texto livre (mensagens do lead, histórico) é MASCARADO por regex: telefone,
 *    e-mail, CPF/CNPJ, links e ids. Limitação conhecida e declarada: NOMES e
 *    endereços digitados no corpo da conversa NÃO são detectáveis por regex; por
 *    isso o estado nunca leva campo de nome e o envio usa `data_collection:"deny"`.
 *  - Histórico truncado (últimas N falas, M caracteres cada): estado é cobrado por token.
 *  - `stateHash` (sha256 do JSON canônico) vai para `jevDecisions` no lugar do texto.
 */
import { JevValidationError } from "./types";

export const MAX_TURNS = 8;
export const MAX_TURN_CHARS = 500;
export const MAX_MESSAGE_CHARS = 1500;
export const MAX_SHORT_CHARS = 200;
export const MAX_LIST_ITEMS = 12;
export const MAX_STATE_CHARS = 24_000;

// ── Máscara de dado pessoal no texto livre ──────────────────────────────────

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const CNPJ_RE = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
const CPF_RE = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CONVEX_ID_RE = /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{32}\b/g;
// Celular brasileiro de 11 dígitos (DDD + 9 + 8) ANTES do CPF: sem isto "zap 81999998888" vira "[cpf]".
const BR_MOBILE_RE = /(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9\d{4}[\s.\-–—_]?\d{4}(?!\d)/g;
// Corrida de dígitos com separadores comuns de telefone, inclusive travessão do autocorretor e "_".
// Sem exigir fronteira de palavra à esquerda: "tel8133334444" e "whats5581999998888" também caem.
const PHONE_RE = /(?<!\d)\+?\d[\d\s().\-–—_]{6,}\d(?!\d)/g;
// O que parece telefone mas não é: data/hora ISO, data com barra, número com milhar ("12.345.678,00").
// Protegido com sentinelas ANTES da máscara de telefone e restaurado depois.
const KEEP_RES = [
  /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g,
  /\d{1,2}\/\d{1,2}\/\d{2,4}(?:[ ,]+\d{1,2}:\d{2})?/g,
  /\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?/g,
];
const SENTINEL = "\u0001";

export function maskPersonalData(text: string): string {
  // Controle do ASCII (inclui a sentinela) não tem lugar numa conversa: vira espaço.
  let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(URL_RE, "[link]").replace(EMAIL_RE, "[email]");
  out = out.replace(CNPJ_RE, "[cnpj]").replace(BR_MOBILE_RE, "[telefone]").replace(CPF_RE, "[cpf]");
  out = out.replace(UUID_RE, "[id]").replace(CONVEX_ID_RE, "[id]");
  const kept: string[] = [];
  for (const re of KEEP_RES) {
    out = out.replace(re, (m) => {
      kept.push(m);
      return `${SENTINEL}${kept.length - 1}${SENTINEL}`;
    });
  }
  out = out.replace(PHONE_RE, (m, offset: number) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return m;
    // Valor em reais (R$ 12345678) não é telefone.
    if (/R\$\s*$/.test(out.slice(Math.max(0, offset - 4), offset))) return m;
    return "[telefone]";
  });
  return out.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"), (_m, i: string) => kept[Number(i)] ?? "");
}

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : text;
}

const clean = (text: string, max: number) => cut(maskPersonalData(text).replace(/\s+/g, " ").trim(), max);

// ── Lista de campos permitidos ──────────────────────────────────────────────

type Field =
  | { kind: "text"; max: number }
  | { kind: "texts"; max: number }
  | { kind: "turns" }
  | { kind: "flat" }
  | { kind: "obj"; fields: Record<string, Field> };

const SHORT: Field = { kind: "text", max: MAX_SHORT_CHARS };

/**
 * Chaves de topo aceitas no `state`. Cada caso de uso (fases 1+) escolhe um
 * subconjunto; incluir um campo novo aqui é uma decisão de PRIVACIDADE (PR).
 */
export const STATE_SCHEMA: Record<string, Field> = {
  mensagem: { kind: "text", max: MAX_MESSAGE_CHARS },
  resposta: { kind: "text", max: MAX_MESSAGE_CHARS },
  historico: { kind: "turns" },
  janela: { kind: "turns" },
  conversa: { kind: "turns" },
  lead: { kind: "obj", fields: { etapa: SHORT, origem: SHORT, tags: { kind: "texts", max: 60 } } },
  empresa: {
    kind: "obj",
    fields: { segmento: SHORT, produtos: { kind: "texts", max: 80 }, horario: SHORT },
  },
  politica: { kind: "flat" },
};

const FLAT_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const bad = (message: string) => new JevValidationError("invalid_state", message);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function sanitizeField(path: string, field: Field, value: unknown): unknown {
  switch (field.kind) {
    case "text":
      if (typeof value !== "string") throw bad(`${path}: precisa ser texto`);
      return clean(value, field.max);
    case "texts": {
      if (!Array.isArray(value)) throw bad(`${path}: precisa ser lista de textos`);
      return value.slice(0, MAX_LIST_ITEMS).map((x, i) => {
        if (typeof x !== "string") throw bad(`${path}[${i}]: precisa ser texto`);
        return clean(x, field.max);
      });
    }
    case "turns": {
      if (!Array.isArray(value)) throw bad(`${path}: precisa ser lista de falas`);
      // Fica o FIM da conversa: fala antiga não muda a decisão e custa token.
      return value.slice(-MAX_TURNS).map((t, i) => {
        if (!isObj(t)) throw bad(`${path}[${i}]: fala precisa ser objeto`);
        for (const k of Object.keys(t)) if (k !== "de" && k !== "texto") throw bad(`${path}[${i}]: campo não permitido (${k})`);
        if (t.de !== "lead" && t.de !== "empresa") throw bad(`${path}[${i}].de: use "lead" ou "empresa"`);
        if (typeof t.texto !== "string") throw bad(`${path}[${i}].texto: precisa ser texto`);
        return { de: t.de, texto: clean(t.texto, MAX_TURN_CHARS) };
      });
    }
    case "flat": {
      if (!isObj(value)) throw bad(`${path}: precisa ser objeto`);
      const out: Record<string, string | number | boolean> = {};
      for (const [k, x] of Object.entries(value)) {
        if (!FLAT_KEY_RE.test(k)) throw bad(`${path}: chave inválida (${k})`);
        if (typeof x === "string") out[k] = clean(x, MAX_SHORT_CHARS);
        else if (typeof x === "number" && Number.isFinite(x)) {
          // Inteiro de 8+ dígitos parece telefone/documento: número cru não passa pela máscara de texto.
          if (String(Math.trunc(Math.abs(x))).length >= 8) throw bad(`${path}.${k}: número com 8+ dígitos (parece telefone ou documento); envie como texto sem os dígitos`);
          out[k] = x;
        }
        else if (typeof x === "boolean") out[k] = x;
        else throw bad(`${path}.${k}: use texto, número ou booleano`);
      }
      return out;
    }
    case "obj": {
      if (!isObj(value)) throw bad(`${path}: precisa ser objeto`);
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(value)) {
        const f = field.fields[k];
        if (!f) throw bad(`${path}: campo não permitido (${k})`);
        if (x === undefined) continue;
        out[k] = sanitizeField(`${path}.${k}`, f, x);
      }
      return out;
    }
  }
}

/** Valida contra a lista de campos permitidos e devolve o estado limpo (mascarado/truncado). */
export function sanitizeJevState(input: unknown): Record<string, unknown> {
  if (!isObj(input)) throw bad("state precisa ser um objeto");
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(input)) {
    const field = STATE_SCHEMA[k];
    // Nunca ecoa o valor rejeitado (poderia ser o próprio dado pessoal).
    if (!field) throw bad(`campo não permitido no estado: ${k}`);
    if (value === undefined) continue;
    out[k] = sanitizeField(k, field, value);
  }
  if (Object.keys(out).length === 0) throw bad("state vazio");
  if (stableStringify(out).length > MAX_STATE_CHARS) throw bad(`state acima de ${MAX_STATE_CHARS} caracteres`);
  return out;
}

// ── Hash estável ────────────────────────────────────────────────────────────

/** JSON canônico: chaves em ordem; `undefined` some como no JSON; valor não-serializável lança. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("stableStringify: número não finito");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const parts = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`stableStringify: tipo não suportado (${typeof value})`);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function stateHash(state: unknown): Promise<string> {
  return sha256Hex(stableStringify(state));
}

/** Estado limpo + hash — o que a action usa. */
export async function prepareJevState(input: unknown): Promise<{ state: Record<string, unknown>; stateHash: string }> {
  const state = sanitizeJevState(input);
  return { state, stateHash: await stateHash(state) };
}
