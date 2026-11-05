import { SectionCard } from "@/components/ui/SectionCard";
import { handoffFromProfile, handoffToPatch } from "@/lib/attendantConfig";
import type { Id } from "../../../../convex/_generated/dataModel";
import { HandoffRulesForm } from "./HandoffRulesForm";
import { AttendantPanelFrame, SaveBar, usePanelSave, type ReadyProfileCtx } from "./AttendantPanelFrame";
import { useFormDraft } from "./useAttendantProfile";

function Body({ ctx }: { ctx: ReadyProfileCtx }) {
  const handoff = useFormDraft(handoffFromProfile(ctx.profile));
  const { dirty, saving, onSave, onDiscard, guardDialog } = usePanelSave(
    [{ dirty: handoff.dirty, errors: {}, patch: () => handoffToPatch(handoff.value), reset: handoff.reset }],
    ctx.save,
  );
  return (
    <>
      <SectionCard title="Quando chamar a equipe" description="Palavras que fazem a IA parar na hora e chamar alguém do time.">
        <HandoffRulesForm value={handoff.value} onChange={handoff.setValue} disabled={!ctx.canManage || saving} />
      </SectionCard>
      {guardDialog}
      <SaveBar dirty={dirty} saving={saving} onSave={() => void onSave()} onDiscard={onDiscard} />
    </>
  );
}

/** Painel `ai-handoff`. */
export function HandoffPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  return (
    <AttendantPanelFrame organizationId={organizationId}>{(ctx) => <Body ctx={ctx} />}</AttendantPanelFrame>
  );
}
