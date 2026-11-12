/**
 * Blocos ricos do onboarding conversacional v2 (plano 4.2) — contrato com o
 * frontend (P3.x). PURO.
 *
 * Regra de segurança: o MODELO só escolhe QUAL bloco mostrar (lista fechada
 * `BLOCK_KINDS`) e, no máximo, uma nota curta (`note`, saneada). TODO o resto
 * do payload é montado AQUI, pelo servidor, a partir do rascunho validado e
 * do estado da sessão. Nenhum bloco executa ação: `cartaoAceite`,
 * `aplicarOperacao`, `conectarCanal` e `simulador` são convites para um
 * clique que chama as mutations/telas que já existem.
 */
import { v, type Infer } from "convex/values";
import { languageCodeValidator } from "./languages";
import type { OnboardingDraft } from "./onboardingDraft";
import { segmentTemplate } from "./onboardingTemplates";

export const BLOCK_KINDS = [
  "chips",
  "cartaoConta",
  "cartaoAceite",
  "resumoNegocio",
  "funilPreview",
  "personaCard",
  "conhecimentoLista",
  "respostasRapidas",
  "uploadProgresso",
  "aplicarOperacao",
  "simulador",
  "conectarCanal",
  "proximosPassos",
  "traducaoCartao",
  "avisoMateriais",
] as const;
export type OnboardingBlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCK_NOTE_MAX = 140;

/** Aviso antes do 1º material da sessão (LGPD / transferência internacional). Texto fixo do servidor. */
export const MATERIALS_NOTICE_TEXT =
  "O material que você enviar é lido por IA de provedores parceiros, inclusive fora do Brasil. Não envie dados pessoais de clientes.";
export const BLOCKS_PER_TURN_MAX = 4;

const note = { note: v.optional(v.string()) };
const outcomeValidator = v.union(v.literal("open"), v.literal("won"), v.literal("lost"));
const originKindValidator = v.union(
  v.literal("usuario"),
  v.literal("site"),
  v.literal("pdf"),
  v.literal("imagem"),
  v.literal("audio"),
  v.literal("template"),
);
const materialKindValidator = v.union(v.literal("site"), v.literal("pdf"), v.literal("imagem"), v.literal("audio"));

