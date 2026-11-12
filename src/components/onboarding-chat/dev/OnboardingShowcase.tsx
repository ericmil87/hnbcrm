import { useMemo, type ReactNode } from "react";
import { buildBlock, RECOMMENDED_ATTENDANT_MODE, type OnboardingBlock } from "../../../../convex/lib/onboardingBlocks";
import type { OnboardingDraft } from "../../../../convex/lib/onboardingDraft";
import { cardSignature } from "../../../../convex/lib/onboardingRoadmap";
import type { RoadmapFacts } from "../../../../convex/lib/onboardingRoadmap";
import type { ApplyResult } from "../../../../convex/lib/onboardingApply";
import { chatProgress, nextStepFor, type TimelineItem } from "@/lib/onboardingChat";
import type { ActivationDeps } from "@/lib/onboardingActivate";
import { CopilotNote } from "../ConversationIntro";
import { DraftPreviewPanel } from "../DraftPreviewPanel";
import { OnboardingChatView } from "../OnboardingChatView";
import type { NextStepBarProps } from "../NextStepBar";
import { AtivarIaView } from "../blocks/AtivarIaBlock";
import { CartaoContaView } from "../blocks/CartaoContaBlock";
import { FunilPreviewView } from "../blocks/FunilPreviewBlock";
import { OperacaoProntaView } from "../blocks/OperacaoProntaBlock";
import { approvalFor, liveDraftBlock } from "../blocks/liveBlock";
import { BlockOverridesContext, type BlockOverrides } from "../blocks/registry";
import type { BlockContext, BlockOf, LiveFacts } from "../blocks/types";

/** Estados da vitrine (`?vitrine=onboarding&estado=`). */
export const SHOWCASE_STATES = ["inicio", "funil", "atendente", "ativar", "email", "final", "erro"] as const;
export type ShowcaseState = (typeof SHOWCASE_STATES)[number];

const noop = () => {};

/** Rascunho FIXO do bugueiro de Porto de Galinhas (dados inventados, só para a vitrine). */
const DRAFT = {
  version: 1,
  business: {
    name: "Bugre Tur",
    segment: "turismo",
    description: "Passeios de buggy pelas praias de Porto de Galinhas, com saída da orla e roteiros de 2h a 4h.",
    city: "Porto de Galinhas",
    suspicious: false,
  },
  funnel: {
    name: "Passeios",
    stages: [
      { name: "Novo contato", order: 0, outcome: "open" },
      { name: "Em conversa", order: 1, outcome: "open" },
      { name: "Orçamento enviado", order: 2, outcome: "open" },
      { name: "Passeio reservado", order: 3, outcome: "won" },
      { name: "Não fechou", order: 4, outcome: "lost" },
    ],
  },
  customFields: [{ name: "Data do passeio", type: "date" }],
  persona: { attendantName: "Duda", tone: "amigavel", addressAs: "voce", languages: ["pt-BR", "en"], presentsAsAi: true },
  greeting: { text: "Oi! Eu sou a Duda, a IA da Bugre Tur. Como posso ajudar com o seu passeio?", suspicious: false },
  knowledge: [
    { text: "Passeio de 2h custa R$ 280 por buggy (até 4 pessoas).", origin: { kind: "site", reference: "conversa" }, suspicious: false },
    { text: "Saímos todos os dias das 8h às 16h, da orla de Porto de Galinhas.", origin: { kind: "site", reference: "conversa" }, suspicious: false },
    { text: "Aceitamos Pix e cartão em até 3 vezes.", origin: { kind: "pdf", reference: "tabela-de-precos.pdf" }, suspicious: false },
    { text: "Crianças a partir de 3 anos podem ir com cadeirinha.", origin: { kind: "audio" }, suspicious: false },
  ],
  quickReplies: [{ shortcut: "preco", text: "O passeio de 2h custa R$ 280 por buggy.", suspicious: false }],
  handoffRules: [
    { kind: "pedido_humano", suspicious: false },
    { kind: "reclamacao", suspicious: false },
    { kind: "negociacao_preco", suspicious: false },
  ],
  features: { vision: true, transcription: true, dateTime: true, translation: true, voice: false },
} as unknown as OnboardingDraft;

const MASKED = "bu…te@milfont.net";
const NOW = 1_800_000_000_000;
const ACTION_STATE = { draftHash: "hash-vivo", draftVersion: 4, appliedDraftHash: null as string | null, emailVerified: true, aiActive: false };
const CARD_CTX = { draft: DRAFT, ...ACTION_STATE };

