/**
 * Entrada de `/comecar` para quem chega logado (hero, chip de nicho, "Testar
 * grátis" ou direto). Regra pura: decide qual tela aparece a partir do resumo
 * do servidor (`onboardingSessions.getEntryOverview`), da org salva neste
 * navegador e da escolha que a pessoa já fez nesta visita.
 *
 * Princípio: só cai DIRETO na conversa quem não tem nada que a conversa possa
 * mexer (uma única empresa que a pessoa administra, sem operação montada, sem
 * pausa de IA, e sem mensagem do hero que possa ser de outra empresa enquanto
 * já há uma conversa pela metade). Qualquer outro caso mostra a tela de
 * escolha dentro da conversa, e a mensagem do hero só é usada depois da escolha.
 */
import { ROADMAP_STEPS } from "../../convex/lib/onboardingRoadmap";
import type { NewOrgTrial } from "../../convex/lib/onboardingRestart";
import { TRIAL } from "../../convex/lib/plans";
import { formatDate } from "./format";

export interface EntryOrg {
  organizationId: string;
  name: string;
  canManage: boolean;
  configured: boolean;
  conversation: "none" | "in_progress" | "applied";
  reachedStep: number;
  readOnly: boolean;
  spendCapReached: boolean;
}

export interface EntryOverview {
  orgs: readonly EntryOrg[];
  newOrgTrial: NewOrgTrial;
  newOrgTrialEndsAt: number | null;
}

/** Escolha feita na tela de entrada (vale só nesta visita). */
export type EntryChoice = { action: "conversation"; orgId: string } | { action: "create" };

export type EntryOption = "open_crm" | "continue" | "adjust" | "start" | "create" | "see_plan" | "see_usage";
export type EntryNotice = "read_only" | "spend_cap";

export type EntryDecision =
  | { kind: "loading" }
  | { kind: "signed_out" }
  /** Criar organização: a primeira (`no_org`) ou outra, escolhida na tela de entrada. */
  | { kind: "create_org"; reason: "no_org" | "chosen" }
  | { kind: "conversation"; orgId: string }
  | {
      kind: "choose";
      org: EntryOrg;
      /** Só as que a pessoa administra (o seletor "Para qual empresa?" aparece com mais de uma). */
      managed: readonly EntryOrg[];
      options: readonly EntryOption[];
      primary: EntryOption;
      notice: EntryNotice | null;
      /** Etapa em que a conversa parou (só com conversa em andamento). */
      stepLabel: string | null;
    }
  /** Nenhuma empresa que a pessoa administre. */
  | { kind: "not_admin"; orgName: string; options: readonly EntryOption[] };

export interface EntryInput {
  auth: "loading" | "signed_out" | "signed_in";
  /** `undefined` = carregando; `null` = o servidor não reconheceu a sessão. */
  overview: EntryOverview | null | undefined;
  /** Org salva neste navegador (`hnbcrm.selectedOrgId`, a última usada no app). */
  storedOrgId: string | null;
  /** Org escolhida no seletor desta tela. */
  pickedOrgId?: string | null;
  choice?: EntryChoice | null;
  /** Há mensagem do hero guardada. */
  hasIntent: boolean;
}

export function stepLabelFor(reachedStep: number): string {
  const i = Number.isInteger(reachedStep) ? Math.min(ROADMAP_STEPS.length - 1, Math.max(0, reachedStep)) : 0;
  return ROADMAP_STEPS[i].label;
}

function optionsFor(org: EntryOrg, notice: EntryNotice | null): { options: EntryOption[]; primary: EntryOption } {
  if (notice === "read_only") return { options: ["see_plan", "open_crm", "create"], primary: "see_plan" };
  if (notice === "spend_cap") return { options: ["see_usage", "open_crm", "create"], primary: "see_usage" };
  if (org.conversation === "in_progress") return { options: ["continue", "open_crm", "create"], primary: "continue" };
  if (org.conversation === "applied" || org.configured) return { options: ["open_crm", "adjust", "create"], primary: "open_crm" };
  return { options: ["start", "open_crm", "create"], primary: "start" };
}

export function decideOnboardingEntry(input: EntryInput): EntryDecision {
  if (input.auth === "loading") return { kind: "loading" };
  if (input.auth === "signed_out") return { kind: "signed_out" };
  const overview = input.overview;
  if (!overview) return { kind: "loading" };

  if (input.choice?.action === "create") return { kind: "create_org", reason: "chosen" };
  const managed = overview.orgs.filter((o) => o.canManage);
  if (input.choice?.action === "conversation") {
    const chosenId = input.choice.orgId;
    // Org recém-criada ainda não chegou no resumo: espera (a query é reativa).
    return managed.some((o) => o.organizationId === chosenId) ? { kind: "conversation", orgId: chosenId } : { kind: "loading" };
  }

  if (overview.orgs.length === 0) return { kind: "create_org", reason: "no_org" };
  if (managed.length === 0) {
    const named = overview.orgs.find((o) => o.organizationId === input.storedOrgId) ?? overview.orgs[0];
    return { kind: "not_admin", orgName: named.name, options: ["open_crm", "create"] };
  }

  const org =
    managed.find((o) => o.organizationId === input.pickedOrgId) ??
    managed.find((o) => o.organizationId === input.storedOrgId) ??
    managed[0];
  const notice: EntryNotice | null = org.readOnly ? "read_only" : org.spendCapReached ? "spend_cap" : null;

  const direct =
    managed.length === 1 &&
    !input.pickedOrgId &&
    !org.configured &&
    org.conversation !== "applied" &&
    notice === null &&
    !(input.hasIntent && org.conversation === "in_progress");
  if (direct) return { kind: "conversation", orgId: org.organizationId };

  const { options, primary } = optionsFor(org, notice);
  return {
    kind: "choose",
    org,
    managed,
    options,
    primary,
    notice,
    stepLabel: org.conversation === "in_progress" ? stepLabelFor(org.reachedStep) : null,
  };
}

/** O que acontece com o teste grátis numa empresa nova (dito ANTES de criar). */
export function newOrgTrialNotice(trial: NewOrgTrial, endsAt: number | null): string {
  switch (trial) {
    case "fresh":
      return `A nova empresa começa com ${TRIAL.days} dias de teste grátis.`;
    case "shared_active":
      return endsAt
        ? `O teste grátis é um por pessoa: a nova empresa usa o mesmo teste, que termina em ${formatDate(endsAt)}.`
        : "O teste grátis é um por pessoa: a nova empresa usa o mesmo teste da primeira.";
    case "shared_expired":
      return "O seu teste grátis já terminou: a nova empresa começa em modo leitura (a IA fica pausada) até você assinar um plano.";
    case "none":
      return "A nova empresa começa do zero, separada desta.";
  }
}

/** A conversa usa a mensagem do hero em qualquer caminho, menos "Abrir o meu CRM" (que a descarta). */
export function optionDiscardsIntent(option: EntryOption): boolean {
  return option === "open_crm";
}
