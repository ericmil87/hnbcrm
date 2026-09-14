/**
 * Renderização do texto de campanha — PURO.
 *
 *  - Spintax `{a|b|c}` (1 nível de aninhamento) → escolha determinística por
 *    seed (mesmo destinatário → mesmo texto; destinatários diferentes → variação).
 *  - Placeholders `{{nome}}`, `{{campo|fallback}}` — chave case-insensitive,
 *    sem acento e sem espaço ("Primeiro Nome" casa com {{primeiro_nome}}).
 *  - Escolha de variante: round-robin pelo índice do destinatário.
 *  - `renderTemplateComponents`: parâmetros de template Meta no formato Graph.
 */

export interface RecipientVars {
  displayName?: string;
  vars?: Record<string, string>;
}

/** PRNG determinístico (mulberry32) a partir de uma seed string. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeVarKey(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

/** Resolve spintax `{a|b|c}` (aninhado 1 nível) com o rng dado. */
export function resolveSpintax(text: string, rng: () => number): string {
  // Dois passes cobrem 1 nível de aninhamento: o interno resolve primeiro.
  const pass = (input: string) =>
    input.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, inner: string) => {
      const options = inner.split("|");
      const idx = Math.min(options.length - 1, Math.floor(rng() * options.length));
      return options[idx];
    });
  let out = pass(text);
  if (/\{[^{}]*\|[^{}]*\}/.test(out)) out = pass(out);
  return out;
}

/** Substitui `{{var}}` / `{{var|fallback}}`. Sem valor e sem fallback → "". */
export function substituteVars(text: string, recipient: RecipientVars): string {
  const table: Record<string, string> = {};
  for (const [k, v] of Object.entries(recipient.vars ?? {})) table[normalizeVarKey(k)] = v;
  if (recipient.displayName) {
    const first = recipient.displayName.trim().split(/\s+/)[0] ?? "";
    table.nome = table.nome ?? recipient.displayName;
    table.name = table.name ?? recipient.displayName;
    table.primeiro_nome = table.primeiro_nome ?? first;
    table.first_name = table.first_name ?? first;
  }
  return text.replace(/\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g, (_m, key: string, fallback?: string) => {
    const value = table[normalizeVarKey(key)];
    if (value !== undefined && value !== "") return value;
    return fallback !== undefined ? fallback.trim() : "";
  });
}

/** Chaves de `{{var}}` usadas no texto (normalizadas, sem duplicatas). */
export function extractVars(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}/g)) {
    out.add(normalizeVarKey(m[1]));
  }
  return [...out];
}

const LINK_RE = /(https?:\/\/|www\.|wa\.me\/|bit\.ly\/|[a-z0-9-]+\.(com|com\.br|net|org|io|app|link|me)(\/|\b))/i;

export function containsLink(text: string): boolean {
  return LINK_RE.test(text);
}

/** Índice da variante para o n-ésimo destinatário (round-robin). */
export function pickVariantIndex(recipientOrdinal: number, variantCount: number): number {
  if (variantCount <= 1) return 0;
  return Math.abs(Math.floor(recipientOrdinal)) % variantCount;
}

/** Renderiza o texto final de um destinatário (spintax + vars). */
export function renderText(
  text: string,
  recipient: RecipientVars,
  seed: string
): string {
  const rng = seededRandom(seed);
  // Vars ANTES do spintax: `{{campo|fallback}}` também casa com o padrão
  // `{a|b}` e viraria uma escolha aleatória entre "campo" e "fallback".
  return resolveSpintax(substituteVars(text, recipient), rng).trim();
}

// ── Templates Meta ──

export interface TemplateParam {
  source: "field" | "const";
  value: string;
}

export interface CampaignTemplateSpec {
  name: string;
  language: string;
  headerFormat?: string; // IMAGE | VIDEO | DOCUMENT | TEXT
  headerLink?: string; // URL pública do arquivo (resolvida pelo chamador)
  headerFilename?: string;
  bodyParams?: TemplateParam[];
  headerParams?: TemplateParam[];
  buttonParams?: TemplateParam[];
}

function resolveParam(p: TemplateParam, recipient: RecipientVars): string {
  if (p.source === "const") return p.value;
  return substituteVars(`{{${p.value}}}`, recipient);
}

/**
 * Monta `components` no formato da Graph API:
 *  header: {type:"header", parameters:[{type:"image", image:{link}}]} etc.
 *  body:   {type:"body", parameters:[{type:"text", text}]}
 *  botões: {type:"button", sub_type:"url", index:"0", parameters:[{type:"text", text}]}
 */
export function renderTemplateComponents(
  template: CampaignTemplateSpec,
  recipient: RecipientVars
): Array<Record<string, unknown>> {
  const components: Array<Record<string, unknown>> = [];
  const fmt = (template.headerFormat ?? "").toUpperCase();
  if (fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT") {
    if (template.headerLink) {
      const kind = fmt.toLowerCase();
      const media: Record<string, unknown> = { link: template.headerLink };
      if (kind === "document" && template.headerFilename) media.filename = template.headerFilename;
      components.push({ type: "header", parameters: [{ type: kind, [kind]: media }] });
    }
  } else if (fmt === "TEXT" && template.headerParams && template.headerParams.length > 0) {
    components.push({
      type: "header",
      parameters: template.headerParams.map((p) => ({ type: "text", text: resolveParam(p, recipient) })),
    });
  }
  if (template.bodyParams && template.bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: template.bodyParams.map((p) => ({ type: "text", text: resolveParam(p, recipient) })),
    });
  }
  if (template.buttonParams && template.buttonParams.length > 0) {
    template.buttonParams.forEach((p, index) => {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(index),
        parameters: [{ type: "text", text: resolveParam(p, recipient) }],
      });
    });
  }
  return components;
}

/** Texto aproximado do template para histórico/preview ({{1}} → valor). */
export function renderTemplateBodyPreview(
  bodyText: string | undefined,
  bodyParams: TemplateParam[] | undefined,
  recipient: RecipientVars
): string {
  if (!bodyText) return "";
  return bodyText.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => {
    const p = bodyParams?.[Number(n) - 1];
    return p ? resolveParam(p, recipient) : `{{${n}}}`;
  });
}
