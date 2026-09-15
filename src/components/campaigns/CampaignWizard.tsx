import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Rocket, Save } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { usePermissions } from "@/hooks/usePermissions";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { containsLink, countSpintaxVariations } from "@/lib/whatsappFormat";
import type { CampaignDoc, SafeDefaults } from "./types";
import {
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  audiencePayload,
  contentPayload,
  draftFromCampaign,
  emptyDraft,
  isWithinSafe,
  pacingPayload,
  safetyPayload,
  schedulePayload,
  type WizardDraft,
  type WizardStep,
} from "./wizardState";
import { StepChannel } from "./steps/StepChannel";
import { StepAudience } from "./steps/StepAudience";
import { StepMessage } from "./steps/StepMessage";
import { StepLimits } from "./steps/StepLimits";
import { StepReview } from "./steps/StepReview";

interface CampaignWizardProps {
  organizationId: Id<"organizations">;
  campaignId: Id<"campaigns"> | null;
  onClose: () => void;
  onSaved?: (campaignId: Id<"campaigns">) => void;
  onLaunched?: (campaignId: Id<"campaigns">) => void;
}

export function CampaignWizard({ organizationId, campaignId: initialId, onClose, onSaved, onLaunched }: CampaignWizardProps) {
  const { can } = usePermissions(organizationId);
  const canLaunch = can("campaigns", "full");

  const [campaignId, setCampaignId] = useState<Id<"campaigns"> | null>(initialId);
  const existing = useQuery(api.campaigns.getCampaign, campaignId ? { campaignId } : "skip") as CampaignDoc | null | undefined;
  const [draft, setDraftState] = useState<WizardDraft>(() => emptyDraft());
  const [hydrated, setHydrated] = useState(initialId === null);
  const [step, setStep] = useState<WizardStep>("channel");
  const [saving, setSaving] = useState(false);
  const [consentAck, setConsentAck] = useState(false);
  const [bridgeRiskAck, setBridgeRiskAck] = useState(false);
  const [newNumberRiskAck, setNewNumberRiskAck] = useState(false);
  const [now] = useState(() => Date.now());

  const setDraft = useCallback((updater: (prev: WizardDraft) => WizardDraft) => setDraftState(updater), []);

  // Hidrata uma vez ao abrir um rascunho existente
  useEffect(() => {
    if (hydrated || existing === undefined) return;
    if (existing) setDraftState(draftFromCampaign(existing));
    setHydrated(true);
  }, [existing, hydrated]);

  const createCampaign = useMutation(api.campaigns.createCampaign);
  const updateCampaign = useMutation(api.campaigns.updateCampaign);
  const launchCampaign = useMutation(api.campaigns.launchCampaign);

  const status = existing?.status ?? "draft";
  const isDraft = status === "draft";
  const editableLimits = isDraft || status === "paused" || status === "scheduled";
  const recipientsTotal = existing?.stats.total ?? 0;
  const channelName = existing?.channel?.displayName ?? "Sua empresa";

  const safeDefaults = useQuery(
    api.campaigns.getSafeDefaults,
    draft.channelConfigId ? { channelConfigId: draft.channelConfigId, now, ...(draft.tierAtLaunch ? { tier: draft.tierAtLaunch } : {}) } : "skip"
  ) as SafeDefaults | undefined;
  // Número bridge recém-conectado: avisa e pede aceite próprio, mas não trava
  const newNumberRisk = safeDefaults?.newNumberRisk ?? null;

  const stepIndex = WIZARD_STEPS.indexOf(step);

  // Validação local por passo (mensagens amigáveis antes de bater no servidor)
  const stepError = useMemo((): string | null => {
    if (step === "channel") {
      if (!draft.name.trim()) return "Dê um nome à campanha";
      if (!draft.channelConfigId) return "Escolha o número que vai disparar";
    }
    if (step === "message") {
      if (draft.content.kind === "template") {
        if (!draft.content.template?.name) return "Escolha um template aprovado";
      } else {
        const filled = draft.content.variants.filter((vr) => vr.text.trim() || (vr.attachmentFileIds?.length ?? 0) > 0);
        if (filled.length === 0) return "Escreva a mensagem (ou anexe uma mídia)";
        if (draft.provider === "meta" && !(draft.audience.source === "segment" && draft.audience.filters.onlyOpenWindow)) {
          return "Na Cloud API, números fora da janela de 24h exigem template";
        }
        if (draft.provider === "bridge" && recipientsTotal > 30) {
          const variations = draft.content.variants.reduce((acc, vr) => acc + countSpintaxVariations(vr.text), 0);
          if (draft.content.variants.length < 2 && variations < 2) return "Acima de 30 destinatários no bridge, use 2+ variantes ou spintax";
        }
        if (draft.provider === "bridge" && !draft.safety.allowLinks && draft.content.variants.some((vr) => containsLink(vr.text))) {
          return "A mensagem tem link — marque o aceite de risco de link ou remova";
        }
      }
    }
    if (step === "limits") {
      if (!draft.pacing || !draft.schedule) return "Carregando limites…";
      if (draft.schedule.days.length === 0) return "Escolha pelo menos um dia da semana";
      if (draft.schedule.windowEndHour <= draft.schedule.windowStartHour) return "A janela precisa terminar depois de começar";
      if (!draft.safeMode && safeDefaults && !isWithinSafe(draft.pacing, safeDefaults.safe) && draft.overrideWord.trim().toUpperCase() !== "ENTENDO") {
        return 'Digite "ENTENDO" para seguir acima do modo seguro';
      }
    }
    return null;
  }, [step, draft, safeDefaults, recipientsTotal]);

  const persist = useCallback(async (): Promise<Id<"campaigns"> | null> => {
    if (!draft.channelConfigId) return null;
    setSaving(true);
    try {
      const common = {
        content: contentPayload(draft),
        audience: audiencePayload(draft),
        ...(draft.schedule ? { schedule: schedulePayload(draft.schedule) } : {}),
        ...(draft.pacing ? { pacing: pacingPayload(draft.pacing) } : {}),
        safeMode: draft.safeMode,
        safety: safetyPayload(draft),
      };
      if (!campaignId) {
        const id = await createCampaign({
          organizationId,
          name: draft.name.trim(),
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
          channelConfigId: draft.channelConfigId,
          ...common,
        });
        setCampaignId(id);
        onSaved?.(id);
        return id;
      }
      const patch = isDraft
        ? {
            name: draft.name.trim(),
            description: draft.description.trim() || null,
            channelConfigId: draft.channelConfigId,
            ...common,
          }
        : {
            ...(draft.schedule ? { schedule: schedulePayload(draft.schedule) } : {}),
            ...(draft.pacing ? { pacing: pacingPayload(draft.pacing) } : {}),
            safeMode: draft.safeMode,
            safety: safetyPayload(draft),
          };
      await updateCampaign({ campaignId, patch });
      onSaved?.(campaignId);
      return campaignId;
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar o rascunho"));
      return null;
    } finally {
      setSaving(false);
    }
  }, [draft, campaignId, isDraft, organizationId, createCampaign, updateCampaign, onSaved]);

  const goNext = async () => {
    if (stepError) {
      toast.error(stepError);
      return;
    }
    const id = await persist();
    if (!id) return;
    setStep(WIZARD_STEPS[Math.min(stepIndex + 1, WIZARD_STEPS.length - 1)]);
  };
  const goBack = () => setStep(WIZARD_STEPS[Math.max(stepIndex - 1, 0)]);

  const handleLaunch = async () => {
    const id = await persist();
    if (!id) return;
    if (!consentAck) {
      toast.error("Confirme o consentimento / base legal para contatar a lista");
      return;
    }
    if (draft.provider === "bridge" && !bridgeRiskAck) {
      toast.error("Confirme o aceite de risco do bridge");
      return;
    }
    if (newNumberRisk && !newNumberRiskAck) {
      toast.error("Confirme o aceite de risco do número recém-conectado");
      return;
    }
    setSaving(true);
    try {
      const withinSafe = !safeDefaults || !draft.pacing || isWithinSafe(draft.pacing, safeDefaults.safe);
      const result = await launchCampaign({
        campaignId: id,
        consentAck: true,
        ...(draft.provider === "bridge" ? { bridgeRiskAck: true } : {}),
        ...(newNumberRisk ? { newNumberRiskAck: true } : {}),
        ...(!withinSafe ? { overrideAck: true, overrideWord: draft.overrideWord.trim() } : {}),
        ...(draft.tierAtLaunch ? { tierAtLaunch: draft.tierAtLaunch } : {}),
        ...(draft.templateQuality ? { templateQualityAtLaunch: draft.templateQuality } : {}),
      });
      toast.success(result.status === "scheduled" ? "Campanha agendada — calculando o público" : "Campanha lançada");
      for (const w of result.warnings) toast.message(w);
      onLaunched?.(id);
      onClose();
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível lançar a campanha"));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndClose = async () => {
    if (step === "channel" && stepError) {
      toast.error(stepError);
      return;
    }
    const id = await persist();
    if (id) {
      toast.success("Rascunho salvo");
      onClose();
    }
  };

  const estimatedCost = useMemo(() => {
    if (draft.provider !== "meta") return 0;
    const category = draft.content.template?.category?.toUpperCase();
    const price = category === "MARKETING" ? 0.0625 : category === "UTILITY" || category === "AUTHENTICATION" ? 0.0068 : 0;
    return Math.round(price * recipientsTotal * 100) / 100;
  }, [draft.provider, draft.content.template?.category, recipientsTotal]);

  if (!hydrated) {
    return (
      <SlideOver open onClose={onClose} title="Campanha" className="md:w-[720px] lg:w-[1040px]">
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }

  return (
    <SlideOver
      open
      onClose={onClose}
      title={campaignId ? draft.name || "Campanha" : "Nova campanha"}
      className="md:w-[720px] lg:w-[1040px]"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      {/* Stepper */}
      <div className="shrink-0 border-b border-border px-4 md:px-6 py-3 overflow-x-auto">
        <ol className="flex items-center gap-2 min-w-max">
          {WIZARD_STEPS.map((s, i) => {
            const active = s === step;
            const done = i < stepIndex;
            return (
              <li key={s} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (i < stepIndex || campaignId) setStep(s);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium min-h-[36px] transition-colors",
                    active ? "bg-brand-600 text-white" : done ? "bg-brand-500/10 text-brand-400" : "bg-surface-overlay text-text-muted"
                  )}
                  aria-current={active ? "step" : undefined}
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-black/20 text-[10px]">
                    {done ? <Check size={10} /> : i + 1}
                  </span>
                  {WIZARD_STEP_LABELS[s]}
                </button>
                {i < WIZARD_STEPS.length - 1 && <span className="h-px w-4 bg-border" />}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">
        {step === "channel" && <StepChannel organizationId={organizationId} draft={draft} setDraft={setDraft} locked={!isDraft} now={now} />}
        {step === "audience" && (
          <StepAudience organizationId={organizationId} campaignId={campaignId} draft={draft} setDraft={setDraft} isDraft={isDraft} now={now} />
        )}
        {step === "message" && (
          <StepMessage
            organizationId={organizationId}
            campaignId={campaignId}
            draft={draft}
            setDraft={setDraft}
            editable={isDraft}
            businessName={channelName}
            recipientsTotal={recipientsTotal}
          />
        )}
        {step === "limits" && <StepLimits draft={draft} setDraft={setDraft} now={now} editable={editableLimits} />}
        {step === "review" && (
          <StepReview
            draft={draft}
            recipientsTotal={recipientsTotal}
            channelName={channelName}
            safePacing={safeDefaults?.safe ?? null}
            consentAck={consentAck}
            bridgeRiskAck={bridgeRiskAck}
            onConsentAck={setConsentAck}
            onBridgeRiskAck={setBridgeRiskAck}
            newNumberRisk={newNumberRisk}
            newNumberRiskAck={newNumberRiskAck}
            onNewNumberRiskAck={setNewNumberRiskAck}
            canLaunch={canLaunch && isDraft}
            estimatedCostUsd={estimatedCost}
            warnings={[]}
          />
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border px-4 md:px-6 py-3 flex items-center gap-2 flex-wrap bg-surface-raised">
        <Button variant="ghost" onClick={goBack} disabled={stepIndex === 0 || saving}>
          <ChevronLeft size={16} /> Voltar
        </Button>
        <span className="flex-1 text-xs text-text-muted truncate">{stepError ?? ""}</span>
        <Button variant="secondary" onClick={() => void handleSaveAndClose()} disabled={saving}>
          <Save size={16} /> Salvar rascunho
        </Button>
        {step !== "review" ? (
          <Button onClick={() => void goNext()} disabled={saving}>
            {saving ? <Spinner size="sm" /> : null}
            Continuar <ChevronRight size={16} />
          </Button>
        ) : isDraft ? (
          canLaunch ? (
            <Button onClick={() => void handleLaunch()} disabled={saving || !consentAck || (draft.provider === "bridge" && !bridgeRiskAck) || (newNumberRisk !== null && !newNumberRiskAck)}>
              {saving ? <Spinner size="sm" /> : <Rocket size={16} />}
              Lançar campanha
            </Button>
          ) : (
            <span className="text-xs text-text-muted">Peça a um administrador para lançar</span>
          )
        ) : null}
      </div>
    </SlideOver>
  );
}
