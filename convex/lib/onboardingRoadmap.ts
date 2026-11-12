/**
 * Roteiro determinístico da conversa de configuração (`/comecar`). PURO (sem
 * `ctx`, sem `_generated`): o servidor e a tela importam as MESMAS regras.
 *
 * Princípio: o ESTADO da sessão decide o próximo passo, os cartões e os textos
 * de apoio; o modelo só escreve as frases e extrai informação. Nada aqui
 * depende de o modelo "lembrar" de mostrar um cartão ou de não repetir uma
 * pergunta.
 *
 * - `nextTask(facts)`: o que falta agora (uma coisa só).
 * - `roadmapProgress(facts)`: barra de etapas em português, MONOTÔNICA
 *   (`reachedStep` guarda o ponto mais avançado já visto; nunca regride).
 * - `sectionSignature` / `cardSignature`: assinatura curta do conteúdo de um
 *   cartão. Aprovação vale para a assinatura aprovada (mudou = pendente de
 *   novo) e um cartão só volta à conversa quando a assinatura muda.
 * - `planTurnCards`: quais cartões entram num turno (sem duplicar).
 * - `coherentChips`: tira sugestões de coisa já concluída ou fora de contexto.
 * - `stepMessage`: a fala determinística do Copiloto depois de uma ação de
 *   cartão (aprovar, confirmar e-mail, ativar, testar, conectar), sem LLM.
 */
import { stableStringify, type OnboardingDraft } from "./onboardingDraft";

// ── Etapas visíveis ─────────────────────────────────────────────────────────

export const ROADMAP_STEPS = [
  { id: "negocio", label: "Negócio" },
  { id: "funil", label: "Funil" },
  { id: "atendente", label: "Atendente" },
  { id: "ativar", label: "Ativar" },
  { id: "testar", label: "Testar" },
  { id: "conectar", label: "Conectar" },
] as const;
export type RoadmapStepId = (typeof ROADMAP_STEPS)[number]["id"];

/** Partes do rascunho que pedem "Está bom, seguir". */
export const APPROVAL_SECTIONS = ["funnel", "persona", "knowledge"] as const;
export type ApprovalSection = (typeof APPROVAL_SECTIONS)[number];

/** O que falta AGORA (uma coisa só). */
export type RoadmapTask =
  | "describe_business"
  | "approve_funnel"
  | "approve_persona"
  | "approve_knowledge"
  | "activate"
  | "test"
  | "connect"
  | "done";

export type RoadmapFacts = {
  draft: OnboardingDraft | null;
  /** Assinatura aprovada por seção (`sectionSignature` no momento do clique). */
  approvals: Partial<Record<ApprovalSection, string>>;
  /** IA ligada + aceite LGPD (`orgAiActive`). */
  aiActive: boolean;
  /** Existe rascunho aplicado (`appliedDraftHash`). */
  applied: boolean;
  /** A pessoa testou a IA (ou pulou o teste). */
  tested: boolean;
  /** Canal conectado, ou a pessoa escolheu conectar depois. */
  connected: boolean;
  emailVerified: boolean;
  /** Índice (0-based) da etapa mais avançada já alcançada. */
  reachedStep?: number;
};

// ── Assinaturas ─────────────────────────────────────────────────────────────

/** FNV-1a 32 bits em hex (síncrono: roda igual no servidor e no navegador). */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function sectionContent(d: OnboardingDraft, section: ApprovalSection): unknown {
  switch (section) {
    case "funnel":
      return {
        name: d.funnel.name,
        stages: d.funnel.stages.map((s) => [s.name, s.outcome ?? "open"]),
        fields: d.customFields.map((f) => [f.name, f.type]),
      };
    case "persona":
      return {
        persona: d.persona,
        greeting: d.greeting?.text ?? null,
        hours: d.businessHours ?? null,
        handoff: d.handoffRules.map((r) => [r.kind, r.note ?? null]),
      };
    case "knowledge":
      return d.knowledge.map((k) => k.text);
  }
}

export function sectionSignature(draft: OnboardingDraft | null, section: ApprovalSection): string {
  return draft ? shortHash(stableStringify(sectionContent(draft, section))) : "";
}

export function isApproved(facts: Pick<RoadmapFacts, "draft" | "approvals">, section: ApprovalSection): boolean {
  const sig = facts.approvals[section];
  return !!facts.draft && sig !== undefined && sig === sectionSignature(facts.draft, section);
}

