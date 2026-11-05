import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Building2, Cloud, GraduationCap, HeartPulse, MoreHorizontal, ShoppingCart, Wrench } from "lucide-react";
import { Link } from "react-router";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SEGMENT_TEMPLATES } from "../../../../convex/lib/onboardingTemplates";
import { Checkbox } from "@/components/ui/Checkbox";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Input } from "@/components/ui/Input";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Textarea } from "@/components/ui/Textarea";
import { mutationErrorMessage } from "@/lib/errors";
import {
  TONE_OPTIONS,
  aiCheckboxState,
  businessDraftFromStatus,
  businessErrors,
  businessSavePlan,
  canAdvance,
  type BusinessDraft,
  type BusinessTone,
  type OnboardingStatus,
} from "@/lib/onboardingWizard";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { WizardNav } from "./OnboardingWizardV2View";

const SEGMENT_ICONS: Record<string, React.ElementType> = {
  Building2,
  Cloud,
  Wrench,
  HeartPulse,
  ShoppingCart,
  GraduationCap,
  MoreHorizontal,
};

export interface OrgDefaults {
  timezone?: string;
  currency?: string;
  defaultCountryCode?: string;
}

interface StepBusinessProps {
  organizationId: Id<"organizations">;
  status: OnboardingStatus;
  aiActive: boolean;
  orgDefaults?: OrgDefaults;
  onSaved: () => void;
}

/** Passo 1: segmento, o que a empresa vende, tom e o aceite opcional para a IA ajudar. */
export function StepBusiness({ organizationId, status, aiActive, orgDefaults, onSaved }: StepBusinessProps) {
  const saveProfile = useMutation(api.onboarding.saveBusinessProfile);
  const setAiEnabled = useMutation(api.aiSettings.setAiEnabled);
  const [draft, setDraft] = useState<BusinessDraft>(() => ({ ...businessDraftFromStatus(status), aiHelp: aiActive }));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = touched ? businessErrors(draft) : {};
  const aiBox = aiCheckboxState(status);
  const set = <K extends keyof BusinessDraft>(key: K, value: BusinessDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const onSegmentKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = SEGMENT_TEMPLATES.map((t) => t.key as string);
    const i = keys.indexOf(draft.segment);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % keys.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + keys.length) % keys.length;
    if (next < 0) return;
    e.preventDefault();
    set("segment", keys[next]);
    (e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next])?.focus();
  };

  const handleContinue = async () => {
    setTouched(true);
    if (!canAdvance("business", { business: draft })) return;
    const plan = businessSavePlan(draft, status, aiActive);
    setSaving(true);
    let profileSaved = false;
    try {
      await saveProfile({ organizationId, ...plan.profile });
      profileSaved = true;
      // O aceite é um clique humano: só liga a IA com o checkbox marcado.
      if (plan.enableAi) await setAiEnabled({ organizationId, enabled: true, lgpdAck: true });
      onSaved();
    } catch (e) {
      const message = mutationErrorMessage(e, "Não foi possível salvar.");
      toast.error(profileSaved ? `Seu negócio foi salvo, mas não foi possível ligar a IA. ${message}` : message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard title="Seu negócio" description="Com isso sugerimos seu funil e o jeito do seu Atendente IA falar.">
        <div className="space-y-5">
          <div className="space-y-2">
            <p id="segmento-label" className="text-[13px] font-medium text-text-secondary">
              Qual é o seu segmento?
            </p>
            <div
              role="radiogroup"
              aria-labelledby="segmento-label"
              onKeyDown={onSegmentKeyDown}
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {SEGMENT_TEMPLATES.map((t, i) => {
                const Icon = SEGMENT_ICONS[t.icon] ?? MoreHorizontal;
                const selected = draft.segment === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected || (!draft.segment && i === 0) ? 0 : -1}
                    onClick={() => set("segment", t.key)}
                    className={cn(
                      "flex min-h-11 flex-col items-center justify-center gap-1.5 rounded-card border p-3 text-center text-sm transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
                      selected
                        ? "border-brand-500 bg-brand-500/10 text-text-primary"
                        : "border-border bg-surface-raised text-text-secondary hover:border-border-strong",
                    )}
                  >
                    <Icon size={20} aria-hidden="true" />
                    {t.label}
                  </button>
                );
              })}
            </div>
            {errors.segment && <p role="alert" className="text-caption text-semantic-error">{errors.segment}</p>}
          </div>

          <Input
            label="Nome do negócio"
            value={draft.displayName}
            maxLength={80}
            onChange={(e) => set("displayName", e.target.value)}
            placeholder="Como seus clientes conhecem você"
            error={errors.displayName}
          />
          <Textarea
            label="O que você vende"
            hint="Em 1 a 3 frases."
            rows={3}
            maxLength={600}
            value={draft.offer}
            onChange={(e) => set("offer", e.target.value)}
            error={errors.offer}
            required
          />
          <Textarea
            label="Quem são seus clientes"
            rows={2}
            maxLength={400}
            showOptional
            value={draft.audience}
            onChange={(e) => set("audience", e.target.value)}
            error={errors.audience}
          />
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium text-text-secondary">Tom de voz</p>
            <SegmentedControl
              ariaLabel="Tom de voz"
              value={draft.tone}
              onValueChange={(v) => set("tone", v as BusinessTone)}
              options={TONE_OPTIONS.map((o) => ({ ...o }))}
            />
          </div>
          <Input
            label="Cidade ou região (opcional)"
            value={draft.region}
            maxLength={80}
            onChange={(e) => set("region", e.target.value)}
            error={errors.region}
          />

          <CollapsibleSection title="Mais opções">
            <div className="space-y-2 text-sm text-text-secondary">
              <p>
                País (DDI): <span className="tabular-nums text-text-primary">+{orgDefaults?.defaultCountryCode ?? "55"}</span>
              </p>
              <p>
                Fuso horário: <span className="text-text-primary">{orgDefaults?.timezone ?? "America/Sao_Paulo"}</span>
              </p>
              <p>
                Moeda: <span className="text-text-primary">{orgDefaults?.currency ?? "BRL"}</span>
              </p>
              <Link to={`${TAB_ROUTES.settings}?secao=general`} className="inline-flex min-h-11 items-center text-brand-500 hover:text-brand-400">
                Alterar em Configurações
              </Link>
            </div>
          </CollapsibleSection>

          {aiBox.visible && (
            <div className="space-y-1.5 border-t border-border pt-4">
              {/* TODO(Eric): texto jurídico do aceite LGPD */}
              <Checkbox
                containerClassName="min-h-11 items-center"
                checked={draft.aiHelp}
                disabled={aiBox.disabled || aiActive}
                onChange={(e) => set("aiHelp", e.target.checked)}
                label="Quero que a IA me ajude a configurar (o assistente processa dados de clientes com provedores de IA, conforme a LGPD)"
              />
              {(aiBox.reason || aiActive) && (
                <p className="text-caption text-text-muted">{aiBox.reason ?? "A IA já está ligada."}</p>
              )}
            </div>
          )}
        </div>
      </SectionCard>
      <WizardNav onContinue={() => void handleContinue()} continueLoading={saving} />
    </div>
  );
}
