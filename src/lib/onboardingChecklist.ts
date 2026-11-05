import { TAB_ROUTES } from "./routes";
import { wizardStepHref, type WizardStepId } from "./onboardingWizard";

// "Primeiros passos" do Painel (A.7): ordem, totais e ação de cada item.
// Os itens vêm de `getOnboardingChecklist` (derivados de dados reais no servidor).

export interface ChecklistItemInput {
  id: string;
  label: string;
  completed: boolean;
  skipped?: boolean;
  step?: string | null;
  target?: string;
}

/** Ordem fixa dos 9 itens (o do aceite só existe com canal por QR code). */
export const CHECKLIST_ORDER = [
  "business",
  "pipelineCustomized",
  "whatsapp",
  "attendant",
  "bridgeAiAck",
  "test",
  "extras",
  "teamMemberInvited",
  "firstAiReply",
] as const;

/** Marco celebrado uma única vez quando tudo está feito. */
export const CHECKLIST_MILESTONE = "checklist-complete";

export function orderChecklistItems<T extends { id: string }>(items: ReadonlyArray<T>): T[] {
  const rank = (id: string) => {
    const i = (CHECKLIST_ORDER as ReadonlyArray<string>).indexOf(id);
    return i === -1 ? CHECKLIST_ORDER.length : i;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index)
    .map((x) => x.item);
}

export function checklistTotals(items: ReadonlyArray<{ completed: boolean }>) {
  const total = items.length;
  const completed = items.filter((i) => i.completed).length;
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    allDone: total > 0 && completed === total,
  };
}

export interface ChecklistAction {
  to: string;
  label: string;
}

/** Para onde o item leva: passo do assistente, Configurações › IA ou a Entrada. */
export function checklistAction(item: ChecklistItemInput): ChecklistAction | null {
  if (item.completed) return null;
  switch (item.target) {
    case "wizard":
      return item.step
        ? { to: wizardStepHref(item.step as WizardStepId), label: item.skipped ? "Retomar" : "Fazer agora" }
        : null;
    case "settings_ai":
      return { to: `${TAB_ROUTES.settings}?secao=ai-features`, label: "Abrir" };
    case "inbox":
      return { to: TAB_ROUTES.inbox, label: "Ver conversas" };
    default:
      return null;
  }
}

/** "Continuar configuração": há passo do assistente por fazer (pendente ou pulado). */
export function hasWizardWork(items: ReadonlyArray<ChecklistItemInput>): boolean {
  return items.some((i) => i.target === "wizard" && !i.completed);
}
