import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { mutationErrorMessage } from "@/lib/errors";
import {
  toLeadDetailsUpdate,
  validateLeadDetails,
  type LeadDetailsForm,
  type LeadPriority,
  type LeadTemperature,
} from "@/lib/leadFields";
import { LeadBlockHeading, type LeadDoc } from "./LeadBlockHeading";

const PRIORITY_OPTIONS = [
  { value: "low", label: "Baixa" },
  { value: "medium", label: "Média" },
  { value: "high", label: "Alta" },
  { value: "urgent", label: "Urgente" },
];

const TEMPERATURE_OPTIONS = [
  { value: "cold", label: "Frio" },
  { value: "warm", label: "Morno" },
  { value: "hot", label: "Quente" },
];

function formFromLead(lead: LeadDoc): LeadDetailsForm {
  return {
    title: lead.title,
    value: lead.value,
    priority: lead.priority,
    temperature: lead.temperature,
    tags: (lead.tags || []).join(", "),
  };
}

/** "Detalhes do lead": título, valor, prioridade, temperatura e etiquetas. */
export function LeadBasicsBlock({ leadId, lead }: { leadId: Id<"leads">; lead: LeadDoc }) {
  const updateLead = useMutation(api.leads.updateLead);
  const [form, setForm] = useState<LeadDetailsForm>(() => formFromLead(lead));
  const [saving, setSaving] = useState(false);

  // O lead mudou no servidor (ou foi salvo): o formulário volta a espelhá-lo.
  useEffect(() => {
    setForm(formFromLead(lead));
  }, [lead]);

  const set = <K extends keyof LeadDetailsForm>(key: K, value: LeadDetailsForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    const problem = validateLeadDetails(form);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      await updateLead({ leadId, ...toLeadDetailsUpdate(form) });
      toast.success("Detalhes do lead atualizados");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível salvar os detalhes."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <LeadBlockHeading>Detalhes do lead</LeadBlockHeading>
      <div className="space-y-4">
        <Input label="Título" type="text" value={form.title} onChange={(e) => set("title", e.target.value)} />
        <Input
          label="Valor"
          type="number"
          inputMode="decimal"
          min={0}
          value={form.value}
          onChange={(e) => set("value", Number(e.target.value))}
        />
        <Select
          label="Prioridade"
          value={form.priority}
          onValueChange={(v) => set("priority", v as LeadPriority)}
          options={PRIORITY_OPTIONS}
        />
        <Select
          label="Temperatura"
          value={form.temperature}
          onValueChange={(v) => set("temperature", v as LeadTemperature)}
          options={TEMPERATURE_OPTIONS}
        />
        <Input
          label="Etiquetas (separadas por vírgula)"
          type="text"
          value={form.tags}
          onChange={(e) => set("tags", e.target.value)}
          placeholder="ex.: enterprise, urgente, follow-up"
        />
        <Button onClick={() => void handleSave()} loading={saving} variant="primary" size="md" className="w-full">
          {saving ? "Salvando…" : "Salvar detalhes"}
        </Button>
      </div>
    </div>
  );
}