/** Cartões do rascunho (os que têm assinatura de conteúdo). */
export const DRAFT_CARD_KINDS = [
  "resumoNegocio",
  "funilPreview",
  "personaCard",
  "conhecimentoLista",
  "respostasRapidas",
  "traducaoCartao",
] as const;
export type DraftCardKind = (typeof DRAFT_CARD_KINDS)[number];

export const CARD_SECTION: Partial<Record<DraftCardKind, ApprovalSection>> = {
  funilPreview: "funnel",
  personaCard: "persona",
  conhecimentoLista: "knowledge",
};

export function isDraftCardKind(kind: string): kind is DraftCardKind {
  return (DRAFT_CARD_KINDS as readonly string[]).includes(kind);
}

/** Assinatura do conteúdo de um cartão do rascunho ("" sem rascunho). */
export function cardSignature(draft: OnboardingDraft | null, kind: DraftCardKind): string {
  if (!draft) return "";
  const section = CARD_SECTION[kind];
  if (section) return sectionSignature(draft, section);
  switch (kind) {
    case "resumoNegocio":
      return shortHash(stableStringify([draft.business.name, draft.business.segment, draft.business.description, draft.business.city ?? null]));
    case "respostasRapidas":
      return shortHash(stableStringify(draft.quickReplies.map((q) => [q.shortcut, q.text])));
    case "traducaoCartao":
      return shortHash(String(draft.features.translation));
    default:
      return "";
  }
}

// ── Próximo passo ───────────────────────────────────────────────────────────

/** O negócio já foi contado (descrição preenchida e não marcada). */
export function businessDescribed(draft: OnboardingDraft | null): boolean {
  return !!draft && draft.business.description.trim().length > 0;
}

export function nextTask(facts: RoadmapFacts): RoadmapTask {
  if (facts.applied && facts.aiActive) {
    if (!facts.tested) return "test";
    if (!facts.connected) return "connect";
    return "done";
  }
  if (!businessDescribed(facts.draft)) return "describe_business";
  if (!isApproved(facts, "funnel")) return "approve_funnel";
  if (!isApproved(facts, "persona")) return "approve_persona";
  if (!isApproved(facts, "knowledge")) return "approve_knowledge";
  return "activate";
}

const TASK_STEP: Record<RoadmapTask, number> = {
  describe_business: 0,
  approve_funnel: 1,
  approve_persona: 2,
  approve_knowledge: 2,
  activate: 3,
  test: 4,
  connect: 5,
  done: 5,
};

export function taskStepIndex(task: RoadmapTask): number {
  return TASK_STEP[task];
}

export type RoadmapProgress = {
  /** 1-based. */
  index: number;
  total: number;
  stepId: RoadmapStepId;
  label: string;
  /** 0..1. */
  ratio: number;
  /** "Etapa 2 de 6: Funil". */
  valueText: string;
  complete: boolean;
};

/**
 * Barra de etapas. Nunca regride: vale o maior entre a etapa do que falta
 * agora e `reachedStep` (gravado na sessão). Quem ajusta algo já aprovado
 * volta a ver o cartão, mas a barra fica onde estava.
 */
export function roadmapProgress(facts: RoadmapFacts): RoadmapProgress {
  const task = nextTask(facts);
  const total = ROADMAP_STEPS.length;
  const reached = Number.isInteger(facts.reachedStep) ? Math.min(total - 1, Math.max(0, facts.reachedStep as number)) : 0;
  const i = Math.max(TASK_STEP[task], reached);
  const step = ROADMAP_STEPS[i];
  const complete = task === "done";
  return {
    index: i + 1,
    total,
    stepId: step.id,
    label: step.label,
    ratio: complete ? 1 : (i + 1) / total,
    valueText: complete ? "Configuração concluída" : `Etapa ${i + 1} de ${total}: ${step.label}`,
    complete,
  };
}

/** Cartão que resolve o passo atual (o servidor anexa; o modelo não escolhe). */
export type TaskCardKind = "funilPreview" | "personaCard" | "conhecimentoLista" | "ativarIa" | "operacaoPronta";

export function taskCard(task: RoadmapTask): TaskCardKind | null {
  switch (task) {
    case "describe_business":
      return null;
    case "approve_funnel":
      return "funilPreview";
    case "approve_persona":
      return "personaCard";
    case "approve_knowledge":
      return "conhecimentoLista";
    case "activate":
      return "ativarIa";
    case "test":
    case "connect":
    case "done":
      return "operacaoPronta";
  }
}

