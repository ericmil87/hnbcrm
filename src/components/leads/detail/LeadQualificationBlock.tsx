import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Info } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Popover } from "@/components/ui/Popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import {
  QUALIFICATION_CRITERIA,
  QUALIFICATION_MAX,
  qualificationFromLead,
  qualificationScore,
  qualificationTone,
  toQualificationPayload,
  type QualificationState,
} from "@/lib/leadFields";
import { LeadBlockHeading, type LeadDoc } from "./LeadBlockHeading";

const BANT_ITEMS = [
  { letter: "B", label: "Budget", desc: "O prospect tem verba para comprar?" },
  { letter: "A", label: "Authority", desc: "Está falando com quem decide?" },
  { letter: "N", label: "Need", desc: "Existe uma dor real que seu produto resolve?" },
  { letter: "T", label: "Timeline", desc: "Há urgência ou prazo definido?" },
];

function BantInfoContent() {
  return (
    <div>
      <h4 className="text-sm font-semibold text-text-primary mb-1">O que é BANT?</h4>
      <p className="text-xs text-text-secondary mb-3 leading-relaxed">
        Método de qualificação de leads usado em vendas B2B. Quanto mais critérios atendidos, maior a chance de fechamento.
      </p>
      <div className="space-y-2.5">
        {BANT_ITEMS.map(({ letter, label, desc }) => (
          <div key={letter} className="flex items-start gap-2.5">
            <span className="shrink-0 w-6 h-6 rounded-md bg-brand-600 text-white text-xs font-bold flex items-center justify-center">
              {letter}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-text-primary">{label}</span>
              <p className="text-xs text-text-muted leading-tight">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Botão "i" que explica os quatro critérios (folha no celular, popover no desktop). */
function BantInfo() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery("(max-width: 639px)");
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="O que é BANT?"
        aria-expanded={open}
        className="flex min-h-6 min-w-6 coarse:min-h-11 coarse:min-w-11 items-center justify-center rounded-full text-text-muted hover:text-brand-400 hover:bg-brand-500/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchorRef} side="top" sheet={isMobile} className={cn(!isMobile && "w-72 p-4", isMobile && "p-5 pb-8")}>
        <BantInfoContent />
      </Popover>
    </>
  );
}

const SCORE_TEXT = { success: "text-semantic-success", warning: "text-semantic-warning", error: "text-text-muted", muted: "text-text-muted" };
const SCORE_BAR = { success: "bg-semantic-success", warning: "bg-semantic-warning", error: "bg-semantic-error", muted: "bg-surface-raised" };

/** Pontuação "n/4" com a barra de quatro segmentos. */
export function QualificationScore({ score }: { score: number }) {
  const tone = qualificationTone(score);
  return (
    <div className="pt-1">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-text-muted">Pontuação</span>
        <span className={cn("text-xs font-semibold tabular-nums", SCORE_TEXT[tone])}>
          {score}/{QUALIFICATION_MAX}
        </span>
      </div>
      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: QUALIFICATION_MAX }, (_, i) => (
          <div key={i} className={cn("h-1.5 flex-1 rounded-full transition-colors", i < score ? SCORE_BAR[tone] : "bg-surface-raised")} />
        ))}
      </div>
    </div>
  );
}

/** "Qualificação" (antigo BANT): quatro critérios marcáveis e a pontuação. */
export function LeadQualificationBlock({ leadId, lead }: { leadId: Id<"leads">; lead: LeadDoc }) {
  const updateQualification = useMutation(api.leads.updateLeadQualification);
  const [state, setState] = useState<QualificationState>(() => qualificationFromLead(lead.qualification));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setState(qualificationFromLead(lead.qualification));
  }, [lead.qualification]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateQualification({ leadId, qualification: toQualificationPayload(state) });
      toast.success("Qualificação atualizada");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível salvar a qualificação."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">Qualificação</h3>
        <BantInfo />
      </div>
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 auto-rows-fr">
          {QUALIFICATION_CRITERIA.map(({ key, label, desc }) => (
            <Checkbox
              key={key}
              checked={state[key]}
              onChange={(e) => setState((prev) => ({ ...prev, [key]: e.target.checked }))}
              containerClassName={cn(
                "flex h-full w-full rounded-lg border p-3 transition-colors",
                state[key] ? "border-brand-500/40 bg-brand-500/5" : "border-border bg-surface-sunken hover:border-border-strong"
              )}
              label={<span className="text-sm font-medium text-text-primary">{label}</span>}
              description={desc}
            />
          ))}
        </div>
        <QualificationScore score={qualificationScore(state)} />
        <Button onClick={() => void handleSave()} loading={saving} variant="primary" size="md" className="w-full">
          {saving ? "Salvando…" : "Salvar qualificação"}
        </Button>
      </div>
    </div>
  );
}
