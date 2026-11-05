import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { RefreshCw, ChevronDown, History } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChannelConfig } from "./types";

// --- Histórico do aparelho (bridge, por número) ---
//
// Fica DENTRO do card do número, e não numa aba geral de configurações, porque
// a config é por instância do gateway: cada número tem seu volume, seu risco e
// seu estado de sessão. Ver o interruptor ao lado do status de pareamento é o
// que deixa claro de qual número se está falando.
//
// Desligado por padrão: enquanto estiver assim o CRM não chama nenhum endpoint
// de histórico do gateway.

const HISTORY_LIMIT_MIN = 10;
const HISTORY_LIMIT_MAX = 500;
const HISTORY_DAYS_MIN = 1;
const HISTORY_DAYS_MAX = 30;

export function BridgeHistoryPanel({
  organizationId,
  config,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig;
}) {
  const setHistoryConfig = useAction(api.bridge.setBridgeHistoryConfig);
  const syncHistory = useAction(api.bridge.syncBridgeHistory);

  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Rascunhos locais: o input precisa aceitar estados intermediários enquanto se
  // digita (inclusive vazio) sem que cada tecla vire uma escrita no servidor.
  const [limitDraft, setLimitDraft] = useState(String(config.bridgeHistoryLimit));
  const [daysDraft, setDaysDraft] = useState(String(config.bridgeHistoryDays));

  // Reconcilia quando o servidor devolve um valor diferente do digitado (ele
  // normaliza para a faixa aceita) ou quando outra aba mexeu na config.
  useEffect(() => {
    setLimitDraft(String(config.bridgeHistoryLimit));
  }, [config.bridgeHistoryLimit]);
  useEffect(() => {
    setDaysDraft(String(config.bridgeHistoryDays));
  }, [config.bridgeHistoryDays]);

  const enabled = config.bridgeHistoryEnabled;
  const paired = config.bridgeSessionState === "connected";

  const persist = async (patch: { enabled?: boolean; limit?: number; days?: number }) => {
    setSaving(true);
    try {
      const result = await setHistoryConfig({ configId: config._id, ...patch });
      // `gatewayApplied: false` = preferência salva mas o gateway não confirmou.
      // É um aviso, não um erro: a próxima sincronização reenvia o teto.
      if (result.gatewayApplied) toast.success(result.detail);
      else toast.warning(result.detail);
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível salvar");
    } finally {
      setSaving(false);
    }
  };

  const commitNumber = (
    draft: string,
    current: number,
    min: number,
    max: number,
    key: "limit" | "days"
  ) => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      // Campo vazio/inválido volta para o valor vigente em vez de virar default.
      if (key === "limit") setLimitDraft(String(current));
      else setDaysDraft(String(current));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    if (key === "limit") setLimitDraft(String(clamped));
    else setDaysDraft(String(clamped));
    if (clamped === current) return;
    void persist({ [key]: clamped } as { limit?: number; days?: number });
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncHistory({ configId: config._id });
      toast.success(result.detail);
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível sincronizar.");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg bg-surface-base border border-border-subtle p-2.5">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <History size={15} className="shrink-0 text-text-muted" />
          <span className="min-w-0">
            <span className="block text-sm text-text-primary">Histórico do aparelho</span>
            <span className="block text-xs text-text-muted mt-0.5">
              {enabled
                ? `Últimos ${config.bridgeHistoryDays} dias · até ${config.bridgeHistoryLimit} msgs por conversa`
                : "Recupera mensagens enviadas pelo celular que o CRM não recebeu"}
            </span>
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-text-muted transition-transform",
              expanded && "rotate-180"
            )}
          />
        </button>
        <PermissionGate
          organizationId={organizationId}
          category="settings"
          level="manage"
          fallback={
            <Badge variant={enabled ? "success" : "default"}>
              {enabled ? "Ativado" : "Desativado"}
            </Badge>
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Histórico do aparelho"
            disabled={saving}
            onClick={() => void persist({ enabled: !enabled })}
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50",
              enabled ? "bg-brand-500" : "bg-surface-overlay border border-border-strong"
            )}
          >
            <span
              className={cn(
                "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                enabled ? "translate-x-5" : "translate-x-1"
              )}
            />
          </button>
        </PermissionGate>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
          <p className="text-xs text-text-muted leading-relaxed">
            A conexão guarda uma cópia das mensagens deste número e o CRM importa o
            que estiver faltando — mensagens digitadas no app do celular, ou
            recebidas enquanto o CRM estava fora do ar. Importar duas vezes não
            duplica nada.
          </p>

          <PermissionGate organizationId={organizationId} category="settings" level="manage">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="block text-xs text-text-muted mb-1">
                  Msgs por conversa ({HISTORY_LIMIT_MIN}–{HISTORY_LIMIT_MAX})
                </span>
                <Input
                  type="number"
                  min={HISTORY_LIMIT_MIN}
                  max={HISTORY_LIMIT_MAX}
                  value={limitDraft}
                  disabled={!enabled || saving}
                  onChange={(e) => setLimitDraft(e.target.value)}
                  onBlur={() =>
                    commitNumber(
                      limitDraft,
                      config.bridgeHistoryLimit,
                      HISTORY_LIMIT_MIN,
                      HISTORY_LIMIT_MAX,
                      "limit"
                    )
                  }
                />
              </label>
              <label className="block">
                <span className="block text-xs text-text-muted mb-1">
                  Janela em dias ({HISTORY_DAYS_MIN}–{HISTORY_DAYS_MAX})
                </span>
                <Input
                  type="number"
                  min={HISTORY_DAYS_MIN}
                  max={HISTORY_DAYS_MAX}
                  value={daysDraft}
                  disabled={!enabled || saving}
                  onChange={(e) => setDaysDraft(e.target.value)}
                  onBlur={() =>
                    commitNumber(
                      daysDraft,
                      config.bridgeHistoryDays,
                      HISTORY_DAYS_MIN,
                      HISTORY_DAYS_MAX,
                      "days"
                    )
                  }
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!enabled || syncing || !paired}
                onClick={() => void handleSync()}
              >
                {syncing ? <Spinner size="sm" /> : <RefreshCw size={14} />}
                Sincronizar agora
              </Button>
              {!paired && (
                <span className="text-xs text-text-muted">
                  Número precisa estar conectado
                </span>
              )}
            </div>
          </PermissionGate>

          {config.bridgeHistoryLastResult && (
            <p className="text-xs text-text-muted break-words">
              Última sincronização
              {config.bridgeHistoryLastSyncAt
                ? ` em ${new Date(config.bridgeHistoryLastSyncAt).toLocaleString("pt-BR")}`
                : ""}
              : {config.bridgeHistoryLastResult}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