/** Botão principal do próximo passo (rodapé da conversa e do painel "Sua operação"). */
export function nextStepLabel(task: RoadmapTask): string {
  switch (task) {
    case "describe_business":
      return "Contar sobre o meu negócio";
    case "approve_funnel":
      return "Ver o meu funil";
    case "approve_persona":
      return "Ver o jeito de atender";
    case "approve_knowledge":
      return "Ver o que a IA sabe";
    case "activate":
      return "Ativar a minha IA";
    case "test":
      return "Testar a minha IA";
    case "connect":
      return "Conectar o WhatsApp";
    case "done":
      return "Abrir o meu CRM";
  }
}

// ── Cartões de um turno (sem duplicar) ──────────────────────────────────────

/** Assinatura do cartão de ação (muda quando o estado que ele mostra muda). */
export function actionCardSignature(
  kind: "ativarIa" | "operacaoPronta",
  s: { draftHash: string | null; appliedDraftHash: string | null; aiActive: boolean; tested: boolean; connected: boolean },
): string {
  return kind === "ativarIa"
    ? `a:${(s.draftHash ?? "").slice(0, 12)}:${s.aiActive ? 1 : 0}`
    : `p:${(s.appliedDraftHash ?? "").slice(0, 12)}:${s.tested ? 1 : 0}${s.connected ? 1 : 0}`;
}

export type PlannedCard = { kind: DraftCardKind | "ativarIa" | "operacaoPronta"; sig: string };

/**
 * Cartões do turno, em ordem. Regras:
 *  - o cartão do passo atual entra se ainda não foi mostrado COM ESTE conteúdo;
 *  - cartão do rascunho já mostrado volta só se o conteúdo mudou neste turno;
 *  - cartão pedido pelo modelo entra só se nunca foi mostrado com este conteúdo
 *    (pedido de cartão de AÇÃO é ignorado: quem anexa é o estado);
 *  - `mentionsUi` (a resposta fala em "cartão", "botão", "abaixo") sem nenhum
 *    cartão no turno: o cartão do passo atual vai junto mesmo repetido (a tela
 *    recolhe o anterior). O texto nunca aponta para algo que não existe.
 */
export function planTurnCards(input: {
  facts: RoadmapFacts;
  /** Última assinatura mostrada por tipo de cartão (sessão). */
  shown: Record<string, string>;
  /** Tipos pedidos pelo modelo (qualquer string; só os do rascunho contam). */
  requested: readonly string[];
  actionState: { draftHash: string | null; appliedDraftHash: string | null };
  mentionsUi?: boolean;
}): PlannedCard[] {
  const { facts, shown } = input;
  const out: PlannedCard[] = [];
  const push = (card: PlannedCard) => {
    if (!out.some((c) => c.kind === card.kind)) out.push(card);
  };
  const sigOf = (kind: PlannedCard["kind"]): string =>
    kind === "ativarIa" || kind === "operacaoPronta"
      ? actionCardSignature(kind, { ...input.actionState, aiActive: facts.aiActive, tested: facts.tested, connected: facts.connected })
      : cardSignature(facts.draft, kind);

  // Mudou neste turno (já tinha sido mostrado com outro conteúdo).
  for (const kind of DRAFT_CARD_KINDS) {
    const sig = sigOf(kind);
    if (sig && shown[kind] !== undefined && shown[kind] !== sig) push({ kind, sig });
  }
  const current = taskCard(nextTask(facts));
  // Pedido pelo modelo e inédito. Cartão que pede aprovação e ainda não chegou
  // a vez dele NÃO é adiantado: ele entra quando virar o passo atual (senão o
  // passo chegaria sem cartão, por já ter sido "mostrado").
  for (const kind of input.requested) {
    if (!isDraftCardKind(kind)) continue;
    const section = CARD_SECTION[kind];
    if (section && kind !== current && !isApproved(facts, section)) continue;
    const sig = sigOf(kind);
    if (sig && shown[kind] !== sig) push({ kind, sig });
  }
  // Passo atual.
  const task = taskCard(nextTask(facts));
  if (task) {
    const sig = sigOf(task);
    if (sig && (shown[task] !== sig || (input.mentionsUi === true && out.length === 0))) push({ kind: task, sig });
  }
  // O cartão do passo atual fica por último (mais perto do campo de texto).
  if (task) out.sort((a, b) => (a.kind === task ? 1 : 0) - (b.kind === task ? 1 : 0));
  return out;
}

/** A resposta aponta para um elemento da tela ("cartão abaixo", "toque no botão"). */
export function replyMentionsUi(reply: string): boolean {
  return /\b(cart[aã]o|cart[oõ]es|bot[aã]o|bot[oõ]es|abaixo|aqui embaixo|logo abaixo|a seguir|toque em|clique em|clicar em)\b/i.test(reply);
}

