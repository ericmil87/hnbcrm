/**
 * Wizard de publicação programada — 3 passos: destinos → agenda → conteúdo.
 *
 * Rascunho: uma publicação SÓ NASCE quando o conteúdo já é válido (o servidor
 * recusa biblioteca vazia ou IA sem prompt), então a criação acontece no
 * primeiro momento em que tudo está de pé — normalmente no passo 3. A partir
 * daí, cada avanço salva o que mudou por `update`, e editar uma publicação
 * ativa reagenda o próximo disparo na hora.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Rocket, Save } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { validateGroupPostContent } from "../../../../convex/lib/groupPostCore";
import { validateGroupPostSchedule } from "../../../../convex/lib/groupPostSchedule";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { GroupChatDoc } from "@/components/inbox/types";
import type { ChannelGroupSettings, GroupPostDetailDoc } from "./types";
import {
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  contentPayload,
  draftFromPost,
  emptyDraft,
  schedulePayload,
  type PostDraft,
  type WizardStep,
} from "./wizardState";
import {
  browserTimezone,
  contentSummary,
  formatDateTime,
  nextRuns,
  previewVars,
  scheduleSummary,
} from "./postUtils";
import { StepTargets } from "./StepTargets";
import { StepSchedule } from "./StepSchedule";
import { StepContent } from "./StepContent";

interface GroupPostWizardProps {
  organizationId: Id<"organizations">;
  groupPostId: Id<"groupPosts"> | null;
  onClose: () => void;
  onSaved: (groupPostId: Id<"groupPosts">) => void;
  onGoToGroups: () => void;
  onOpenAiSettings: () => void;
}

export function GroupPostWizard({
  organizationId,
  groupPostId: initialId,
  onClose,
  onSaved,
  onGoToGroups,
  onOpenAiSettings,
}: GroupPostWizardProps) {
  const { can } = usePermissions(organizationId);
  const canFull = can("campaigns", "full");

  const [postId, setPostId] = useState<Id<"groupPosts"> | null>(initialId);
  const [step, setStep] = useState<WizardStep>("targets");
  const [draft, setDraftState] = useState<PostDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [now] = useState(() => Date.now());

  const existing = useQuery(api.groupPosts.get, initialId ? { groupPostId: initialId } : "skip") as
    | GroupPostDetailDoc
    | null
    | undefined;
  const groups = useQuery(api.groupChats.listGroups, { organizationId }) as GroupChatDoc[] | undefined;
  const channels = useQuery(api.groupChats.listChannelGroupSettings, { organizationId }) as
    | ChannelGroupSettings[]
    | undefined;
  const organizations = useQuery(api.organizations.getUserOrganizations, {}) as any[] | undefined;

  const org = useMemo(
    () => (organizations ?? []).find((o) => o?._id === organizationId),
    [organizations, organizationId]
  );
  const orgTimezone: string | undefined = org?.settings?.timezone;
  const aiConfig = org?.settings?.aiConfig;
  const aiAvailable =
    !!aiConfig && aiConfig.enabled === true && aiConfig.lgpdAck !== undefined && aiConfig.groupAgentEnabled === true;

  const createPost = useMutation(api.groupPosts.create);
  const updatePost = useMutation(api.groupPosts.update);
  const activatePost = useMutation(api.groupPosts.activate);

  // Hidrata uma vez: rascunho novo espera só o fuso da org; edição espera o doc.
  useEffect(() => {
    if (draft !== null) return;
    if (initialId) {
      if (existing === undefined) return;
      if (existing === null) {
        toast.error("Publicação não encontrada");
        onClose();
        return;
      }
      setDraftState(draftFromPost(existing));
    } else {
      if (organizations === undefined) return;
      setDraftState(emptyDraft(orgTimezone ?? browserTimezone()));
    }
  }, [draft, existing, initialId, onClose, organizations, orgTimezone]);

  const setDraft = useCallback(
    (updater: (prev: PostDraft) => PostDraft) =>
      setDraftState((prev) => (prev === null ? prev : updater(prev))),
    []
  );

  const stepError = useCallback(
    (which: WizardStep, current: PostDraft): string | null => {
      if (which === "targets") {
        if (!current.name.trim()) return "Dê um nome à publicação";
        if (current.groupChatIds.length === 0) return "Escolha pelo menos um grupo";
        return null;
      }
      if (which === "schedule") {
        const result = validateGroupPostSchedule(schedulePayload(current));
        return result.ok ? null : result.error;
      }
      const content = validateGroupPostContent(contentPayload(current));
      return content.ok ? null : content.error;
    },
    []
  );

  const sampleGroupName = useMemo(() => {
    if (!draft) return "Seu grupo";
    const first = (groups ?? []).find((g) => draft.groupChatIds.includes(g._id as Id<"groupChats">));
    return first?.subject ?? "Seu grupo";
  }, [draft, groups]);

  const sampleVars = useMemo(
    () => previewVars(sampleGroupName, now, draft?.timezone ?? browserTimezone()),
    [sampleGroupName, now, draft?.timezone]
  );

  /**
   * Salva o que já é válido. Publicação nova só é criada quando o conteúdo
   * passa na validação — antes disso não há o que gravar.
   */
  const saveProgress = useCallback(
    async (current: PostDraft): Promise<Id<"groupPosts"> | null> => {
      const schedule = schedulePayload(current);
      const content = contentPayload(current);
      const contentOk = validateGroupPostContent(content).ok;
      if (postId) {
        await updatePost({
          groupPostId: postId,
          name: current.name.trim(),
          groupChatIds: current.groupChatIds,
          schedule,
          ...(contentOk ? { content } : {}),
        });
        return postId;
      }
      if (!contentOk) return null;
      const created = await createPost({
        organizationId,
        name: current.name.trim(),
        groupChatIds: current.groupChatIds,
        schedule,
        content,
      });
      setPostId(created);
      return created;
    },
    [createPost, organizationId, postId, updatePost]
  );

  if (draft === null) {
    return (
      <SlideOver open onClose={onClose} title="Publicação" className="md:w-[720px] lg:w-[980px]">
        <div className="flex h-64 items-center justify-center">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }

  const index = WIZARD_STEPS.indexOf(step);
  const isLast = index === WIZARD_STEPS.length - 1;
  const status = existing?.status ?? "draft";
  const isActive = status === "active";

  const goNext = async () => {
    const error = stepError(step, draft);
    if (error) {
      toast.error(error);
      return;
    }
    setSaving(true);
    try {
      await saveProgress(draft);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar"));
      setSaving(false);
      return;
    }
    setSaving(false);
    setStep(WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)]);
  };

  const allErrors = WIZARD_STEPS.map((s) => stepError(s, draft)).filter(Boolean) as string[];

  const finish = async (activate: boolean) => {
    if (allErrors.length > 0) {
      toast.error(allErrors[0]);
      return;
    }
    setSaving(true);
    try {
      const id = await saveProgress(draft);
      if (!id) throw new Error("Não foi possível salvar a publicação");
      if (activate) {
        await activatePost({ groupPostId: id });
        toast.success(status === "paused" ? "Publicação retomada" : "Publicação ativada");
      } else {
        toast.success(status === "draft" ? "Rascunho salvo" : "Publicação atualizada");
      }
      onSaved(id);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar a publicação"));
    } finally {
      setSaving(false);
    }
  };

  const upcoming = nextRuns(schedulePayload(draft), now, 1);

  return (
    <SlideOver
      open
      onClose={onClose}
      title={initialId ? "Editar publicação" : "Nova publicação"}
      className="md:w-[720px] lg:w-[980px]"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      {/* Passos */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-3 md:px-6">
        {WIZARD_STEPS.map((s, i) => {
          const done = i < index;
          const current = i === index;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStep(s)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                current
                  ? "bg-brand-500/15 text-brand-400"
                  : done
                    ? "text-text-secondary hover:text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
              )}
            >
              <span
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] tabular-nums",
                  current
                    ? "border-brand-500 text-brand-400"
                    : done
                      ? "border-semantic-success text-semantic-success"
                      : "border-border text-text-muted"
                )}
              >
                {done ? <Check size={11} /> : i + 1}
              </span>
              <span className="hidden sm:inline">{WIZARD_STEP_LABELS[s]}</span>
            </button>
          );
        })}
      </div>

      {/* Corpo */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        {step === "targets" && (
          <StepTargets
            draft={draft}
            setDraft={setDraft}
            groups={groups}
            channels={channels}
            onGoToGroups={onGoToGroups}
          />
        )}
        {step === "schedule" && (
          <StepSchedule draft={draft} setDraft={setDraft} orgTimezone={orgTimezone} now={now} />
        )}
        {step === "content" && (
          <div className="space-y-5">
            <StepContent
              draft={draft}
              setDraft={setDraft}
              organizationId={organizationId}
              sampleVars={sampleVars}
              canFull={canFull}
              aiAvailable={aiAvailable}
              onOpenAiSettings={onOpenAiSettings}
            />

            <div className="rounded-card border border-border bg-surface-sunken p-3.5">
              <h3 className="mb-2 text-sm font-medium text-text-primary">Revisão</h3>
              <dl className="space-y-1.5 text-xs">
                <Row label="Nome" value={draft.name || "—"} />
                <Row
                  label="Grupos"
                  value={`${draft.groupChatIds.length} · ${sampleGroupName}${
                    draft.groupChatIds.length > 1 ? " e outros" : ""
                  }`}
                />
                <Row label="Agenda" value={scheduleSummary(schedulePayload(draft))} />
                <Row
                  label="Primeiro disparo"
                  value={upcoming.length > 0 ? formatDateTime(upcoming[0], draft.timezone) : "sem horário futuro"}
                />
                <Row label="Conteúdo" value={contentSummary(contentPayload(draft))} />
              </dl>
              {allErrors.length > 0 && (
                <p className="mt-2 text-xs text-semantic-error">{allErrors[0]}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Rodapé */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 md:px-6">
        <Button
          variant="secondary"
          size="sm"
          disabled={index === 0 || saving}
          onClick={() => setStep(WIZARD_STEPS[Math.max(0, index - 1)])}
        >
          <ChevronLeft size={15} />
          Voltar
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {isLast ? (
            <>
              <Button variant="secondary" size="sm" disabled={saving} onClick={() => void finish(false)}>
                <Save size={15} />
                {status === "draft" ? "Salvar rascunho" : "Salvar alterações"}
              </Button>
              {!isActive && (
                <Button
                  size="sm"
                  disabled={saving || !canFull}
                  title={canFull ? undefined : "Requer permissão total em campanhas"}
                  onClick={() => void finish(true)}
                >
                  <Rocket size={15} />
                  {status === "paused" ? "Retomar" : "Ativar"}
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" disabled={saving} onClick={() => void goNext()}>
              Próximo
              <ChevronRight size={15} />
            </Button>
          )}
        </div>
      </div>
    </SlideOver>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-text-secondary">{value}</dd>
    </div>
  );
}
