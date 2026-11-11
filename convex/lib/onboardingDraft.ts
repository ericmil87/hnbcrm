/**
 * Rascunho de Operação do onboarding conversacional (plano v2, seções 4.3 e
 * 6.1). É o ÚNICO formato que o entrevistador/leitor (P2.3) pode propor e que
 * `lib/onboardingApply.ts` aplica. Persona por CAMPOS FECHADOS: nenhum texto
 * livre daqui vira instrução de sistema; o que é livre (descrição, saudação,
 * conhecimento, notas de repasse, respostas rápidas) só entra no prompt do
 * atendente dentro do envelope de dado (`promptEnvelope.ts`).
 *
 * PURO (sem `ctx`): validador Convex (`onboardingDraftValidator`, também usado
 * no schema), tipo, limites exportados e `normalizeDraft` (corta, NFKC, remove
 * invisíveis/controle e REJEITA o que excede: nada é truncado em silêncio).
 */
import { ConvexError, v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { languageCodeValidator } from "./languages";

// ── Limites (tamanho em code units após a normalização; contagem por lista) ──
export const DRAFT_LIMITS = {
  businessName: 80,
  businessDescription: 600,
  businessCity: 80,
  funnelName: 60,
  stagesMin: 2,
  stagesMax: 12,
  stageName: 60,
  stageOrderMax: 99,
  customFieldsMax: 8,
  customFieldName: 60,
  customFieldOptionsMax: 30,
  customFieldOption: 60,
  attendantName: 40,
  languagesMin: 1,
  languagesMax: 5,
  greeting: 400,
  knowledgeMax: 40,
  knowledgeText: 500,
  originReference: 300,
  suspicionReason: 200,
  releaseReason: 200,
  blockedMax: 40,
  quickRepliesMax: 20,
  quickReplyShortcut: 24,
  quickReplyText: 1000,
  handoffRulesMax: 10,
  handoffNote: 200,
} as const;

/** Mesmos segmentos de `lib/onboardingTemplates.ts` (lista fechada). */
export const DRAFT_SEGMENTS = [
  "imobiliaria",
  "saas",
  "servicos",
  "saude",
  "ecommerce",
  "educacao",
  "outro",
] as const;

export const KNOWLEDGE_ORIGIN_KINDS = ["usuario", "site", "pdf", "imagem", "audio", "template"] as const;
export type KnowledgeOriginKind = (typeof KNOWLEDGE_ORIGIN_KINDS)[number];

export const HANDOFF_RULE_KINDS = [
  "pedido_humano",
  "reclamacao",
  "pagamento",
  "negociacao_preco",
  "agendamento",
  "urgencia",
  "fora_do_escopo",
  "outro",
] as const;
export type HandoffRuleKind = (typeof HANDOFF_RULE_KINDS)[number];

export const ATTENDANT_TONES = ["formal", "amigavel", "descontraido"] as const;

const segmentValidator = v.union(
  v.literal("imobiliaria"),
  v.literal("saas"),
  v.literal("servicos"),
  v.literal("saude"),
  v.literal("ecommerce"),
  v.literal("educacao"),
  v.literal("outro"),
);

const fieldTypeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("boolean"),
  v.literal("date"),
  v.literal("select"),
  v.literal("multiselect"),
);

const originValidator = v.object({
  kind: v.union(
    v.literal("usuario"),
    v.literal("site"),
    v.literal("pdf"),
    v.literal("imagem"),
    v.literal("audio"),
    v.literal("template"),
  ),
  /** URL, nome do arquivo ou rótulo da fonte (só exibição; nunca buscado aqui). */
  reference: v.optional(v.string()),
});

/**
 * Marca do filtro anti-instrução (`lib/onboardingDraftFilter.ts`). Sempre
 * recalculada no SERVIDOR ao gravar: o valor que o cliente manda é ignorado.
 */