export const onboardingBlockValidator = v.union(
  v.object({ kind: v.literal("chips"), options: v.array(v.string()), ...note }),
  /** Estado da conta: e-mail confirmado libera materiais (D2). */
  v.object({
    kind: v.literal("cartaoConta"),
    emailVerified: v.boolean(),
    materialsUnlocked: v.boolean(),
    ...note,
  }),
  /** Convite para o aceite de IA/LGPD (o clique chama `aiSettings.setAiEnabled`; nada é aceito aqui). */
  v.object({ kind: v.literal("cartaoAceite"), consent: v.literal("ai_lgpd"), aiActive: v.boolean(), ...note }),
  v.object({
    kind: v.literal("resumoNegocio"),
    name: v.string(),
    segment: v.string(),
    segmentLabel: v.string(),
    description: v.string(),
    city: v.optional(v.string()),
    suspicious: v.boolean(),
    suspicionReason: v.optional(v.string()),
    ...note,
  }),
  v.object({
    kind: v.literal("funilPreview"),
    funnelName: v.string(),
    stages: v.array(v.object({ name: v.string(), outcome: outcomeValidator })),
    customFields: v.array(v.object({ name: v.string(), type: v.string() })),
    /** Etapa/campo marcado (bloqueia a aplicação até ser editado). */
    blockedCount: v.number(),
    ...note,
  }),
  v.object({
    kind: v.literal("personaCard"),
    attendantName: v.string(),
    tone: v.union(v.literal("formal"), v.literal("amigavel"), v.literal("descontraido")),
    toneLabel: v.string(),
    addressAs: v.union(v.literal("voce"), v.literal("senhor")),
    languages: v.array(languageCodeValidator),
    presentsAsAi: v.literal(true),
    greeting: v.optional(v.object({ text: v.string(), suspicious: v.boolean() })),
    ...note,
  }),
  v.object({
    kind: v.literal("conhecimentoLista"),
    items: v.array(
      v.object({
        index: v.number(),
        text: v.string(),
        originKind: originKindValidator,
        originLabel: v.optional(v.string()),
        suspicious: v.boolean(),
        suspicionReason: v.optional(v.string()),
        verifiedInSource: v.boolean(),
        released: v.boolean(),
      }),
    ),
    total: v.number(),
    flagged: v.number(),
    ...note,
  }),
  v.object({
    kind: v.literal("respostasRapidas"),
    items: v.array(
      v.object({
        shortcut: v.string(),
        text: v.string(),
        suspicious: v.boolean(),
        suspicionReason: v.optional(v.string()),
      }),
    ),
    ...note,
  }),
  /** Resultado da leitura de um material neste turno (montado pelo pipeline, nunca pelo modelo). */
  v.object({
    kind: v.literal("uploadProgresso"),
    sourceKind: materialKindValidator,
    label: v.string(),
    status: v.union(v.literal("lido"), v.literal("falhou")),
    itemsAdded: v.number(),
    flagged: v.number(),
    message: v.optional(v.string()),
    ...note,
  }),
  /** Convite para "Montar minha operação" (`onboardingSessions.applyOnboardingDraft` com `expectedDraftHash`). */
  v.object({
    kind: v.literal("aplicarOperacao"),
    draftHash: v.string(),
    draftVersion: v.number(),
    canApply: v.boolean(),
    blockedCount: v.number(),
    flaggedCount: v.number(),
    aiActive: v.boolean(),
    alreadyApplied: v.boolean(),
    ...note,
  }),
  /** Convite para testar a IA. O simulador NUNCA é chamado por aqui; antes do aceite fica indisponível. */
  v.object({
    kind: v.literal("simulador"),
    available: v.boolean(),
    reason: v.optional(v.union(v.literal("ai_inactive"), v.literal("not_applied"))),
    prompts: v.array(v.string()),
    ...note,
  }),
  v.object({ kind: v.literal("conectarCanal"), channel: v.literal("whatsapp"), ...note }),
  v.object({
    kind: v.literal("proximosPassos"),
    steps: v.array(
      v.object({
        id: v.union(
          v.literal("conectar_whatsapp"),
          v.literal("convidar_equipe"),
          v.literal("comunidade"),
          v.literal("consultoria"),
        ),
        label: v.string(),
      }),
    ),
    ...note,
  }),
  v.object({ kind: v.literal("traducaoCartao"), enabled: v.boolean(), ...note }),
  /**
   * Aviso obrigatório antes do 1º material: o botão de ciência chama
   * `onboardingChat.ackMaterialsNotice` (clique do usuário; nunca automático).
   */
  v.object({ kind: v.literal("avisoMateriais"), text: v.string(), acknowledged: v.boolean(), ...note }),
);

export type OnboardingBlock = Infer<typeof onboardingBlockValidator>;

/** Pedido do modelo: só o tipo e uma nota curta (já saneada por quem chama). */
export type BlockRequest = { kind: OnboardingBlockKind; note?: string };

export type UploadOutcome = {
  sourceKind: "site" | "pdf" | "imagem" | "audio";
  label: string;
  status: "lido" | "falhou";
  itemsAdded: number;
  flagged: number;
  message?: string;
};

export type BlockContext = {
  draft: OnboardingDraft | null;
  draftHash: string | null;
  draftVersion: number;
  appliedDraftHash: string | null;
  emailVerified: boolean;
  aiActive: boolean;
  /** Ciência do aviso de materiais já registrada nesta sessão. */
  materialsNoticeAck?: boolean;
  upload?: UploadOutcome;
};

const TONE_LABEL: Record<OnboardingDraft["persona"]["tone"], string> = {
  formal: "formal",
  amigavel: "amigável",
  descontraido: "descontraído",
};

