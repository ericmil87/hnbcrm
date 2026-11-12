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
import { CARD_SECTION, cardSignature, type ApprovalSection, type DraftCardKind } from "./onboardingRoadmap";

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
  "ativarIa",
  "operacaoPronta",
] as const;
export type OnboardingBlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCK_NOTE_MAX = 140;

/** Aviso antes do 1º material da sessão (LGPD / transferência internacional). Texto fixo do servidor. */
export const MATERIALS_NOTICE_TEXT =
  "O material que você enviar é lido por IA de provedores parceiros, inclusive fora do Brasil. Não envie dados pessoais de clientes.";
export const BLOCKS_PER_TURN_MAX = 4;

/**
 * Cartões de AÇÃO: quem anexa é o ESTADO da sessão (`lib/onboardingRoadmap.ts`),
 * nunca o pedido do modelo. Um pedido do modelo para estes tipos é ignorado.
 */
export const ACTION_BLOCK_KINDS: readonly OnboardingBlockKind[] = [
  "cartaoConta",
  "cartaoAceite",
  "aplicarOperacao",
  "simulador",
  "conectarCanal",
  "proximosPassos",
  "avisoMateriais",
  "ativarIa",
  "operacaoPronta",
  "uploadProgresso",
];

/**
 * "Para que serve" de cada cartão: uma frase fixa, humana, que ensina enquanto
 * a conversa anda (não depende de o modelo lembrar de explicar).
 */
export const CARD_PURPOSE = {
  resumoNegocio: "É como o CRM e a sua IA entendem o seu negócio.",
  funilPreview:
    "Funil é o caminho que cada cliente faz, do primeiro oi até fechar. Você enxerga de relance quem está em cada etapa.",
  personaCard: "É o jeito de a sua IA atender: o nome dela, o tom da conversa e quando ela chama você.",
  conhecimentoLista:
    "É o que a sua IA sabe para responder: preços, serviços, endereço. Ela só afirma o que estiver nesta lista.",
  respostasRapidas: "Textos prontos que você e a equipe mandam com um toque, sem digitar tudo de novo.",
  traducaoCartao:
    "O cliente escreve em outro idioma, você lê em português e responde em português. Ele recebe no idioma dele.",
} as const;

/** Quando a IA chama a equipe, em palavras simples (rótulos fixos por tipo de regra). */
export const HANDOFF_SHORT_LABEL: Record<OnboardingDraft["handoffRules"][number]["kind"], string> = {
  pedido_humano: "o cliente pede para falar com uma pessoa",
  reclamacao: "há uma reclamação",
  pagamento: "o assunto é pagamento ou reembolso",
  negociacao_preco: "o cliente pede desconto",
  agendamento: "é preciso confirmar ou marcar um horário",
  urgencia: "o cliente diz que é urgente",
  fora_do_escopo: "o pedido foge do que você atende",
  outro: "acontece a situação que você descreveu",
};

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "Atende 24h, todos os dias" ou "seg a sex, das 09:00 às 18:00". */
export function hoursLabel(hours: OnboardingDraft["businessHours"]): string {
  if (!hours) return "Atende 24h, todos os dias";
  const d = hours.days;
  const contiguous = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const days = d.length === 7 ? "todos os dias" : contiguous ? `${WEEKDAY_SHORT[d[0]]} a ${WEEKDAY_SHORT[d[d.length - 1]]}` : d.map((x) => WEEKDAY_SHORT[x]).join(", ");
  return `Atende ${days}, das ${hours.start} às ${hours.end}`;
}

/**
 * Leads de EXEMPLO da animação do funil: nomes e notas FIXOS, escolhidos por
 * palavra-chave da descrição do negócio (nunca texto do modelo nem da pessoa).
 */