const block = (kind: Parameters<typeof buildBlock>[0]["kind"], ctx: Partial<typeof CARD_CTX> & { approvals?: RoadmapFacts["approvals"]; tested?: boolean; connected?: boolean } = {}) =>
  buildBlock({ kind }, { ...CARD_CTX, ...ctx }) as OnboardingBlock;

const item = (key: string, role: "user" | "assistant", text: string, blocks: OnboardingBlock[] = [], chips: string[] = []): TimelineItem => ({
  key,
  role,
  text,
  blocks,
  chips,
  createdAt: NOW,
});

const FAKE_RESULT = { alreadyApplied: false, attendant: "created", attendantId: "att", funnelMode: "created", fieldsCreated: 1, fieldsUpdated: 0, quickRepliesCreated: 1, skippedSuspicious: { knowledge: 0, quickReplies: 0, handoffRules: 0, greeting: false, business: false }, features: {}, pendingConsent: [] } as unknown as ApplyResult;
const FAKE_DEPS: ActivationDeps = {
  enableAi: async () => {},
  apply: async () => ({ ok: true, result: FAKE_RESULT }),
  enableAutopilot: async () => {},
  errorMessage: (_e, fallback) => fallback,
};

interface Scenario {
  timeline: TimelineItem[];
  intro?: ReactNode;
  facts: RoadmapFacts;
  chips?: string[];
  error?: string;
}

function scenario(state: ShowcaseState): Scenario {
  const sigOf = (k: "funilPreview" | "personaCard" | "conhecimentoLista") => cardSignature(DRAFT, k);
  const base: RoadmapFacts = { draft: DRAFT, approvals: {}, aiActive: false, applied: false, tested: false, connected: false, emailVerified: true };
  switch (state) {
    case "inicio":
      return {
        timeline: [],
        facts: { ...base, draft: null, emailVerified: false },
        chips: ["Vendo serviços", "Tenho uma loja", "Tenho uma clínica", "Trabalho com turismo"],
        intro: (
          <CopilotNote>
            Oi! Vou montar o seu CRM com você em poucos minutos. Me conta em uma frase: o que você vende?
          </CopilotNote>
        ),
      };
    case "funil":
      return {
        facts: base,
        timeline: [
          item("u1", "user", "sou bugueiro em porto de galinhas, vendo passeios"),
          item("a1", "assistant", "Que legal, Porto de Galinhas! Montei o funil do seu dia a dia. Este é o caminho que cada cliente faz, do primeiro oi até fechar o passeio.", [block("funilPreview")], ["Quero mudar as etapas", "O que é um funil?"]),
        ],
      };
    case "atendente":
      return {
        facts: { ...base, approvals: { funnel: sigOf("funilPreview") } },
        timeline: [
          item("u1", "user", "sou bugueiro em porto de galinhas, vendo passeios"),
          item("a1", "assistant", "Montei o funil.", [block("funilPreview")]),
          item("a2", "assistant", "Agora o jeito de a sua IA atender. Deixei ela atendendo 24h e chamando você quando o cliente pedir uma pessoa.", [block("personaCard")], ["Quero mudar o nome da IA"]),
        ],
      };
    case "ativar":
      return {
        facts: { ...base, approvals: { funnel: sigOf("funilPreview"), persona: sigOf("personaCard"), knowledge: sigOf("conhecimentoLista") } },
        timeline: [
          item("a1", "assistant", "Tudo conferido. Veja o que a IA sabe.", [block("conhecimentoLista")]),
          item("a2", "assistant", "Está tudo pronto para montar. Falta só o seu OK para ligar a IA: é um clique, e você escolhe se ela responde sozinha ou se você aprova cada resposta.", [block("ativarIa")]),
        ],
      };
    case "email":
      return {
        facts: { ...base, draft: { ...DRAFT, knowledge: [] } as OnboardingDraft, emailVerified: false },
        timeline: [
          item("u1", "user", "Link: bugretur.com.br"),
          item("a1", "assistant", "Guardei o link. Eu só consigo ler material depois que você confirmar o código de 6 dígitos que enviei para bu…te@milfont.net. Assim que confirmar, eu leio sozinho.", [{ kind: "cartaoConta", emailVerified: false, materialsUnlocked: false, maskedEmail: MASKED, pendingCount: 1 }]),
          item("a2", "assistant", "Guardei o arquivo catalogo.pdf aqui no seu navegador. Assim que você confirmar o e-mail eu leio (mantenha esta página aberta)."),
        ],
      };
    case "final":
      return {
        facts: { ...base, approvals: { funnel: sigOf("funilPreview"), persona: sigOf("personaCard"), knowledge: sigOf("conhecimentoLista") }, aiActive: true, applied: true },
        timeline: [
          item("a1", "assistant", "Pronto, a sua IA está ligada e a operação foi montada. Que tal testar a sua IA agora, como se você fosse um cliente?", [block("operacaoPronta", { appliedDraftHash: "hash-vivo", aiActive: true })]),
        ],
      };
    case "erro":
      return {
        facts: { ...base, approvals: { funnel: sigOf("funilPreview") } },
        timeline: [
          item("u1", "user", "Quero mudar o nome da IA para Duda"),
          item("a1", "assistant", "Este é o jeito de atender.", [block("personaCard")]),
          item("u2", "user", "Pode colocar o tom mais descontraído?"),
        ],
        error: "O limite de uso da configuração por conversa foi atingido. Você pode seguir pelo botão abaixo ou pelo formulário.",
      };
  }
}

