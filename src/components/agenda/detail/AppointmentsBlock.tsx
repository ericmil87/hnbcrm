import { lazy, Suspense } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useSchedulingGate } from "@/components/agenda/booking/useSchedulingGate";

interface AppointmentsBlockProps {
  organizationId: Id<"organizations">;
  /** Um dos dois: o bloco do lead lista também os do contato dele (o servidor junta). */
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  /** Nome (ou telefone formatado) para o passo 3 de "Marcar horário". */
  name?: string;
  /** Telefone cru (a folha formata se faltar nome). */
  phone?: string;
}

const Inner = lazy(() => import("./AppointmentsBlockInner").then((m) => ({ default: m.AppointmentsBlockInner })));

/**
 * Bloco "Agendamentos" do lead/contato. Fica no pacote de todas as telas, então só leva o gate: com o módulo
 * desligado (ou sem `agenda`) não renderiza nada, não assina nada e não baixa o resto (`AppointmentsBlockInner`,
 * com datas no fuso da org, é lazy).
 */
export function AppointmentsBlock(props: AppointmentsBlockProps) {
  const gate = useSchedulingGate(props.organizationId);
  if (!gate.enabled) return null;
  return (
    <Suspense fallback={null}>
      <Inner {...props} canBook={gate.canBook} />
    </Suspense>
  );
}
