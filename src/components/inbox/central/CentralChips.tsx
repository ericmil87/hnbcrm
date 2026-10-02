import { ArrowRightLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  attributionDetail,
  attributionSourceMeta,
  hexAlpha,
  shortId,
  transferTarget,
  type LeadAttribution,
  type TransferMeta,
} from "./centralMeta";

interface ColorChipProps {
  name: string;
  color?: string;
  /** Rótulo acessível ("Unidade: Pousada X"). */
  title?: string;
  className?: string;
}

/** Chip pequeno com a cor da unidade/setor (lista de conversas, header). */
export function ColorChip({ name, color, title, className }: ColorChipProps) {
  return (
    <span
      title={title ?? name}
      className={cn(
        "inline-flex max-w-[9rem] items-center gap-1 rounded-full border border-border-strong px-1.5 py-px text-[11px] font-medium leading-4 text-text-secondary",
        className
      )}
      style={{
        borderColor: hexAlpha(color, 0.45),
        backgroundColor: hexAlpha(color, 0.12),
      }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? "#71717A" }}
        aria-hidden
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Ícone da origem do lead (Meta, Google, Instagram…) — só o ícone, com title. */
export function AttributionIcon({ attribution }: { attribution: LeadAttribution }) {
  const meta = attributionSourceMeta(attribution.source);
  const Icon = meta.icon;
  const detail = attributionDetail(attribution);
  const label = detail ? `${meta.label}: ${detail}` : meta.label;
  return (
    <span className={cn("inline-flex shrink-0", meta.tone)} title={label} aria-label={`Origem — ${label}`}>
      <Icon size={13} aria-hidden />
    </span>
  );
}

/**
 * Faixa discreta no topo da conversa: "Veio do anúncio Meta · 'Natal Luz'".
 * O link do anúncio (quando a Meta manda) abre em nova aba.
 */
export function AttributionStrip({ attribution }: { attribution: LeadAttribution }) {
  const meta = attributionSourceMeta(attribution.source);
  const Icon = meta.icon;
  const detail = attributionDetail(attribution);
  const safeUrl =
    attribution.adSourceUrl && /^https?:\/\//i.test(attribution.adSourceUrl)
      ? attribution.adSourceUrl
      : null;
  const clickId = attribution.ctwaClid
    ? `ctwa ${shortId(attribution.ctwaClid)}`
    : attribution.gclid
      ? `gclid ${shortId(attribution.gclid)}`
      : null;
  return (
    <div className="shrink-0 border-b border-border-subtle bg-surface-sunken/60 px-4 py-1.5">
      <p className="flex w-full min-w-0 items-center gap-1.5 text-xs text-text-muted">
        <Icon size={13} className={cn("shrink-0", meta.tone)} aria-hidden />
        <span className="shrink-0 font-medium text-text-secondary">{meta.phrase}</span>
        {detail && (
          <span className="min-w-0 truncate">
            · <span className="text-text-secondary">“{detail}”</span>
          </span>
        )}
        {clickId && (
          <span className="hidden shrink-0 font-mono text-[10px] text-text-muted sm:inline">
            {clickId}
          </span>
        )}
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 rounded text-brand-500 hover:text-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            Ver anúncio
          </a>
        )}
      </p>
    </div>
  );
}

interface TransferEventProps {
  actorName?: string | null;
  transfer: TransferMeta;
  createdAt: number;
}

/** Transferência de setor na timeline: evento de sistema centralizado, não bolha. */
export function TransferEvent({ actorName, transfer, createdAt }: TransferEventProps) {
  const time = new Date(createdAt).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const from = transfer.fromDept?.name;
  return (
    <div className="flex justify-center px-2" role="note">
      <div className="max-w-md rounded-2xl border border-border bg-surface-raised/70 px-3.5 py-2 text-center">
        <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-xs text-text-secondary">
          <ArrowRightLeft size={13} className="shrink-0 text-brand-500" aria-hidden />
          <span className="font-medium text-text-primary">{actorName ?? "Alguém"}</span>
          <span>transferiu</span>
          {from && (
            <>
              <span>de</span>
              <span className="font-medium text-text-primary">{from}</span>
            </>
          )}
          <span>para</span>
          <span className="font-medium text-text-primary">{transferTarget(transfer)}</span>
          <span className="text-text-muted tabular-nums">· {time}</span>
        </p>
        {transfer.note && (
          <p className="mt-1 text-xs italic text-text-muted break-words">“{transfer.note}”</p>
        )}
      </div>
    </div>
  );
}