/**
 * Vitrine de DEV do onboarding (`/dev/kit?vitrine=onboarding&estado=<estado>`): a conversa `/comecar` com dados FIXOS
 * de um bugueiro de Porto de Galinhas, sem Convex, para ver cada estado em 390 px e 1440 px. Só entra no bundle de DEV.
 */
export function OnboardingShowcase({ estado, reducedMotion }: { estado: ShowcaseState; reducedMotion?: boolean }) {
  const sc = useMemo(() => scenario(estado), [estado]);
  const facts: LiveFacts = { ...sc.facts, maskedEmail: MASKED, pendingMaterials: estado === "email" ? 1 : 0 };
  const progress = chatProgress(sc.facts);
  const next = nextStepFor(sc.facts);
  const nextStep: NextStepBarProps = { label: next.label, ...(next.task === "done" ? { href: "/app" } : { onPress: noop }) };
  const blockCtx: Omit<BlockContext, "isLatest"> = { organizationId: "org", sessionId: "sessao", sendText: noop, sendEvent: noop, busy: false, facts };

  const overrides: BlockOverrides = useMemo(
    () => ({
      funilPreview: ({ block: b, ctx }) => (
        <FunilPreviewView
          block={liveDraftBlock(b, ctx) as BlockOf<"funilPreview">}
          compact={ctx.compact}
          approval={approvalFor("funilPreview", ctx)}
          onAdjust={noop}
          reducedMotion={reducedMotion}
        />
      ),
      ativarIa: ({ block: b }) => (
        <AtivarIaView
          summary={b.summary}
          aiActive={false}
          alreadyApplied={false}
          canApply
          blockedCount={0}
          recommendedMode={RECOMMENDED_ATTENDANT_MODE}
          deps={FAKE_DEPS}
        />
      ),
      cartaoConta: ({ block: b, ctx }) => (
        <CartaoContaView
          verified={false}
          maskedEmail={b.maskedEmail ?? MASKED}
          pendingCount={b.pendingCount}
          compact={ctx.compact}
          onRequest={async () => ({ sent: true })}
          onConfirm={async () => ({ verified: false })}
        />
      ),
      operacaoPronta: ({ block: b }) => (
        <OperacaoProntaView summary={b.summary} tested={false} connected={false} simulator={<p>Simulador</p>} connectCard={<p>Conexão</p>} />
      ),
    }),
    [reducedMotion]
  );

  const intro =
    estado === "inicio" ? (
      <>
        {sc.intro}
        <div className="pl-2">
          <CartaoContaView
            verified={false}
            maskedEmail={MASKED}
            compact
            onRequest={async () => ({ sent: true })}
            onConfirm={async () => ({ verified: false })}
          />
        </div>
      </>
    ) : null;

  const previewProps = { draft: sc.facts.draft, ctx: blockCtx, progress, nextStep };
  return (
    <BlockOverridesContext.Provider value={overrides}>
      <OnboardingChatView
        progress={progress}
        intro={intro}
        timeline={sc.timeline}
        typing={false}
        chips={sc.chips ?? sc.timeline[sc.timeline.length - 1]?.chips ?? []}
        onChip={noop}
        composerValue=""
        onComposerChange={noop}
        onSubmit={noop}
        blockCtx={blockCtx}
        formHref="/app/configuracao-inicial"
        appHref="/app"
        error={sc.error}
        onRetry={sc.error ? noop : undefined}
        onDismissError={sc.error ? noop : undefined}
        nextStep={nextStep}
        preview={<DraftPreviewPanel {...previewProps} />}
        previewSheet={<DraftPreviewPanel {...previewProps} inSheet />}
      />
    </BlockOverridesContext.Provider>
  );
}
