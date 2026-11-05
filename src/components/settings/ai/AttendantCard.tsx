import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { Bot } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { PERSONAS } from "./aiTypes";
import { Attendant } from "../attendant/types";
import { AttendantConfig } from "../attendant/AttendantConfig";

// ── Atendente virtual (1 toque + personalizar + simulador) ──

export function AttendantCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as
    | Attendant[]
    | undefined;
  const createAttendant = useMutation(api.aiSettings.createAttendantOneClick);
  const [personaId, setPersonaId] = useState("");
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    setBusy(true);
    try {
      await createAttendant({
        organizationId,
        ...(personaId ? { personaId } : {}),
      });
      toast.success("Atendente IA criado em modo Sugerir respostas");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível criar atendente.");
    } finally {
      setBusy(false);
    }
  };

  if (attendants === undefined) {
    return (
      <Card>
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (attendants.length === 0) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 shrink-0 rounded-full bg-ai-500/10 flex items-center justify-center">
            <Bot size={20} className="text-ai-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-text-primary">{VOCAB.attendant.name}</h3>
            <p className="text-sm text-text-secondary mt-1 mb-4">
              Nasce pronto: jeito de atender pelo seu ramo, o que a IA sabe do seu negócio a partir das suas respostas rápidas,
              horário comercial. Começa em <strong>Sugerir respostas</strong>: cada resposta vira uma
              resposta sugerida que sua equipe aprova antes de enviar. Funciona em canais WhatsApp
              oficiais (Meta).
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Jeito de atender
                </label>
                <select
                  value={personaId}
                  onChange={(e) => setPersonaId(e.target.value)}
                  className="bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500"
                >
                  <option value="">Automática (pelo meu ramo)</option>
                  {PERSONAS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button onClick={() => void handleCreate()} disabled={busy}>
                <Bot size={16} className="mr-1.5" />
                Ativar atendente
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      {attendants.map((attendant) => (
        <AttendantConfig
          key={attendant._id}
          organizationId={organizationId}
          attendant={attendant}
        />
      ))}
    </>
  );
}
