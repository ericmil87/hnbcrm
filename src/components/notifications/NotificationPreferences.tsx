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
  { key: "invite", label: "Convites de equipe", desc: "Quando você é convidado para uma organização", alwaysOn: true },
  { key: "handoffRequested", label: "Repasse solicitado", desc: "Quando um agente IA solicita repasse para você" },
  { key: "handoffResolved", label: "Repasse resolvido", desc: "Quando um repasse e aceito ou rejeitado" },
  { key: "aiDraftPending", label: "Rascunho da IA aguardando revisão", desc: "Quando a IA deixa uma resposta para você revisar em um lead seu" },
  { key: "campaignCompleted", label: "Campanha concluída", desc: "Quando uma campanha de WhatsApp termina de enviar" },
  { key: "campaignPaused", label: "Campanha pausada por segurança", desc: "Quando um limite ou sinal de risco pausa uma campanha automaticamente" },
  { key: "taskOverdue", label: "Tarefa atrasada", desc: "Quando uma tarefa atribuída a você está atrasada" },
  { key: "taskAssigned", label: "Tarefa atribuida", desc: "Quando uma tarefa é atribuída a você" },
  { key: "taskCommentMention", label: "Menção em comentário de tarefa", desc: "Quando alguém te menciona em um comentário de tarefa" },
  { key: "taskDueSoon", label: "Lembrete antecipado de tarefa (vence em breve)", desc: "Quando uma tarefa atribuída a você está prestes a vencer" },
  { key: "leadAssigned", label: "Lead atribuido", desc: "Quando um lead é atribuído a você" },
  { key: "newMessage", label: "Nova mensagem", desc: "Quando um contato envia mensagem em um lead seu" },
  { key: "dailyDigest", label: "Resumo diário", desc: "Resumo das atividades do dia anterior, enviado às 08:00" },
] as const;

const GROUP_NOTIFICATION_EVENTS = [
  { key: "groupJoined", label: "Entrou em um grupo", desc: "Quando o número do WhatsApp passa a fazer parte de um grupo novo" },
  { key: "groupMention", label: "Menção em grupo", desc: "Quando alguém menciona o número da empresa em um grupo acompanhado" },
  { key: "groupPostPending", label: "Publicação aguardando aprovação", desc: "Quando a IA gera o texto de uma publicação programada e ele precisa da sua aprovação" },
  { key: "groupPostFailed", label: "Falha em publicação programada", desc: "Quando uma publicação programada não consegue enviar" },
  { key: "groupOpportunity", label: "Oportunidade detectada em grupo", desc: "Quando o radar da IA vê uma possível oportunidade de negócio em um grupo" },
  { key: "groupDigest", label: "Resumo diário do grupo", desc: "Resumo do que aconteceu nos grupos acompanhados" },
] as const;

const ALL_NOTIFICATION_EVENTS = [...NOTIFICATION_EVENTS, ...GROUP_NOTIFICATION_EVENTS];

type PreferenceKey = typeof ALL_NOTIFICATION_EVENTS[number]["key"];

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
      for (const event of ALL_NOTIFICATION_EVENTS) {
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

  const renderEventRow = (event: (typeof ALL_NOTIFICATION_EVENTS)[number]) => {
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
            aria-label={`Notificação por email: ${event.label}`}
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
  };

  const isDirty = ALL_NOTIFICATION_EVENTS.some(
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
      toast.success("Preferências salvas com sucesso");
    } catch {
      toast.error("Erro ao salvar preferências");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-1">
          <Bell size={20} className="text-brand-500" />
          <h3 className="text-lg font-semibold text-text-primary">Preferências de Notificação por Email</h3>
        </div>
        <p className="text-sm text-text-secondary mb-6">
          Escolha quais eventos devem gerar notificações por email.
        </p>

        {/* Header row — desktop only */}
        <div className="hidden md:grid grid-cols-[1fr_80px] gap-4 pb-3 border-b border-border mb-2">
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider">Evento</span>
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider text-center">Email</span>
        </div>

        {/* Event rows */}
        <div className="divide-y divide-border">
          {NOTIFICATION_EVENTS.map(renderEventRow)}
        </div>

        {/* Grupos de WhatsApp */}
        <div className="pt-4 mt-2 border-t border-border">
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
            Grupos de WhatsApp
          </span>
          <div className="divide-y divide-border">
            {GROUP_NOTIFICATION_EVENTS.map(renderEventRow)}
          </div>
        </div>

        {/* Save button */}
        <div className="flex justify-end pt-4 mt-2 border-t border-border">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saving}
          >
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
