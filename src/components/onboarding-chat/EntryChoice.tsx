import type { ReactNode } from "react";
import { Building2, CreditCard, Gauge, LayoutDashboard, MessageCircle, SlidersHorizontal, Sparkles } from "lucide-react";
import { Select } from "@/components/ui/Select";
import type { EntryNotice, EntryOption } from "@/lib/onboardingEntryChoice";
import { cn } from "@/lib/utils";
import { ConversationCard, CopilotNote } from "./ConversationIntro";

export type EntryOrgState = "fresh" | "in_progress" | "configured";

export interface EntryChoiceViewProps {
  /** `not_admin`: a pessoa não administra nenhuma empresa (só abrir o CRM ou criar a própria). */
  variant?: "admin" | "not_admin";
  orgName: string;
  state: EntryOrgState;
  notice: EntryNotice | null;
  /** Etapa em que a conversa parou ("Funil"). */
  stepLabel: string | null;
  /** Empresas que a pessoa administra; com mais de uma aparece "Para qual empresa?". */
  orgs?: ReadonlyArray<{ id: string; name: string }>;
  selectedOrgId?: string;
  onSelectOrg?: (id: string) => void;
  options: readonly EntryOption[];
  primary: EntryOption;
  /** Mensagem guardada do hero: mostrada e só usada depois da escolha. */
  intentMessage?: string | null;
  /** O que acontece com o teste numa empresa nova (`newOrgTrialNotice`). */
  trialNotice: string;
  onChoose: (option: EntryOption) => void;
}

function optionCopy(option: EntryOption, p: EntryChoiceViewProps): { label: string; hint: string; icon: ReactNode } {
  const icon = (node: ReactNode) => node;
  switch (option) {
    case "open_crm":
      return {
        label: "Abrir o meu CRM",
        hint: p.intentMessage ? "Vai direto para Conversas e Funil. A mensagem que você escreveu é descartada." : "Vai direto para Conversas e Funil.",
        icon: icon(<LayoutDashboard className="size-5" aria-hidden="true" />),
      };
    case "continue":
      return {
        label: "Continuar a configuração",
        hint: p.stepLabel ? `Você parou em: ${p.stepLabel}.` : "Volta para a conversa de onde parou.",
        icon: icon(<MessageCircle className="size-5" aria-hidden="true" />),
      };
    case "adjust":
      return {
        label: "Ajustar a operação conversando",
        hint: "Nada muda no seu CRM sem o seu clique para montar. O atendente que já existe é mantido.",
        icon: icon(<SlidersHorizontal className="size-5" aria-hidden="true" />),
      };
    case "start":
      return {
        label: "Configurar conversando",
        hint: "Monto o funil e o atendente com você em poucos minutos.",
        icon: icon(<Sparkles className="size-5" aria-hidden="true" />),
      };
    case "create":
      return {
        label: p.variant === "not_admin" ? "Criar a minha própria empresa" : "Criar outra empresa",
        hint: p.trialNotice,
        icon: icon(<Building2 className="size-5" aria-hidden="true" />),
      };
    case "see_plan":
      return {
        label: "Ver o plano",
        hint: "Assine um plano para a IA voltar a funcionar.",
        icon: icon(<CreditCard className="size-5" aria-hidden="true" />),
      };
    case "see_usage":
      return {
        label: "Ver o uso de IA",
        hint: "Ajuste o teto de gastos do mês para continuar.",
        icon: icon(<Gauge className="size-5" aria-hidden="true" />),
      };
  }
}

function lead(p: EntryChoiceViewProps): ReactNode {
  const name = <strong className="font-semibold">{p.orgName}</strong>;
  if (p.variant === "not_admin") {
    return (
      <>
        Você faz parte de {name}, mas só quem administra a empresa pode configurar o atendimento por aqui. Peça a um
        administrador, abra o seu CRM ou crie a sua própria empresa.
      </>
    );
  }
  if (p.notice === "read_only") {
    return <>A IA de {name} está pausada porque o plano está em modo leitura. Assine um plano para voltar a configurar conversando.</>;
  }
  if (p.notice === "spend_cap") {
    return <>O teto de gastos de IA de {name} foi atingido neste mês. Ajuste o teto para voltar a configurar conversando.</>;
  }
  if (p.state === "in_progress") {
    return (
      <>
        Você começou a configurar {name}
        {p.stepLabel ? ` e parou em ${p.stepLabel}` : ""}. O que você quer fazer?
      </>
    );
  }
  if (p.state === "configured") return <>Você já tem o HNBCRM funcionando em {name}. O que você quer fazer?</>;
  return <>{name} ainda não foi configurada. O que você quer fazer?</>;
}

/**
 * Tela de entrada de `/comecar` para quem já tem empresa (apresentação, sem
 * Convex): fala do Copiloto com o contexto, a mensagem do hero guardada (usada
 * só depois da escolha), "Para qual empresa?" com mais de uma e as opções.
 */
export function EntryChoiceView(props: EntryChoiceViewProps) {
  const { orgs, selectedOrgId, onSelectOrg, options, primary, intentMessage, onChoose } = props;
  return (
    <>
      <CopilotNote>{lead(props)}</CopilotNote>
      <ConversationCard title="O que você quer fazer?">
        <div className="flex flex-col gap-3">
          {intentMessage && (
            <div className="rounded-field bg-surface-sunken px-3 py-2">
              <p className="text-caption font-medium text-text-secondary">Você escreveu:</p>
              <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{intentMessage}</p>
              <p className="mt-1 text-caption text-text-muted">Eu uso a sua mensagem no caminho que você escolher.</p>
            </div>
          )}
          {orgs && orgs.length > 1 && onSelectOrg && (
            <Select
              label="Para qual empresa?"
              value={selectedOrgId ?? orgs[0].id}
              options={orgs.map((o) => ({ value: o.id, label: o.name }))}
              onValueChange={onSelectOrg}
            />
          )}
          <ul className="flex flex-col gap-2" aria-label="Opções">
            {options.map((option) => {
              const c = optionCopy(option, props);
              const isPrimary = option === primary;
              return (
                <li key={option}>
                  <button
                    type="button"
                    onClick={() => onChoose(option)}
                    className={cn(
                      "flex min-h-11 w-full items-start gap-3 rounded-card border p-3 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
                      isPrimary
                        ? "border-brand-500 bg-brand-500/10 hover:bg-brand-500/15"
                        : "border-border bg-surface-raised hover:bg-surface-sunken"
                    )}
                  >
                    <span className={cn("mt-0.5 shrink-0", isPrimary ? "text-brand-600" : "text-text-secondary")}>{c.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-text-primary">{c.label}</span>
                      <span className="block text-caption text-text-secondary">{c.hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </ConversationCard>
    </>
  );
}
