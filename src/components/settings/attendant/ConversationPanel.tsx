import { useQuery } from "convex/react";
import { SectionCard } from "@/components/ui/SectionCard";
import {
  behaviorErrors,
  behaviorFromProfile,
  behaviorToPatch,
  pipelineErrors,
  pipelineFromProfile,
  pipelineToPatch,
} from "@/lib/attendantConfig";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ConversationBehaviorForm } from "./ConversationBehaviorForm";
import { FunnelRulesForm } from "./FunnelRulesForm";
import { AttendantPanelFrame, SaveBar, usePanelSave, type ReadyProfileCtx } from "./AttendantPanelFrame";
import { useFormDraft } from "./useAttendantProfile";

function Body({ ctx, organizationId }: { ctx: ReadyProfileCtx; organizationId: Id<"organizations"> }) {
  const behavior = useFormDraft(behaviorFromProfile(ctx.profile));
  const funnel = useFormDraft(pipelineFromProfile(ctx.profile));
  const behaviorErr = behaviorErrors(behavior.value);
  const funnelErr = pipelineErrors(funnel.value);

  const boards = useQuery(api.boards.getBoards, { organizationId }) as { _id: string; name: string }[] | undefined;
  const stages = useQuery(
    api.boards.getStages,
    funnel.value.boardId ? { boardId: funnel.value.boardId as Id<"boards"> } : "skip",
  ) as { _id: string; name: string }[] | undefined;
  const leadFields = useQuery(api.fieldDefinitions.getFieldDefinitions, { organizationId, entityType: "lead" }) as
    | { name: string; key: string }[]
    | undefined;

  const { dirty, saving, onSave, onDiscard } = usePanelSave(
    [
      { dirty: behavior.dirty, errors: behaviorErr, patch: () => behaviorToPatch(behavior.value), reset: behavior.reset },
      { dirty: funnel.dirty, errors: funnelErr, patch: () => pipelineToPatch(funnel.value), reset: funnel.reset },
    ],
    ctx.save,
  );

  return (
    <>
      <SectionCard
        title="Comportamento na conversa"
        description="Como a IA junta as mensagens do cliente e quantas vezes ela responde."
      >
        <ConversationBehaviorForm
          value={behavior.value}
          onChange={behavior.setValue}
          disabled={!ctx.canManage}
          errors={behaviorErr}
        />
      </SectionCard>
      <SectionCard title="Funil dos leads" description="Onde os leads novos caem e quando a IA pode movê-los de etapa.">
        <FunnelRulesForm
          value={funnel.value}
          onChange={funnel.setValue}
          disabled={!ctx.canManage}
          errors={funnelErr}
          options={{ boards: boards ?? [], stages: stages ?? [], leadFields }}
        />
      </SectionCard>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void onSave()} onDiscard={onDiscard} />
    </>
  );
}

/** Painel `ai-conversation`: comportamento na conversa e regras do funil. */
export function ConversationPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  return (
    <AttendantPanelFrame organizationId={organizationId}>
      {(ctx) => <Body ctx={ctx} organizationId={organizationId} />}
    </AttendantPanelFrame>
  );
}
