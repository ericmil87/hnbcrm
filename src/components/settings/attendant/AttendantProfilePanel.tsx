import { SectionCard } from "@/components/ui/SectionCard";
import {
  knowledgeFromTexts,
  knowledgeToPatch,
  personaFromTexts,
  personaToPatch,
  scheduleErrors,
  scheduleFromProfile,
  scheduleToPatch,
} from "@/lib/attendantConfig";
import { VOCAB } from "@/lib/vocab";
import type { Id } from "../../../../convex/_generated/dataModel";
import { AttendantHoursForm } from "./AttendantHoursForm";
import { AttendantKnowledgeForm } from "./AttendantKnowledgeForm";
import { AttendantPersonaForm } from "./AttendantPersonaForm";
import { AttendantPanelFrame, SaveBar, usePanelSave, type ReadyProfileCtx } from "./AttendantPanelFrame";
import { useFormDraft } from "./useAttendantProfile";

function Body({ ctx }: { ctx: ReadyProfileCtx }) {
  const persona = useFormDraft(personaFromTexts(ctx.texts));
  const knowledge = useFormDraft(knowledgeFromTexts(ctx.texts));
  const hours = useFormDraft(scheduleFromProfile(ctx.profile));
  const hoursErrors = scheduleErrors(hours.value);
  const locked = !ctx.canManage;
  const lockedPlaceholder = ctx.canManage ? "Carregando…" : "Só quem gerencia as configurações vê e edita este texto";

  const { dirty, saving, onSave, onDiscard, guardDialog } = usePanelSave(
    [
      { dirty: persona.dirty, errors: {}, patch: () => personaToPatch(persona.value), reset: persona.reset },
      { dirty: knowledge.dirty, errors: {}, patch: () => knowledgeToPatch(knowledge.value), reset: knowledge.reset },
      { dirty: hours.dirty, errors: hoursErrors, patch: () => scheduleToPatch(hours.value), reset: hours.reset },
    ],
    ctx.save,
  );

  return (
    <>
      <SectionCard title={VOCAB.persona} description="Quem é o atendente e como ele conversa com o cliente.">
        <AttendantPersonaForm
          value={persona.value}
          onChange={persona.setValue}
          disabled={locked}
          lockedPlaceholder={lockedPlaceholder}
        />
      </SectionCard>
      <SectionCard title={VOCAB.knowledge} description="A IA só afirma o que estiver escrito aqui.">
        <AttendantKnowledgeForm
          value={knowledge.value}
          onChange={knowledge.setValue}
          disabled={locked}
          lockedPlaceholder={lockedPlaceholder}
        />
      </SectionCard>
      <SectionCard title="Horário de atendimento">
        <AttendantHoursForm value={hours.value} onChange={hours.setValue} disabled={locked} errors={hoursErrors} />
      </SectionCard>
      {guardDialog}
      <SaveBar dirty={dirty} saving={saving} onSave={() => void onSave()} onDiscard={onDiscard} />
    </>
  );
}

/** Painel `ai-attendant`: jeito de atender, o que a IA sabe e horário. */
export function AttendantProfilePanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  return (
    <AttendantPanelFrame organizationId={organizationId} needsTexts>
      {(ctx) => <Body ctx={ctx} />}
    </AttendantPanelFrame>
  );
}
