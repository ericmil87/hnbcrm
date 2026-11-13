import { useState } from "react";
import { useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { AttendantSimulator } from "@/components/ai/AttendantSimulator";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { pickEditableAttendant } from "@/lib/attendantConfig";
import type { TestScreenRenderProps } from "./OnboardingConversationController";

type AttendantRow = { _id: Id<"teamMembers">; name: string; status: string; removedAt?: number | null; agentProfile?: { mode?: string } };

export const TEST_EXIT_LABEL = "Voltar para a configuração";
export const TEST_CONNECT_LABEL = "Está bom, conectar o WhatsApp";

/**
 * Tela dedicada do teste da IA na conversa `/comecar` (container: acha o atendente e liga o
 * simulador de sempre, `attendant.simulateAttendant`, na variante `chat`). Ocupa a área da
 * conversa; marcar o teste como feito NUNCA a fecha: só os botões de sair.
 */
export function OnboardingTestScreen({
  organizationId,
  suggestions,
  onClose,
  onConnect,
  onTested,
  tested,
  connected,
}: TestScreenRenderProps & { organizationId: Id<"organizations"> }) {
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as AttendantRow[] | undefined;
  const attendant = pickEditableAttendant(attendants);
  const [testedHere, setTestedHere] = useState(false);

  if (attendants === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center" role="status" aria-label="Abrindo o teste…">
        <Spinner size="lg" />
      </div>
    );
  }
  if (!attendant) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-sm text-text-secondary">Não encontrei o atendente ainda. Monte a operação no cartão "Ativar a sua IA" e tente de novo.</p>
        <Button type="button" variant="secondary" onClick={onClose}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          {TEST_EXIT_LABEL}
        </Button>
      </div>
    );
  }
  const done = tested || testedHere;
  return (
    <AttendantSimulator
      variant="chat"
      organizationId={organizationId}
      agentMemberId={attendant._id}
      attendantName={(attendant as AttendantRow).name || "Atendente IA"}
      suggestions={suggestions}
      onExit={onClose}
      exitLabel={TEST_EXIT_LABEL}
      primaryAction={done && !connected ? { label: TEST_CONNECT_LABEL, onClick: onConnect } : undefined}
      onFirstReply={() => {
        setTestedHere(true);
        onTested();
      }}
    />
  );
}
