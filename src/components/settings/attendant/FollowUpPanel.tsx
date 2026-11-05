import { SectionCard } from "@/components/ui/SectionCard";
import { followUpErrors, followUpFromProfile, followUpToPatch } from "@/lib/attendantConfig";
import { VOCAB } from "@/lib/vocab";
import type { Id } from "../../../../convex/_generated/dataModel";
import { FollowUpForm } from "./FollowUpForm";
import { AttendantPanelFrame, SaveBar, usePanelSave, type ReadyProfileCtx } from "./AttendantPanelFrame";
import { useFormDraft } from "./useAttendantProfile";

function Body({ ctx }: { ctx: ReadyProfileCtx }) {
  const followUp = useFormDraft(followUpFromProfile(ctx.profile));
  const errors = followUpErrors(followUp.value);
  const { dirty, saving, onSave, onDiscard } = usePanelSave(
    [{ dirty: followUp.dirty, errors, patch: () => followUpToPatch(followUp.value), reset: followUp.reset }],
    ctx.save,
  );
  return (
    <>
      <SectionCard
        title={VOCAB.followUp.many}
        description="O que a IA faz quando chega a hora de um follow-up que ela mesma marcou. No dia, ela relê a conversa: se o assunto já foi resolvido, não manda nada."
      >
        <FollowUpForm
          value={followUp.value}
          onChange={followUp.setValue}
          disabled={!ctx.canManage}
          errors={errors}
          isAutopilot={ctx.profile.mode === "autopilot"}
        />
      </SectionCard>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void onSave()} onDiscard={onDiscard} />
    </>
  );
}

/** Painel `ai-followup`. */
export function FollowUpPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  return (
    <AttendantPanelFrame organizationId={organizationId}>{(ctx) => <Body ctx={ctx} />}</AttendantPanelFrame>
  );
}