const ORIGIN_LABEL: Record<string, string> = {
  usuario: "Você contou",
  site: "Do site",
  pdf: "Do PDF",
  imagem: "Da imagem",
  audio: "Do áudio",
  template: "Modelo do segmento",
};

function withNote<T extends object>(block: T, n?: string): T & { note?: string } {
  return n ? { ...block, note: n } : block;
}

/** Monta UM bloco a partir do estado do servidor; `null` se não há dado para ele. */
export function buildBlock(req: BlockRequest, ctx: BlockContext, chips: string[] = []): OnboardingBlock | null {
  const d = ctx.draft;
  const n = req.note;
  switch (req.kind) {
    case "chips":
      return chips.length > 0 ? withNote({ kind: "chips" as const, options: chips }, n) : null;
    case "cartaoConta":
      return withNote(
        { kind: "cartaoConta" as const, emailVerified: ctx.emailVerified, materialsUnlocked: ctx.emailVerified },
        n,
      );
    case "cartaoAceite":
      return withNote({ kind: "cartaoAceite" as const, consent: "ai_lgpd" as const, aiActive: ctx.aiActive }, n);
    case "resumoNegocio": {
      if (!d) return null;
      const b = d.business;
      return withNote(
        {
          kind: "resumoNegocio" as const,
          name: b.name,
          segment: b.segment,
          segmentLabel: segmentTemplate(b.segment).label,
          description: b.description,
          ...(b.city ? { city: b.city } : {}),
          suspicious: b.suspicious,
          ...(b.suspicionReason ? { suspicionReason: b.suspicionReason } : {}),
        },
        n,
      );
    }
    case "funilPreview": {
      if (!d) return null;
      const blockedCount = (d.blocked ?? []).filter(
        (x) => x.field.startsWith("funnel.") || x.field.startsWith("customFields"),
      ).length;
      return withNote(
        {
          kind: "funilPreview" as const,
          funnelName: d.funnel.name,
          stages: d.funnel.stages.map((s) => ({ name: s.name, outcome: s.outcome ?? ("open" as const) })),
          customFields: d.customFields.map((f) => ({ name: f.name, type: f.type })),
          blockedCount,
        },
        n,
      );
    }
    case "personaCard": {
      if (!d) return null;
      const p = d.persona;
      return withNote(
        {
          kind: "personaCard" as const,
          attendantName: p.attendantName,
          tone: p.tone,
          toneLabel: TONE_LABEL[p.tone],
          addressAs: p.addressAs,
          languages: p.languages,
          presentsAsAi: true as const,
          ...(d.greeting ? { greeting: { text: d.greeting.text, suspicious: d.greeting.suspicious } } : {}),
        },
        n,
      );
    }
    case "conhecimentoLista": {
      if (!d) return null;
      const items = d.knowledge.map((k, index) => ({
        index,
        text: k.text,
        originKind: k.origin.kind,
        originLabel:
          k.origin.reference === "conversa"
            ? "Da conversa"
            : k.origin.reference
              ? `${ORIGIN_LABEL[k.origin.kind]}: ${k.origin.reference}`
              : ORIGIN_LABEL[k.origin.kind],
        suspicious: k.suspicious,
        ...(k.suspicionReason ? { suspicionReason: k.suspicionReason } : {}),
        verifiedInSource: k.verifiedInSource === true,
        released: k.release?.at !== undefined,
      }));
      return withNote(
        {
          kind: "conhecimentoLista" as const,
          items,
          total: items.length,
          flagged: items.filter((i) => i.suspicious).length,
        },
        n,
      );
    }
    case "respostasRapidas": {
      if (!d || d.quickReplies.length === 0) return null;
      return withNote(
        {
          kind: "respostasRapidas" as const,
          items: d.quickReplies.map((q) => ({
            shortcut: q.shortcut,
            text: q.text,
            suspicious: q.suspicious,
            ...(q.suspicionReason ? { suspicionReason: q.suspicionReason } : {}),
          })),
        },
        n,
      );
    }
    case "uploadProgresso":
      return ctx.upload ? withNote({ kind: "uploadProgresso" as const, ...ctx.upload }, n) : null;
    case "aplicarOperacao": {
      if (!d || !ctx.draftHash) return null;
      const blockedCount = d.blocked?.length ?? 0;
      const flaggedCount =
        (d.business.suspicious ? 1 : 0) +
        (d.greeting?.suspicious ? 1 : 0) +
        d.knowledge.filter((k) => k.suspicious).length +
        d.quickReplies.filter((q) => q.suspicious).length +
        d.handoffRules.filter((r) => r.suspicious).length;
      return withNote(
        {
          kind: "aplicarOperacao" as const,
          draftHash: ctx.draftHash,
          draftVersion: ctx.draftVersion,
          canApply: blockedCount === 0,
          blockedCount,
          flaggedCount,
          aiActive: ctx.aiActive,
          alreadyApplied: ctx.appliedDraftHash !== null && ctx.appliedDraftHash === ctx.draftHash,
        },
        n,
      );
    }
    case "simulador": {
      const applied = ctx.appliedDraftHash !== null;
      const reason = !ctx.aiActive ? ("ai_inactive" as const) : !applied ? ("not_applied" as const) : undefined;
      return withNote(
        {
          kind: "simulador" as const,
          available: reason === undefined,
          ...(reason ? { reason } : {}),
          prompts: segmentTemplate(d?.business.segment).simulatorPrompts.slice(0, 3),
        },
        n,
      );
    }
    case "conectarCanal":
      return withNote({ kind: "conectarCanal" as const, channel: "whatsapp" as const }, n);
    case "proximosPassos":
      return withNote(
        {
          kind: "proximosPassos" as const,
          steps: [
            { id: "conectar_whatsapp" as const, label: "Conectar o WhatsApp" },
            { id: "convidar_equipe" as const, label: "Convidar a equipe" },
            { id: "comunidade" as const, label: "Entrar na comunidade" },
            { id: "consultoria" as const, label: "Pedir uma consultoria" },
          ],
        },
        n,
      );
    case "traducaoCartao":
      return withNote({ kind: "traducaoCartao" as const, enabled: d?.features.translation ?? true }, n);
    case "avisoMateriais":
      return withNote(
        { kind: "avisoMateriais" as const, text: MATERIALS_NOTICE_TEXT, acknowledged: ctx.materialsNoticeAck === true },
        n,
      );
  }
}

