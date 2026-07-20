import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

// "Saúde do canal": entregas/leituras/falhas dos últimos 7 dias sobre as
// conversas WhatsApp da org, com alerta de taxa de falha (sinal pré-ban).

const WINDOW_DAYS = 7;

function formatRelative(ts: number | null): string {
  if (!ts) return "—";
  const diffMin = Math.round((Date.now() - ts) / 60_000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin}min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `há ${diffH}h`;
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function ChannelHealthPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  // Congelado na montagem — janela móvel não precisa ser reativa ao minuto.
  const [since] = useState(() => Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const stats = useQuery(api.channelConfigs.getChannelStats, { organizationId, since });

  if (!stats) return null;

  const failureRate = stats.sent > 0 ? stats.failed / stats.sent : 0;
  const deliveredRate = stats.sent > 0 ? stats.delivered / stats.sent : 0;
  const highFailure = stats.sent >= 10 && failureRate > 0.1;

  const tiles: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Enviadas (7d)", value: String(stats.sent) },
    {
      label: "Entregues",
      value: stats.sent > 0 ? `${Math.round(deliveredRate * 100)}%` : "—",
      sub: stats.read > 0 ? `${stats.read} lidas` : undefined,
    },
    {
      label: "Falhas",
      value: String(stats.failed),
      sub: stats.sent > 0 ? `${Math.round(failureRate * 100)}%` : undefined,
    },
    { label: "Recebidas (7d)", value: String(stats.inbound) },
  ];

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface-sunken p-4">
      <div className="flex items-center gap-2 mb-3">
        <Activity size={15} className="text-brand-500" />
        <h4 className="text-sm font-semibold text-text-primary">Saúde do canal</h4>
        <span className="text-xs text-text-muted">últimos {WINDOW_DAYS} dias</span>
      </div>

      {highFailure && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-xs text-semantic-warning">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            Taxa de falha alta ({Math.round(failureRate * 100)}%). Considere pausar os envios e
            verificar a conexão do número — falhas em sequência são um sinal comum antes de
            restrição/ban.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg bg-surface-raised border border-border px-3 py-2">
            <p className="text-[11px] text-text-muted">{tile.label}</p>
            <p
              className={cn(
                "text-lg font-semibold tabular-nums",
                tile.label === "Falhas" && stats.failed > 0
                  ? "text-semantic-error"
                  : "text-text-primary"
              )}
            >
              {tile.value}
            </p>
            {tile.sub && <p className="text-[11px] text-text-muted">{tile.sub}</p>}
          </div>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span className="flex items-center gap-1">
          <ArrowUpRight size={12} />
          Último envio: {formatRelative(stats.lastOutboundAt)}
        </span>
        <span className="flex items-center gap-1">
          <ArrowDownLeft size={12} />
          Último recebimento: {formatRelative(stats.lastInboundAt)}
        </span>
        {stats.sampled && <span>· métricas sobre as 1000 mensagens mais recentes</span>}
      </div>
    </div>
  );
}
