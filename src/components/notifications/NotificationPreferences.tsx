import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Bell } from "lucide-react";

const NOTIFICATION_EVENTS = [
  { key: "invite", label: "Convites de equipe", desc: "Quando voce e convidado para uma organizacao", alwaysOn: true },
  { key: "handoffRequested", label: "Repasse solicitado", desc: "Quando um agente IA solicita repasse para voce" },
  { key: "handoffResolved", label: "Repasse resolvido", desc: "Quando um repasse e aceito ou rejeitado" },
  { key: "taskOverdue", label: "Tarefa atrasada", desc: "Quando uma tarefa atribuida a voce esta atrasada" },
  { key: "taskAssigned", label: "Tarefa atribuida", desc: "Quando uma tarefa e atribuida a voce" },
  { key: "leadAssigned", label: "Lead atribuido", desc: "Quando um lead e atribuido a voce" },
  { key: "newMessage", label: "Nova mensagem", desc: "Quando um contato envia mensagem em um lead seu" },
  { key: "dailyDigest", label: "Resumo diario", desc: "Resumo das atividades do dia anterior, enviado as 08:00" },
] as const;

type PreferenceKey = typeof NOTIFICATION_EVENTS[number]["key"];

interface NotificationsSectionProps {
  organizationId: Id<"organizations">;
}

export function NotificationsSection({ organizationId }: NotificationsSectionProps) {
  const prefs = useQuery(api.notificationPreferences.getMyPreferences, { organizationId });
  const updatePrefs = useMutation(api.notificationPreferences.updateMyPreferences);

  const [localPrefs, setLocalPrefs] = useState<Record<PreferenceKey, boolean> | null>(null);
  const [saving, setSaving] = useState(false);

  // Sync from server
  useEffect(() => {
    if (prefs && !localPrefs) {
      const initial: Record<string, boolean> = {};
      for (const event of NOTIFICATION_EVENTS) {
        initial[event.key] = (prefs as any)[event.key] ?? true;
      }
      setLocalPrefs(initial as Record<PreferenceKey, boolean>);
    }
  }, [prefs, localPrefs]);

  if (prefs === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!localPrefs) return null;

  const isDirty = NOTIFICATION_EVENTS.some(
    (event) => localPrefs[event.key] !== ((prefs as any)[event.key] ?? true)
  );

  const handleToggle = (key: PreferenceKey) => {
    setLocalPrefs((prev) => prev ? { ...prev, [key]: !prev[key] } : prev);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updatePrefs({
        organizationId,
        ...localPrefs,
      });
      toast.success("Preferencias salvas com sucesso");
    } catch {
      toast.error("Erro ao salvar preferencias");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-1">
          <Bell size={20} className="text-brand-500" />
          <h3 className="text-lg font-semibold text-text-primary">Preferencias de Notificacao por Email</h3>
        </div>
        <p className="text-sm text-text-secondary mb-6">
          Escolha quais eventos devem gerar notificacoes por email.
        </p>

        {/* Header row — desktop only */}
        <div className="hidden md:grid grid-cols-[1fr_80px] gap-4 pb-3 border-b border-border mb-2">
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider">Evento</span>
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider text-center">Email</span>
        </div>

        {/* Event rows */}
        <div className="divide-y divide-border">
          {NOTIFICATION_EVENTS.map((event) => {
            const isOn = localPrefs[event.key];
            const isAlwaysOn = "alwaysOn" in event && event.alwaysOn;

            return (
              <div
                key={event.key}
                className="grid grid-cols-1 md:grid-cols-[1fr_80px] gap-2 md:gap-4 py-4 items-center"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{event.label}</span>
                    {isAlwaysOn && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted">
                        Sempre ativo
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5">{event.desc}</p>
                </div>

                <div className="flex md:justify-center">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isOn}
                    aria-label={`Notificacao por email: ${event.label}`}
                    disabled={isAlwaysOn}
                    onClick={() => !isAlwaysOn && handleToggle(event.key)}
                    className={cn(
                      "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                      isOn ? "bg-brand-500" : "bg-surface-overlay border border-border-strong",
                      isAlwaysOn && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <span
                      className={cn(
                        "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                        isOn ? "translate-x-5" : "translate-x-1"
                      )}
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Save button */}
        <div className="flex justify-end pt-4 mt-2 border-t border-border">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saving}
          >
            {saving ? "Salvando..." : "Salvar alteracoes"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
