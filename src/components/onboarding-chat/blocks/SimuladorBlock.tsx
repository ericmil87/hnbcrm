import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { FlaskConical, ShieldCheck } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { AttendantSimulator } from "@/components/ai/AttendantSimulator";
import { Button } from "@/components/ui/Button";
import { pickEditableAttendant } from "@/lib/attendantConfig";
import { plainModelText } from "@/lib/onboardingChat";
import { simulatorReason } from "@/lib/onboardingApplyView";
import { VOCAB } from "@/lib/vocab";
import { useDraftEditor } from "../useDraftEditor";
import { OnboardingTutorial } from "../tutorial/OnboardingTutorial";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

export interface SimuladorViewProps {
  available: boolean;
  reason?: "ai_inactive" | "not_applied";
  note?: string;
  compact?: boolean;
  /** Não achou o atendente (ex.: ainda não foi criado). */
  missingAttendant?: boolean;
  onAskAccept?: () => void;
  onAskApply?: () => void;
  actionsDisabled?: boolean;
  /** Conversa de teste (só montada com o teste disponível). */
  simulator?: ReactNode;
  /** Depois da primeira resposta da IA: o tutorial guiado. */
  tutorial?: ReactNode;
}

/**
 * `simulador`: convida para testar o atendente "como se fosse um cliente".
 * Indisponível sem IA ativa (aponta para o aceite) ou sem operação montada
 * (aponta para "Montar minha operação"). Nada roda ao montar o cartão.
 */
export function SimuladorView({
  available,
  reason,
  note,
  compact,
  missingAttendant,
  onAskAccept,
  onAskApply,
  actionsDisabled,
  simulator,
  tutorial,
}: SimuladorViewProps) {
  return (
    <>
      <BlockCard title={`Teste o seu ${VOCAB.attendant.name}`} icon={FlaskConical} note={compact ? undefined : note}>
        {!available && reason === "ai_inactive" && (
          <div className="space-y-2">
            <p className="text-text-secondary">
              O teste usa a IA da sua organização, e ela ainda não está ativa. Dê o aceite de IA e eu libero a conversa de teste.
            </p>
            {onAskAccept && (
              <Button size="sm" variant="secondary" disabled={actionsDisabled} onClick={onAskAccept}>
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                Ir para o aceite de IA
              </Button>
            )}
          </div>
        )}
        {!available && reason === "not_applied" && (
          <div className="space-y-2">
            <p className="text-text-secondary">
              Para testar, primeiro monte a operação: o teste conversa com o atendente que ela cria.
            </p>
            {onAskApply && (
              <Button size="sm" variant="secondary" disabled={actionsDisabled} onClick={onAskApply}>
                Ir para montar a operação
              </Button>
            )}
          </div>
        )}
        {available && missingAttendant && (
          <p className="text-text-secondary">Não encontrei o atendente ainda. Monte a operação e tente de novo.</p>
        )}
        {available && !missingAttendant && (
          <div className="space-y-2">
            <p className="text-text-secondary">Fale como se fosse um cliente. Nada aqui chega a uma pessoa de verdade.</p>
            {simulator}
          </div>
        )}
      </BlockCard>
      {tutorial}
    </>
  );
}

export function SimuladorBlock({ block, ctx }: BlockProps<"simulador">) {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const ed = useDraftEditor(ctx);
  const aiStatus = useQuery(api.aiSettings.getAiStatus, organizationId ? { organizationId } : "skip");
  const attendants = useQuery(api.aiSettings.listAttendants, organizationId ? { organizationId } : "skip") as
    | Array<{ _id: Id<"teamMembers">; status: string; removedAt?: number | null }>
    | undefined;
  const [tested, setTested] = useState(false);

  // Estado vivo (o cartão pode ter sido gerado antes do aceite ou de montar a operação).
  const live = aiStatus !== undefined && ed.loaded;
  const reason = live ? simulatorReason({ aiActive: aiStatus.active, applied: ed.appliedHash !== null }) : block.reason;
  const available = live ? reason === undefined : block.available;
  const attendant = pickEditableAttendant(attendants);
  const prompts = (Array.isArray(block.prompts) ? block.prompts : []).map((p) => plainModelText(p)).filter(Boolean).slice(0, 3);

  return (
    <SimuladorView
      available={available}
      reason={reason}
      note={block.note}
      compact={ctx.compact}
      missingAttendant={available && attendants !== undefined && !attendant}
      onAskAccept={() => ctx.sendText("Quero dar o aceite de IA para testar o atendente.")}
      onAskApply={() => ctx.sendText("Quero montar a minha operação.")}
      actionsDisabled={ctx.busy}
      simulator={
        organizationId && attendant ? (
          <AttendantSimulator
            variant="inline"
            organizationId={organizationId}
            agentMemberId={attendant._id}
            suggestions={prompts}
            onFirstReply={() => setTested(true)}
          />
        ) : undefined
      }
      tutorial={tested ? <OnboardingTutorial /> : undefined}
    />
  );
}