// ── Sugestões (chips) coerentes com o estado ────────────────────────────────

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const SEGMENT_CHIP_RE = /\b(clinica|consultorio|loja|e-?commerce|imobiliaria|prestacao de servicos|vendo servicos|tenho uma?|escola|curso)\b/;
const EMAIL_CHIP_RE = /\b(confirm\w* (o |meu )?e-?mail|codigo|verificar e-?mail)\b/;
const ACCEPT_CHIP_RE = /\b(aceit\w*|termos|lgpd|ativar (a )?ia|ligar (a )?ia)\b/;
const APPLY_CHIP_RE = /\b(montar|aplicar|criar) (a |minha |a minha )?operacao\b/;
const HOURS_CHIP_RE = /\b(horario|24 ?h|24 horas|comercial)\b/;
const FUNNEL_CHIP_RE = /\b(funil|etapas?)\b/;
const TEST_CHIP_RE = /\b(testar|teste|simulador)\b/;
const CONNECT_CHIP_RE = /\b(conectar|whatsapp|qr ?code)\b/;

/**
 * Tira as sugestões que não fazem mais sentido: segmento depois de o negócio
 * ser contado, e-mail/aceite/montar depois de feitos, horário (o padrão é 24h
 * e ninguém precisa responder isso), funil depois de aprovado, teste/conexão
 * depois de concluídos. Roda no servidor (ao gravar) e na tela (com o estado
 * vivo, para sugestões gravadas antes de uma ação).
 */
export function coherentChips(chips: readonly string[], facts: RoadmapFacts): string[] {
  const described = businessDescribed(facts.draft);
  const applied = facts.applied && facts.aiActive;
  return chips.filter((raw) => {
    const c = norm(raw);
    if (described && SEGMENT_CHIP_RE.test(c)) return false;
    if (facts.emailVerified && EMAIL_CHIP_RE.test(c)) return false;
    if (facts.aiActive && ACCEPT_CHIP_RE.test(c)) return false;
    if (applied && APPLY_CHIP_RE.test(c)) return false;
    if (HOURS_CHIP_RE.test(c) && (applied || isApproved(facts, "persona"))) return false;
    if (FUNNEL_CHIP_RE.test(c) && (applied || isApproved(facts, "funnel"))) return false;
    if (facts.tested && TEST_CHIP_RE.test(c)) return false;
    if (facts.connected && CONNECT_CHIP_RE.test(c)) return false;
    return true;
  });
}

/** Sugestões de reserva por passo (quando o modelo não manda o suficiente). */
export function taskChips(task: RoadmapTask): string[] {
  switch (task) {
    case "describe_business":
      return ["Vendo serviços", "Tenho uma loja", "Tenho uma clínica", "Trabalho com turismo"];
    case "approve_funnel":
      return ["Quero mudar as etapas", "O que é um funil?"];
    case "approve_persona":
      return ["Quero mudar o nome da IA", "Só no horário comercial"];
    case "approve_knowledge":
      return ["Vou mandar o link do meu site", "Quero contar mais um detalhe"];
    case "activate":
      return ["O que acontece com os meus dados?", "Quero rever antes"];
    default:
      return [];
  }
}

// ── Falas determinísticas (depois de uma ação de cartão) ────────────────────

export type RoadmapNotice =
  | "approved"
  | "email_verified"
  | "activated"
  | "tested"
  | "connected"
  | "skip_connect"
  | "next"
  | "material_pending";

const TASK_INTRO: Record<RoadmapTask, string> = {
  describe_business: "Me conta em uma frase o que você vende e para quem. Com isso eu já monto o resto.",
  approve_funnel:
    "Este é o seu funil: o caminho que cada cliente faz, do primeiro oi até fechar. Se estiver bom, é só seguir; se quiser trocar o nome de uma etapa, ajuste.",
  approve_persona:
    "Agora o jeito de a sua IA atender. Deixei ela atendendo 24h e chamando você quando o cliente pedir uma pessoa. Se preferir só no horário comercial, é só dizer.",
  approve_knowledge:
    "Isto é o que a sua IA sabe para responder. Ela só afirma o que estiver nesta lista, então vale conferir. Dá para completar depois.",
  activate:
    "Está tudo pronto para montar. Falta só o seu OK para ligar a IA: é um clique, e você escolhe se ela responde sozinha ou se você aprova cada resposta.",
  test: "Sua operação está montada. Que tal testar a sua IA agora, como se você fosse um cliente?",
  connect: "Falta só conectar o WhatsApp para a IA começar a atender os seus clientes de verdade.",
  done: "Tudo certo por aqui. O seu CRM está pronto: é só abrir e acompanhar as conversas.",
};