const EXAMPLE_LEAD_NAMES = ["Família Souza", "Marina", "Carlos e Ana", "Seu João"];
const EXAMPLE_LEAD_NOTES: Array<{ re: RegExp; notes: string[] }> = [
  { re: /passeio|buggy|bugue|turis|excurs|trilha|mergulho|jangada|pousada|hotel|viagem/, notes: ["passeio de 4h", "quer para sábado", "grupo de 6 pessoas", "pediu o roteiro"] },
  { re: /restaurante|pizz|lanch|marmit|delivery|comida|bolo|doce|confeit/, notes: ["encomenda para sábado", "pediu o cardápio", "festa de 30 pessoas", "quer entrega"] },
  { re: /clinic|consult|dent|odont|psic|fisio|estetic|medic|terapi/, notes: ["primeira consulta", "quer horário à tarde", "perguntou o valor", "retorno"] },
  { re: /imov|imobili|apartamento|casa|aluguel|corretor/, notes: ["apartamento de 2 quartos", "quer visitar", "aluguel até R$ 2.500", "casa com quintal"] },
  { re: /salao|cabel|barb|unha|manicure|beleza|sobrancelha/, notes: ["corte e escova", "quer sábado cedo", "perguntou o preço", "pacote de noiva"] },
  { re: /curso|aula|escola|treinamento|mentoria|professor/, notes: ["turma de sábado", "pediu a grade", "perguntou o valor", "quer aula teste"] },
  { re: /loja|roupa|produto|venda|e-?commerce|estoque/, notes: ["pediu o catálogo", "tamanho M", "quer frete", "perguntou o prazo"] },
];
const EXAMPLE_LEAD_DEFAULT = ["pediu orçamento", "quer agendar", "perguntou o preço", "tirou uma dúvida"];