/**
 * Lista final de blocos de um turno: pedidos do modelo (deduplicados, na
 * ordem, até `BLOCKS_PER_TURN_MAX`) + os que o servidor sempre acrescenta
 * (`forced`, ex.: `uploadProgresso` quando houve material, `funilPreview` no
 * primeiro turno). Pedido sem dado (sem rascunho etc.) é descartado.
 */
export function buildBlocks(
  requests: BlockRequest[],
  ctx: BlockContext,
  opts: { forced?: OnboardingBlockKind[]; chips?: string[] } = {},
): OnboardingBlock[] {
  const out: OnboardingBlock[] = [];
  const seen = new Set<OnboardingBlockKind>();
  const push = (req: BlockRequest) => {
    if (seen.has(req.kind)) return;
    const block = buildBlock(req, ctx, opts.chips);
    if (!block) return;
    seen.add(req.kind);
    out.push(block);
  };
  for (const kind of opts.forced ?? []) push({ kind });
  for (const req of requests) {
    if (out.length >= BLOCKS_PER_TURN_MAX + (opts.forced?.length ?? 0)) break;
    // `chips` vai no campo próprio da mensagem; como bloco só se pedido explicitamente.
    push(req);
  }
  return out;
}

export function isBlockKind(value: unknown): value is OnboardingBlockKind {
  return typeof value === "string" && (BLOCK_KINDS as readonly string[]).includes(value);
}