const NOTICE_LEAD: Record<RoadmapNotice, string> = {
  approved: "Combinado.",
  email_verified: "E-mail confirmado.",
  activated: "Pronto, a sua IA está ligada e a operação foi montada.",
  tested: "Gostou do teste?",
  connected: "WhatsApp conectado.",
  skip_connect: "Sem problema, dá para conectar depois em Configurações.",
  next: "",
  material_pending: "",
};

/**
 * Fala do Copiloto depois de uma ação concluída: reconhece o que foi feito e
 * diz o próximo passo. Texto fixo (sem LLM): nunca falha por limite de uso e
 * nunca cita um elemento que o servidor não anexou.
 */
export function stepMessage(notice: RoadmapNotice, task: RoadmapTask, extra: { pendingMaterials?: number } = {}): string {
  const lead = NOTICE_LEAD[notice];
  const pending =
    notice === "email_verified" && (extra.pendingMaterials ?? 0) > 0
      ? " Já vou ler o que você tinha mandado."
      : "";
  return [lead + pending, TASK_INTRO[task]].filter((s) => s.trim().length > 0).join(" ");
}

/** Material recebido antes da confirmação do e-mail: guardado, lido depois. */
export function materialPendingMessage(input: { label: string; maskedEmail: string | null; stored: boolean }): string {
  const where = input.maskedEmail ? ` que enviei para ${input.maskedEmail}` : " que enviei para o seu e-mail";
  return input.stored
    ? `Guardei ${input.label}. Eu só consigo ler material depois que você confirmar o código de 6 dígitos${where}. Assim que confirmar, eu leio sozinho. Enquanto isso, seguimos por aqui.`
    : `Já tenho materiais demais guardados esperando a confirmação. Confirme o código de 6 dígitos${where} e eu leio todos.`;
}

// ── Estado para o prompt do entrevistador ───────────────────────────────────

const TASK_PROMPT: Record<RoadmapTask, string> = {
  describe_business: "descobrir o que o cliente vende e para quem (uma pergunta só)",
  approve_funnel: "o cliente conferir o funil (o sistema anexa o cartão do funil); explique em uma frase para que serve",
  approve_persona: "o cliente conferir o jeito de atender (o sistema anexa o cartão); avise que a IA atende 24h por padrão",
  approve_knowledge: "o cliente conferir o que a IA sabe (o sistema anexa o cartão); convide a contar preços/serviços ou mandar site/PDF",
  activate: "o cliente ativar a IA e montar a operação (o sistema anexa o cartão de ativar)",
  test: "o cliente testar a IA (o sistema anexa o cartão)",
  connect: "o cliente conectar o WhatsApp (o sistema anexa o cartão)",
  done: "nada: a configuração terminou; responda dúvidas e aponte para abrir o CRM",
};

/**
 * Linhas do "ESTADO" que o servidor monta para o entrevistador: o que já está
 * respondido (nunca perguntar de novo) e o único passo que falta.
 */
export function roadmapForPrompt(facts: RoadmapFacts): string[] {
  const d = facts.draft;
  const known: string[] = [];
  if (d) {
    if (d.business.name) known.push("nome do negócio");
    if (businessDescribed(d)) known.push("o que vende");
    if (d.business.city) known.push("cidade");
    if (d.business.segment !== "outro") known.push("segmento");
    known.push(d.businessHours ? "horário de atendimento (definido pelo cliente)" : "horário de atendimento (24h, padrão; NÃO pergunte)");
    known.push(`nome da IA (${d.persona.attendantName})`);
    if (d.handoffRules.length > 0) known.push("quando chamar a equipe");
    if (d.knowledge.length > 0) known.push(`${d.knowledge.length} fato(s) no conhecimento`);
  }
  const approved = APPROVAL_SECTIONS.filter((s) => isApproved(facts, s)).map((s) =>
    s === "funnel" ? "funil" : s === "persona" ? "jeito de atender" : "o que a IA sabe",
  );
  const task = nextTask(facts);
  return [
    `- já respondido (NUNCA pergunte de novo): ${known.length > 0 ? known.join("; ") : "nada ainda"}`,
    `- já aprovado pelo cliente: ${approved.length > 0 ? approved.join(", ") : "nada ainda"}`,
    `- e-mail confirmado: ${facts.emailVerified ? "sim" : "não (o código já foi enviado; não peça de novo)"}`,
    `- IA ativada: ${facts.aiActive ? "sim" : "não"}; operação montada: ${facts.applied ? "sim" : "não"}`,
    `- PRÓXIMO PASSO (único): ${TASK_PROMPT[task]}`,
  ];
}