export function exampleLeads(draft: OnboardingDraft | null): Array<{ name: string; note: string }> {
  const text = `${draft?.business.description ?? ""} ${draft?.business.name ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const notes = EXAMPLE_LEAD_NOTES.find((n) => n.re.test(text))?.notes ?? EXAMPLE_LEAD_DEFAULT;
  return EXAMPLE_LEAD_NAMES.map((name, i) => ({ name, note: notes[i] }));
}

const note = { note: v.optional(v.string()) };
/**
 * Campos ADITIVOS dos cartões do rascunho (mensagens antigas não os têm):
 * `purpose` = frase fixa "para que serve"; `sig` = assinatura do conteúdo
 * (`cardSignature`); `approval` = estado do "Está bom, seguir" no momento do turno
 * (a tela recalcula com o estado vivo).
 */
const cardMeta = {
  purpose: v.optional(v.string()),
  sig: v.optional(v.string()),
  approval: v.optional(v.union(v.literal("pending"), v.literal("approved"))),
};
const operationSummaryValidator = v.object({
  businessName: v.string(),
  funnelName: v.string(),
  stageCount: v.number(),
  attendantName: v.string(),
  knowledgeCount: v.number(),
  quickReplyCount: v.number(),
  hoursLabel: v.string(),
});
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
    /** Endereço mascarado para onde o código foi (ex.: "bu…te@milfont.net"). */
    maskedEmail: v.optional(v.string()),
    /** Materiais guardados à espera da confirmação. */
    pendingCount: v.optional(v.number()),
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
    ...cardMeta,
    ...note,
  }),
  v.object({
    kind: v.literal("funilPreview"),
    funnelName: v.string(),
    stages: v.array(v.object({ name: v.string(), outcome: outcomeValidator })),
    customFields: v.array(v.object({ name: v.string(), type: v.string() })),
    /** Etapa/campo marcado (bloqueia a aplicação até ser editado). */
    blockedCount: v.number(),
    /** Leads fictícios da animação (nomes e notas fixos do servidor; sempre marcados como exemplo). */
    examples: v.optional(v.array(v.object({ name: v.string(), note: v.string() }))),
    ...cardMeta,
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
    /** Sem horário definido = atende 24h (padrão). */
    alwaysOn: v.optional(v.boolean()),
    hoursLabel: v.optional(v.string()),
    /** Quando a IA chama a equipe (rótulos fixos por tipo de regra). */
    handoff: v.optional(v.array(v.string())),
    ...cardMeta,
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
    ...cardMeta,
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
    ...cardMeta,
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
  v.object({ kind: v.literal("traducaoCartao"), enabled: v.boolean(), ...cardMeta, ...note }),
  /**
   * Aviso obrigatório antes do 1º material: o botão de ciência chama
   * `onboardingChat.ackMaterialsNotice` (clique do usuário; nunca automático).
   */
  v.object({ kind: v.literal("avisoMateriais"), text: v.string(), acknowledged: v.boolean(), ...note }),
  /**
   * "Ativar a sua IA": um único momento com o aceite de IA/LGPD (caixa marcada
   * pela pessoa), a escolha do modo do atendente e "Montar minha operação". O
   * cartão NÃO executa nada: o clique chama, nesta ordem, as mutations que já
   * existem (`aiSettings.setAiEnabled`, `onboardingSessions.applyOnboardingDraft`
   * e, se a pessoa escolheu Responder sozinha, `aiSettings.updateAgentProfile`
   * com `autopilotRiskAck`), cada uma com a sua auditoria.
   */
  v.object({
    kind: v.literal("ativarIa"),
    draftHash: v.string(),
    draftVersion: v.number(),
    canApply: v.boolean(),
    blockedCount: v.number(),
    flaggedCount: v.number(),
    aiActive: v.boolean(),
    alreadyApplied: v.boolean(),
    /** Modo pré-selecionado (sempre uma escolha visível; nada liga sem o clique). */
    recommendedMode: v.union(v.literal("autopilot"), v.literal("suggest")),
    summary: operationSummaryValidator,
    ...note,
  }),
  /** Estado final: o que foi criado + os três próximos passos (testar, conectar, abrir o CRM). */
  v.object({
    kind: v.literal("operacaoPronta"),
    summary: operationSummaryValidator,
    tested: v.boolean(),
    connected: v.boolean(),
    aiActive: v.boolean(),
    /** Perguntas de exemplo para o teste (do modelo do segmento). */
    prompts: v.array(v.string()),
    ...note,
  }),
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
  /** Assinaturas aprovadas por seção (`onboardingSessions.approvals`). */
  approvals?: Partial<Record<ApprovalSection, string>>;
  /** Endereço mascarado da conta (cartão de e-mail). */
  maskedEmail?: string;
  /** Materiais guardados à espera da confirmação do e-mail. */
  pendingMaterials?: number;
  tested?: boolean;
  connected?: boolean;
};

/** Modo que o cartão "Ativar a sua IA" traz pré-selecionado (decisão do dono: IA pronta para atender 24h). */
export const RECOMMENDED_ATTENDANT_MODE: "autopilot" | "suggest" = "autopilot";

function operationSummary(d: OnboardingDraft) {
  return {
    businessName: d.business.name,
    funnelName: d.funnel.name,
    stageCount: d.funnel.stages.length,
    attendantName: d.persona.attendantName,
    knowledgeCount: d.knowledge.filter((k) => !k.suspicious || k.release?.at !== undefined).length,
    quickReplyCount: d.quickReplies.filter((q) => !q.suspicious || q.release?.at !== undefined).length,
    hoursLabel: hoursLabel(d.businessHours),
  };
}

function flaggedCountOf(d: OnboardingDraft): number {
  return (
    (d.business.suspicious ? 1 : 0) +
    (d.greeting?.suspicious ? 1 : 0) +
    d.knowledge.filter((k) => k.suspicious).length +
    d.quickReplies.filter((q) => q.suspicious).length +
    d.handoffRules.filter((r) => r.suspicious).length
  );
}

/** `purpose` + `sig` + `approval` de um cartão do rascunho. */
function metaOf(kind: DraftCardKind, ctx: BlockContext) {
  const sig = cardSignature(ctx.draft, kind);
  const section = CARD_SECTION[kind];
  return {
    purpose: CARD_PURPOSE[kind],
    ...(sig ? { sig } : {}),
    ...(section
      ? { approval: ctx.approvals?.[section] !== undefined && ctx.approvals[section] === sig ? ("approved" as const) : ("pending" as const) }
      : {}),
  };
}

const TONE_LABEL: Record<OnboardingDraft["persona"]["tone"], string> = {
  formal: "formal",
  amigavel: "amigável",
  descontraido: "descontraído",
};

/** Referência de origem do que a pessoa contou na conversa (igual a `CONVERSATION_REFERENCE` do entrevistador). */
export const CONVERSATION_ORIGIN_REFERENCE = "conversa";

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
        {
          kind: "cartaoConta" as const,
          emailVerified: ctx.emailVerified,
          materialsUnlocked: ctx.emailVerified,
          ...(ctx.maskedEmail ? { maskedEmail: ctx.maskedEmail } : {}),
          ...(ctx.pendingMaterials ? { pendingCount: ctx.pendingMaterials } : {}),
        },
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
          ...metaOf("resumoNegocio", ctx),
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
          examples: exampleLeads(d),
          ...metaOf("funilPreview", ctx),
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
          alwaysOn: d.businessHours === undefined,
          hoursLabel: hoursLabel(d.businessHours),
          handoff: Array.from(new Set(d.handoffRules.filter((r) => !r.suspicious || r.release?.at !== undefined).map((r) => HANDOFF_SHORT_LABEL[r.kind]))),
          ...metaOf("personaCard", ctx),
        },
        n,
      );
    }
    case "conhecimentoLista": {
      if (!d) return null;
      const items = d.knowledge.map((k, index) => {
        // Procedência VERDADEIRA: o que a pessoa contou na conversa é gravado com
        // origem externa por segurança (o caminho da IA nunca alega "usuario"),
        // mas a referência "conversa" diz de onde veio: digitado = "Você contou",
        // áudio = "Do áudio". Nunca "Do site".
        const fromChat = k.origin.reference === CONVERSATION_ORIGIN_REFERENCE;
        const shownKind = fromChat && k.origin.kind !== "audio" ? ("usuario" as const) : k.origin.kind;
        return {
        index,
        text: k.text,
        originKind: shownKind,
        originLabel:
          fromChat
            ? ORIGIN_LABEL[shownKind]
            : k.origin.reference
              ? `${ORIGIN_LABEL[k.origin.kind]}: ${k.origin.reference}`
              : ORIGIN_LABEL[k.origin.kind],
        suspicious: k.suspicious,
        ...(k.suspicionReason ? { suspicionReason: k.suspicionReason } : {}),
        verifiedInSource: k.verifiedInSource === true,
        released: k.release?.at !== undefined,
        };
      });
      return withNote(
        {
          kind: "conhecimentoLista" as const,
          items,
          total: items.length,
          flagged: items.filter((i) => i.suspicious).length,
          ...metaOf("conhecimentoLista", ctx),
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
          ...metaOf("respostasRapidas", ctx),
        },
        n,
      );
    }
    case "uploadProgresso":
      return ctx.upload ? withNote({ kind: "uploadProgresso" as const, ...ctx.upload }, n) : null;
    case "aplicarOperacao": {
      if (!d || !ctx.draftHash) return null;
      const blockedCount = d.blocked?.length ?? 0;
      const flaggedCount = flaggedCountOf(d);
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
      return withNote(
        { kind: "traducaoCartao" as const, enabled: d?.features.translation ?? true, ...(d ? metaOf("traducaoCartao", ctx) : { purpose: CARD_PURPOSE.traducaoCartao }) },
        n,
      );
    case "ativarIa": {
      if (!d || !ctx.draftHash) return null;
      const blockedCount = d.blocked?.length ?? 0;
      return withNote(
        {
          kind: "ativarIa" as const,
          draftHash: ctx.draftHash,
          draftVersion: ctx.draftVersion,
          canApply: blockedCount === 0,
          blockedCount,
          flaggedCount: flaggedCountOf(d),
          aiActive: ctx.aiActive,
          alreadyApplied: ctx.appliedDraftHash !== null && ctx.appliedDraftHash === ctx.draftHash,
          recommendedMode: RECOMMENDED_ATTENDANT_MODE,
          summary: operationSummary(d),
        },
        n,
      );
    }
    case "operacaoPronta": {
      if (!d || ctx.appliedDraftHash === null) return null;
      return withNote(
        {
          kind: "operacaoPronta" as const,
          summary: operationSummary(d),
          tested: ctx.tested === true,
          connected: ctx.connected === true,
          aiActive: ctx.aiActive,
          prompts: segmentTemplate(d.business.segment).simulatorPrompts.slice(0, 3),
        },
        n,
      );
    }
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
