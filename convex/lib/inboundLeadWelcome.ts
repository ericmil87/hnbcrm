/**
 * Boas-vindas automáticas + roteamento por tag do lead que entra por
 * `POST /api/v1/inbound/lead` (v0.64) — núcleo PURO, sem ctx.
 *
 * - `resolveInboundRoutingRule`: primeira regra cuja tag está nas tags do lead.
 * - `shouldSendWelcome`: interruptor ligado + telefone + pelo menos uma tag de
 *   `requireAnyTag` (lista vazia = NUNCA envia: a tag é a prova de
 *   consentimento/pedido, e fail-closed é o certo aqui) + um texto escolhível.
 * - `pickWelcomeMessage`: primeira mensagem cuja `matchTag` está nas tags;
 *   `"*"` = texto padrão.
 * - `renderWelcomeTemplate`: {primeiroNome}, {nome}, {titulo},
 *   {tag:<prefixo>}; variável ausente vira "" e placeholder que sobrar some.
 *
 * Comparação de tags é sem caixa e sem espaços nas pontas — tag de formulário
 * costuma chegar como "Optin:WhatsApp".
 */

export type InboundLeadWelcomeSettings = {
  enabled: boolean;
  channelConfigId: string;
  requireAnyTag: string[];
  messages: Array<{ matchTag: string; text: string }>;
};

export type InboundLeadRoutingSettings<B = string, S = string> = {
  rules: Array<{ tag: string; boardId: B; stageId: S }>;
};

/** Tag de lead que marca "já mandamos a primeira mensagem". */
export const WELCOME_SENT_TAG = "contato:iniciado";

/** Prefixo da nota interna com a mensagem do formulário (lido pelo atendente). */
export const FORM_NOTE_PREFIX = "Formulário do site: ";

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function tagSet(tags: readonly string[] | undefined): Set<string> {
  return new Set((tags ?? []).map(normalizeTag).filter(Boolean));
}

export function resolveInboundRoutingRule<B, S>(
  routing: InboundLeadRoutingSettings<B, S> | undefined | null,
  tags: readonly string[] | undefined
): { tag: string; boardId: B; stageId: S } | null {
  if (!routing || routing.rules.length === 0) return null;
  const set = tagSet(tags);
  for (const rule of routing.rules) {
    if (set.has(normalizeTag(rule.tag))) return rule;
  }
  return null;
}

export function pickWelcomeMessage(
  settings: Pick<InboundLeadWelcomeSettings, "messages"> | undefined | null,
  tags: readonly string[] | undefined
): string | null {
  if (!settings) return null;
  const set = tagSet(tags);
  let fallback: string | null = null;
  for (const m of settings.messages) {
    if (!m.text.trim()) continue;
    if (m.matchTag.trim() === "*") {
      if (fallback === null) fallback = m.text;
      continue;
    }
    if (set.has(normalizeTag(m.matchTag))) return m.text;
  }
  return fallback;
}

export function shouldSendWelcome(
  settings: InboundLeadWelcomeSettings | undefined | null,
  input: { hasPhone: boolean; tags: readonly string[] | undefined }
): boolean {
  if (!settings || settings.enabled !== true) return false;
  if (!input.hasPhone) return false;
  const required = settings.requireAnyTag.map(normalizeTag).filter(Boolean);
  if (required.length === 0) return false;
  const set = tagSet(input.tags);
  if (!required.some((t) => set.has(t))) return false;
  return pickWelcomeMessage(settings, input.tags) !== null;
}

/** Valor da primeira tag `<prefixo>:<valor>` (prefixo sem caixa). */
export function tagValue(tags: readonly string[] | undefined, prefix: string): string {
  const p = `${normalizeTag(prefix)}:`;
  for (const raw of tags ?? []) {
    const t = raw.trim();
    if (t.toLowerCase().startsWith(p)) return t.slice(p.length).trim();
  }
  return "";
}

function firstWord(s: string | undefined | null): string {
  return (s ?? "").trim().split(/\s+/)[0] ?? "";
}

export function renderWelcomeTemplate(
  text: string,
  vars: {
    firstName?: string | null;
    name?: string | null;
    title?: string | null;
    tags?: readonly string[];
  }
): string {
  const fullName = (vars.name ?? "").trim();
  const primeiroNome = firstWord(vars.firstName) || firstWord(fullName);
  let out = text
    .replace(/\{\s*primeiroNome\s*\}/g, () => primeiroNome)
    .replace(/\{\s*nome\s*\}/g, () => fullName)
    .replace(/\{\s*titulo\s*\}/g, () => (vars.title ?? "").trim())
    .replace(/\{\s*tag\s*:\s*([^{}\s]+)\s*\}/g, (_m, prefix: string) => tagValue(vars.tags, prefix));
  // Placeholder desconhecido/sobrando nunca chega ao cliente.
  out = out.replace(/\{[^{}\n]*\}/g, "");
  // Arruma o que a variável vazia deixou ("Oi , tudo bem" → "Oi, tudo bem").
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.!?;:])/g, "$1").trimEnd())
    .join("\n")
    .trim();
}