const flagFields = {
  suspicious: v.boolean(),
  suspicionReason: v.optional(v.string()),
  /**
   * Definido SÓ pelo servidor: o leitor gravou com a fonte e todo link/telefone
   * do item aparece nela. Preservado enquanto texto e origem não mudam.
   */
  verifiedInSource: v.optional(v.boolean()),
  /**
   * Liberação HUMANA de um item marcado ("avisar, não travar"): só pelo
   * `saveDraft` do usuário (o caminho da IA zera o campo); `by`/`at` são
   * preenchidos pelo servidor e auditados. Item liberado entra na aplicação.
   */
  release: v.optional(
    v.object({
      reason: v.string(),
      by: v.optional(v.id("teamMembers")),
      at: v.optional(v.number()),
    }),
  ),
};

export type DraftFlags = {
  suspicious: boolean;
  suspicionReason?: string;
  verifiedInSource?: boolean;
  release?: { reason: string; by?: Id<"teamMembers">; at?: number };
};

/** Item entra na aplicação: não marcado, ou marcado e liberado por uma pessoa. */
export function isApplicable(item: DraftFlags): boolean {
  return !item.suspicious || item.release?.at !== undefined;
}

const handoffKindValidator = v.union(
  v.literal("pedido_humano"),
  v.literal("reclamacao"),
  v.literal("pagamento"),
  v.literal("negociacao_preco"),
  v.literal("agendamento"),
  v.literal("urgencia"),
  v.literal("fora_do_escopo"),
  v.literal("outro"),
);

export const onboardingDraftValidator = v.object({
  version: v.literal(1),
  business: v.object({
    name: v.string(),
    segment: segmentValidator,
    description: v.string(),
    city: v.optional(v.string()),
    ...flagFields,
  }),
  funnel: v.object({
    name: v.string(),
    stages: v.array(
      v.object({
        name: v.string(),
        order: v.number(),
        // Ausente = etapa aberta.
        outcome: v.optional(v.union(v.literal("open"), v.literal("won"), v.literal("lost"))),
      }),
    ),
  }),
  customFields: v.array(
    v.object({
      name: v.string(),
      type: fieldTypeValidator,
      options: v.optional(v.array(v.string())),
    }),
  ),
  persona: v.object({
    attendantName: v.string(),
    tone: v.union(v.literal("formal"), v.literal("amigavel"), v.literal("descontraido")),
    addressAs: v.union(v.literal("voce"), v.literal("senhor")),
    languages: v.array(languageCodeValidator),
    // Divulgação de IA é obrigatória: o tipo só aceita `true`.
    presentsAsAi: v.literal(true),
  }),
  greeting: v.optional(v.object({ text: v.string(), ...flagFields })),
  knowledge: v.array(
    v.object({
      text: v.string(),
      origin: originValidator,
      ...flagFields,
    }),
  ),
  quickReplies: v.array(
    v.object({
      shortcut: v.string(),
      text: v.string(),
      ...flagFields,
    }),
  ),
  businessHours: v.optional(
    v.object({
      days: v.array(v.number()), // 0 = domingo … 6 = sábado
      start: v.string(), // "HH:MM"
      end: v.string(), // "HH:MM"
    }),
  ),
  handoffRules: v.array(
    v.object({
      kind: handoffKindValidator,
      note: v.optional(v.string()),
      ...flagFields,
    }),
  ),
  features: v.object({
    vision: v.boolean(),
    transcription: v.boolean(),
    dateTime: v.boolean(),
    translation: v.boolean(),
    voice: v.boolean(),
  }),
  /**
   * Marcas BLOQUEANTES em textos que entram no prompt fora do envelope (nome
   * do funil e das etapas, campos e opções, nome do atendente). Calculadas só
   * pelo servidor; com qualquer item aqui a aplicação é recusada até a pessoa
   * EDITAR o texto (não há liberação para estes).
   */
  blocked: v.optional(v.array(v.object({ field: v.string(), label: v.string(), reason: v.string() }))),
  planInterest: v.optional(
    v.union(
      v.literal("essencial"),
      v.literal("profissional"),
      v.literal("escala"),
      v.literal("empresa"),
    ),
  ),
});

export type OnboardingDraft = Infer<typeof onboardingDraftValidator>;
export type DraftFeatureKey = keyof OnboardingDraft["features"];

// ── Normalização de texto ───────────────────────────────────────────────────

/**
 * Invisíveis e formatação bidi (zero-width, joiners, marcas LTR/RTL,
 * isolates, BOM, soft hyphen, Mongolian vowel separator, word joiner,
 * caracteres "tag" U+E0000–U+E007F usados para esconder texto do humano).
 * Variation selectors: só FE0E/FE0F isolado depois de emoji/tecla fica (ver
 * `VARIATION_RUN_RE`); o resto some.
 */
const INVISIBLE_RE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;
/** Controle C0/C1 exceto \n e \t. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/**
 * Seletores de variação em sequência (FE00–FE0F e os suplementares
 * E0100–E01EF) são o canal de "contrabando" de bytes invisíveis (red team
 * P2.5): de uma sequência fica só o 1º, e só se for FE0E/FE0F…
 */
const VARIATION_RUN_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu;
/** …e FE0E/FE0F só depois de emoji ou tecla (#, *, 0–9), onde compõem o símbolo. */
const STRAY_VARIATION_RE = /(?<!\p{Extended_Pictographic}|[#*0-9])[\uFE0E\uFE0F]/gu;

/** NFKC + remove invisíveis/controle + espaços. `multiline` preserva quebras (até 2 seguidas). */
export function cleanDraftText(raw: string, multiline = false): string {
  let s = raw
    .normalize("NFKC")
    .replace(INVISIBLE_RE, "")
    .replace(VARIATION_RUN_RE, (run) => (run[0] === "\uFE0E" || run[0] === "\uFE0F" ? run[0] : ""))
    .replace(STRAY_VARIATION_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_RE, "");
  s = s.replace(/[\u2028\u2029]/g, "\n");
  if (multiline) {
    s = s
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  } else {
    s = s.replace(/\s+/g, " ");
  }
  return s.trim();
}

/** Chave de campo personalizado a partir do nome (a-z, 0-9, _; até 40). */
export function fieldKeyFromName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ATTENDANT_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u;

export type NormalizeResult = { ok: true; draft: OnboardingDraft } | { ok: false; errors: string[] };

/**
 * Valida e normaliza um rascunho já aceito pelo validador Convex. Corta
 * espaços, aplica NFKC, remove invisíveis/controle e REJEITA (lista de erros
 * em PT-BR) tudo o que excede limite, está vazio quando obrigatório ou é
 * incoerente (funil sem etapa aberta na frente, duas etapas de ganho…).
 * As marcas `suspicious` passam como vieram; quem grava recalcula pelo filtro.
 */
export function normalizeDraft(input: OnboardingDraft): NormalizeResult {
  const errors: string[] = [];
  const L = DRAFT_LIMITS;

  const text = (label: string, raw: string, max: number, opts: { required?: boolean; multiline?: boolean } = {}) => {
    const out = cleanDraftText(raw, opts.multiline);
    if (opts.required && out.length === 0) errors.push(`${label}: obrigatório`);
    if (out.length > max) errors.push(`${label}: até ${max} caracteres`);
    return out;
  };
  const optText = (label: string, raw: string | undefined, max: number, multiline = false) => {
    if (raw === undefined) return undefined;
    const out = text(label, raw, max, { multiline });
    return out.length > 0 ? out : undefined;
  };
  const reason = (raw: string | undefined) =>
    raw === undefined ? undefined : cleanDraftText(raw).slice(0, L.suspicionReason) || undefined;
  const flags = (label: string, item: DraftFlags): DraftFlags => {
    const out: DraftFlags = { suspicious: item.suspicious };
    const r = reason(item.suspicionReason);
    if (r) out.suspicionReason = r;
    if (item.verifiedInSource === true) out.verifiedInSource = true;
    if (item.release) {
      const why = text(`Motivo da liberação (${label})`, item.release.reason, L.releaseReason, { required: true });
      out.release = {
        reason: why,
        ...(item.release.by !== undefined ? { by: item.release.by } : {}),
        ...(item.release.at !== undefined ? { at: item.release.at } : {}),
      };
    }
    return out;
  };
  const count = (label: string, n: number, max: number, min = 0) => {
    if (n > max) errors.push(`${label}: no máximo ${max}`);
    if (n < min) errors.push(`${label}: no mínimo ${min}`);
  };

  // Negócio
  const business = {
    name: text("Nome do negócio", input.business.name, L.businessName, { required: true }),
    segment: input.business.segment,
    description: text("Descrição do negócio", input.business.description, L.businessDescription, {
      multiline: true,
    }),
    city: optText("Cidade", input.business.city, L.businessCity),
    ...flags("negócio", input.business),
  };

  // Funil
  count("Etapas do funil", input.funnel.stages.length, L.stagesMax, L.stagesMin);
  const stages = input.funnel.stages
    .map((s, i) => {
      if (!Number.isInteger(s.order) || s.order < 0 || s.order > L.stageOrderMax) {
        errors.push(`Etapa ${i + 1}: ordem deve ser um inteiro de 0 a ${L.stageOrderMax}`);
      }
      return {
        name: text(`Etapa ${i + 1}`, s.name, L.stageName, { required: true }),
        order: s.order,
        outcome: s.outcome ?? ("open" as const),
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ ...s, order: i }));
  if (new Set(input.funnel.stages.map((s) => s.order)).size !== input.funnel.stages.length) {
    errors.push("Etapas do funil: a ordem não pode repetir");
  }
  if (stages.length > 0 && stages[0].outcome !== "open") {
    errors.push("A primeira etapa do funil precisa ser uma etapa aberta");
  }
  if (stages.filter((s) => s.outcome === "won").length > 1 || stages.filter((s) => s.outcome === "lost").length > 1) {
    errors.push("O funil aceita no máximo uma etapa de ganho e uma de perda");
  }
  if (new Set(stages.map((s) => s.name.toLowerCase())).size !== stages.length) {
    errors.push("Etapas do funil: nomes repetidos");
  }
  const funnel = { name: text("Nome do funil", input.funnel.name, L.funnelName, { required: true }), stages };

  // Campos personalizados
  count("Campos personalizados", input.customFields.length, L.customFieldsMax);
  const customFields = input.customFields.map((f, i) => {
    const name = text(`Campo ${i + 1}`, f.name, L.customFieldName, { required: true });
    if (name && !fieldKeyFromName(name)) errors.push(`Campo ${i + 1}: use letras ou números no nome`);
    const needsOptions = f.type === "select" || f.type === "multiselect";
    let options: string[] | undefined;
    if (f.options !== undefined || needsOptions) {
      const raw = f.options ?? [];
      count(`Opções do campo ${i + 1}`, raw.length, L.customFieldOptionsMax, needsOptions ? 1 : 0);
      options = raw.map((o, j) => text(`Opção ${j + 1} do campo ${i + 1}`, o, L.customFieldOption, { required: true }));
      if (!needsOptions) options = undefined;
    }
    return { name, type: f.type, ...(options ? { options } : {}) };
  });
  const keys = customFields.map((f) => fieldKeyFromName(f.name));
  if (new Set(keys).size !== keys.length) errors.push("Campos personalizados: nomes repetidos");

  // Persona (campos fechados)
  const attendantName = text("Nome do atendente", input.persona.attendantName, L.attendantName, {
    required: true,
  });
  if (attendantName && !ATTENDANT_NAME_RE.test(attendantName)) {
    errors.push("Nome do atendente: use só letras, espaço, apóstrofo, ponto ou hífen");
  }
  const languages = Array.from(new Set(input.persona.languages));
  count("Idiomas do atendente", languages.length, L.languagesMax, L.languagesMin);
  const persona = {
    attendantName,
    tone: input.persona.tone,
    addressAs: input.persona.addressAs,
    languages,
    presentsAsAi: true as const,
  };

  const greeting = input.greeting
    ? {
        text: text("Saudação", input.greeting.text, L.greeting, { required: true, multiline: true }),
        ...flags("saudação", input.greeting),
      }
    : undefined;

  count("Itens de conhecimento", input.knowledge.length, L.knowledgeMax);
  const knowledge = input.knowledge.map((k, i) => ({
    text: text(`Conhecimento ${i + 1}`, k.text, L.knowledgeText, { required: true, multiline: true }),
    origin: {
      kind: k.origin.kind,
      ...(k.origin.reference !== undefined
        ? { reference: optText(`Origem do conhecimento ${i + 1}`, k.origin.reference, L.originReference) }
        : {}),
    },
    ...flags(`conhecimento ${i + 1}`, k),
  }));
  for (const k of knowledge) if (k.origin.reference === undefined) delete k.origin.reference;

  count("Respostas rápidas", input.quickReplies.length, L.quickRepliesMax);
  const quickReplies = input.quickReplies.map((q, i) => {
    const shortcut = cleanDraftText(q.shortcut).replace(/^\//, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]{0,23}$/.test(shortcut)) {
      errors.push(`Resposta rápida ${i + 1}: atalho com letras, números, hífen (até ${L.quickReplyShortcut})`);
    }
    return {
      shortcut,
      text: text(`Resposta rápida ${i + 1}`, q.text, L.quickReplyText, { required: true, multiline: true }),
      ...flags(`resposta rápida ${i + 1}`, q),
    };
  });
  if (new Set(quickReplies.map((q) => q.shortcut)).size !== quickReplies.length) {
    errors.push("Respostas rápidas: atalhos repetidos");
  }

  let businessHours: OnboardingDraft["businessHours"];
  if (input.businessHours) {
    const days = Array.from(new Set(input.businessHours.days)).sort((a, b) => a - b);
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      errors.push("Horário de atendimento: dias de 0 (domingo) a 6 (sábado), ao menos um");
    }
    const start = cleanDraftText(input.businessHours.start);
    const end = cleanDraftText(input.businessHours.end);
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
      errors.push("Horário de atendimento: use HH:MM");
    } else if (start >= end) {
      errors.push("Horário de atendimento: o início precisa ser antes do fim");
    }
    businessHours = { days, start, end };
  }

  count("Regras de repasse", input.handoffRules.length, L.handoffRulesMax);
  const handoffRules = input.handoffRules.map((r, i) => ({
    kind: r.kind,
    note: optText(`Regra de repasse ${i + 1}`, r.note, L.handoffNote),
    ...flags(`regra de repasse ${i + 1}`, r),
  }));

  const blocked = input.blocked?.slice(0, L.blockedMax).map((b) => ({
    field: cleanDraftText(b.field).slice(0, 80),
    label: cleanDraftText(b.label).slice(0, 120),
    reason: cleanDraftText(b.reason).slice(0, L.suspicionReason),
  }));

  if (errors.length > 0) return { ok: false, errors };

  const draft: OnboardingDraft = {
    version: 1,
    business: dropUndefined(business),
    funnel,
    customFields,
    persona,
    ...(greeting ? { greeting: dropUndefined(greeting) } : {}),
    knowledge: knowledge.map(dropUndefined),
    quickReplies: quickReplies.map(dropUndefined),
    ...(businessHours ? { businessHours } : {}),
    handoffRules: handoffRules.map(dropUndefined),
    features: {
      vision: input.features.vision,
      transcription: input.features.transcription,
      dateTime: input.features.dateTime,
      translation: input.features.translation,
      voice: input.features.voice,
    },
    ...(blocked && blocked.length > 0 ? { blocked } : {}),
    ...(input.planInterest ? { planInterest: input.planInterest } : {}),
  };
  return { ok: true, draft };
}

/** Lança `ConvexError` com os erros em PT-BR (até 10) se o rascunho for inválido. */
export function assertValidDraft(input: OnboardingDraft): OnboardingDraft {
  const result = normalizeDraft(input);
  if (!result.ok) {
    throw new ConvexError(`Rascunho inválido: ${result.errors.slice(0, 10).join("; ")}`);
  }
  return result.draft;
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/** Serialização estável (chaves ordenadas) para o hash do rascunho. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex do rascunho normalizado (Web Crypto, runtime padrão do Convex). */
export async function draftHash(draft: OnboardingDraft): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(draft));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
