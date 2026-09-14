import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCheck,
  Download,
  ExternalLink,
  FileText,
  File as FileIcon,
  Link2,
  MoreVertical,
  Phone,
  Reply,
  Signal,
  Video,
  Wifi,
  BatteryFull,
} from "lucide-react";
import { AudioPlayer } from "@/components/inbox/AudioPlayer";
import { formatFileSize, isAudioMime, isImageMime, isVideoMime } from "@/components/inbox/types";
import { containsLink, renderForRecipient } from "@/lib/whatsappFormat";
import { cn } from "@/lib/utils";
import { WhatsAppText } from "./WhatsAppText";

export interface WhatsAppPreviewAttachment {
  name: string;
  mimeType: string;
  url: string | null;
  size?: number;
}

export interface WhatsAppPreviewHeader {
  format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  text?: string;
  url?: string | null;
  filename?: string;
}

export interface WhatsAppPreviewButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  text: string;
}

export interface WhatsAppPreviewProps {
  /** Texto da variante OU body do template (com {{vars}} e spintax). */
  text: string;
  /** Destinatário de amostra — as variáveis são resolvidas aqui. */
  vars?: Record<string, string>;
  /** Seed do spintax (mesmo seed → mesma escolha). */
  seed?: number;
  /** Anexos da mensagem (imagem/vídeo/áudio/documento), como no inbox. */
  attachments?: WhatsAppPreviewAttachment[];
  /** Header do template Meta. */
  header?: WhatsAppPreviewHeader;
  /** Rodapé do template (cinza, pequeno). */
  footer?: string;
  /** Botões do template, renderizados abaixo da bolha. */
  buttons?: WhatsAppPreviewButton[];
  businessName?: string;
  businessAvatarUrl?: string | null;
  /** Default: agora (congelado na montagem). */
  timestamp?: number;
  className?: string;
  /** Sem moldura de celular — só a bolha (listas, cards). */
  compact?: boolean;
  /** Mostra contador de caracteres e aviso de link. */
  showMeta?: boolean;
}

// Verde do WhatsApp: bolha outbound (dark/light) e header. `.light` é a classe
// de tema do app (dark é o :root), por isso as variantes `[.light_&]:`.
const BUBBLE_CLASS =
  "bg-[#005c4b] text-[#e9edef] [.light_&]:bg-[#d9fdd3] [.light_&]:text-[#111b21]";
const BUBBLE_MUTED = "text-[#e9edef]/60 [.light_&]:text-[#111b21]/55";
const WALLPAPER_CLASS =
  "bg-[#0b141a] [.light_&]:bg-[#efeae2]";
const HEADER_CLASS = "bg-[#1f2c34] text-[#e9edef] [.light_&]:bg-[#008069] [.light_&]:text-white";
const BUTTON_CLASS =
  "bg-[#005c4b] text-[#53bdeb] [.light_&]:bg-[#d9fdd3] [.light_&]:text-[#027eb5]";
const TICK_CLASS = "text-[#53bdeb]";
const DATE_CHIP_CLASS =
  "bg-[#182229] text-[#8696a0] [.light_&]:bg-white/80 [.light_&]:text-[#54656f]";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function DocIcon({ mimeType }: { mimeType: string }) {
  const isDoc =
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("word") ||
    mimeType.includes("document");
  const Icon = isDoc ? FileText : FileIcon;
  return <Icon size={18} className="shrink-0" />;
}

function DocumentChip({ name, size, url, mimeType }: WhatsAppPreviewAttachment) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 px-3 py-2 rounded-lg max-w-[280px]",
        "bg-black/15 [.light_&]:bg-black/5"
      )}
    >
      <DocIcon mimeType={mimeType} />
      <div className="flex-1 min-w-0">
        <span className="block text-xs font-medium truncate">{name}</span>
        {size !== undefined && (
          <span className={cn("text-[10px]", BUBBLE_MUTED)}>{formatFileSize(size)}</span>
        )}
      </div>
      {url ? (
        <Download size={16} className="shrink-0 opacity-80" />
      ) : (
        <span className={cn("text-[10px]", BUBBLE_MUTED)}>sem arquivo</span>
      )}
    </div>
  );
}

function Attachment({ file }: { file: WhatsAppPreviewAttachment }) {
  if (isImageMime(file.mimeType)) {
    return file.url ? (
      <img
        src={file.url}
        alt={file.name}
        loading="lazy"
        className="max-w-full max-h-[240px] object-cover rounded-lg"
      />
    ) : (
      <div className="h-32 w-full rounded-lg bg-black/15 flex items-center justify-center text-xs opacity-70">
        Imagem
      </div>
    );
  }
  if (isVideoMime(file.mimeType)) {
    return file.url ? (
      <video src={file.url} controls preload="metadata" className="max-w-full max-h-[240px] rounded-lg" />
    ) : (
      <div className="h-32 w-full rounded-lg bg-black/15 flex items-center justify-center text-xs opacity-70">
        <Video size={18} className="mr-1.5" /> Vídeo
      </div>
    );
  }
  if (isAudioMime(file.mimeType)) {
    return file.url ? (
      <AudioPlayer src={file.url} variant="outbound" isVoiceNote className="min-w-[200px]" />
    ) : (
      <div className="h-10 w-full rounded-lg bg-black/15 flex items-center justify-center text-xs opacity-70">
        Áudio
      </div>
    );
  }
  return <DocumentChip {...file} />;
}

function TemplateHeader({ header }: { header: WhatsAppPreviewHeader }) {
  if (header.format === "TEXT") {
    return header.text ? <p className="text-sm font-semibold">{header.text}</p> : null;
  }
  if (header.format === "IMAGE") {
    return header.url ? (
      <img src={header.url} alt="" className="max-w-full max-h-[200px] w-full object-cover rounded-lg" />
    ) : (
      <div className="h-28 w-full rounded-lg bg-black/15 flex items-center justify-center text-xs opacity-70">
        Imagem do cabeçalho
      </div>
    );
  }
  if (header.format === "VIDEO") {
    return header.url ? (
      <video src={header.url} controls preload="metadata" className="max-w-full max-h-[200px] rounded-lg" />
    ) : (
      <div className="h-28 w-full rounded-lg bg-black/15 flex items-center justify-center text-xs opacity-70">
        <Video size={18} className="mr-1.5" /> Vídeo do cabeçalho
      </div>
    );
  }
  return (
    <DocumentChip
      name={header.filename ?? "documento.pdf"}
      mimeType="application/pdf"
      url={header.url ?? null}
    />
  );
}

function ButtonIcon({ type }: { type: WhatsAppPreviewButton["type"] }) {
  if (type === "URL") return <ExternalLink size={14} />;
  if (type === "PHONE_NUMBER") return <Phone size={14} />;
  return <Reply size={14} />;
}

/**
 * Prévia ao vivo de como a mensagem chega no WhatsApp do destinatário: moldura
 * de celular, header da empresa, papel de parede e a bolha outbound verde com
 * hora e ✓✓. Puramente apresentacional — recebe texto cru e resolve spintax e
 * {{vars}} para o destinatário de amostra.
 */
export function WhatsAppPreview({
  text,
  vars,
  seed = 0,
  attachments = [],
  header,
  footer,
  buttons = [],
  businessName = "Sua empresa",
  businessAvatarUrl,
  timestamp,
  className,
  compact = false,
  showMeta = false,
}: WhatsAppPreviewProps) {
  const [mountedAt] = useState(() => Date.now());
  const ts = timestamp ?? mountedAt;
  const resolved = useMemo(() => renderForRecipient(text, vars ?? {}, seed), [text, vars, seed]);
  const hasLink = useMemo(() => containsLink(resolved), [resolved]);
  const clock = formatClock(ts);
  const hasContent = resolved.trim().length > 0 || attachments.length > 0 || header !== undefined;

  const bubble = (
    <div className="flex justify-end">
      <div className="relative max-w-[85%]">
        {/* cauda da bolha */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-1.5 top-0 h-3 w-3 [clip-path:polygon(0_0,100%_0,0_100%)]",
            "bg-[#005c4b] [.light_&]:bg-[#d9fdd3]"
          )}
        />
        <div
          className={cn(
            "rounded-lg rounded-tr-none px-2 pt-1.5 pb-1 shadow-sm flex flex-col gap-1.5",
            BUBBLE_CLASS
          )}
        >
          {header && <TemplateHeader header={header} />}
          {attachments.map((file, i) => (
            <Attachment key={`${file.name}-${i}`} file={file} />
          ))}
          {resolved.trim() ? (
            <p className="text-[14.2px] leading-[19px] px-0.5">
              <WhatsAppText text={resolved} />
            </p>
          ) : (
            !hasContent && (
              <p className={cn("text-[14.2px] italic px-0.5", BUBBLE_MUTED)}>Sua mensagem aparece aqui…</p>
            )
          )}
          {footer && <p className={cn("text-xs px-0.5", BUBBLE_MUTED)}>{footer}</p>}
          <div className={cn("flex items-center justify-end gap-1 -mt-0.5", BUBBLE_MUTED)}>
            <span className="text-[11px] tabular-nums">{clock}</span>
            <CheckCheck size={15} className={TICK_CLASS} />
          </div>
        </div>
        {buttons.length > 0 && (
          <div className="mt-0.5 flex flex-col gap-0.5">
            {buttons.map((b, i) => (
              <div
                key={`${b.text}-${i}`}
                className={cn(
                  "rounded-lg py-2 px-3 text-sm font-medium flex items-center justify-center gap-1.5",
                  BUTTON_CLASS
                )}
              >
                <ButtonIcon type={b.type} />
                <span className="truncate">{b.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const meta = showMeta && (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
      <span className="tabular-nums">{resolved.length} caracteres</span>
      {hasLink && (
        <span className="inline-flex items-center gap-1 text-semantic-warning">
          <Link2 size={12} /> contém link
        </span>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className={className}>
        <div
          role="img"
          aria-label="Prévia da mensagem no WhatsApp"
          className={cn("rounded-xl p-3", WALLPAPER_CLASS)}
        >
          {bubble}
        </div>
        {meta}
      </div>
    );
  }

  return (
    <div className={cn("w-full max-w-[360px]", className)}>
      <div
        role="img"
        aria-label="Prévia da mensagem no WhatsApp"
        className="rounded-[2rem] border-[6px] border-[#111] bg-[#111] shadow-elevated overflow-hidden max-w-full"
      >
        <div className={cn("flex flex-col h-[560px] max-h-[70vh]", WALLPAPER_CLASS)}>
          {/* barra de status */}
          <div className={cn("flex items-center justify-between px-4 pt-2 pb-1 text-[11px]", HEADER_CLASS)}>
            <span className="tabular-nums font-medium">{clock}</span>
            <span className="flex items-center gap-1 opacity-90">
              <Signal size={11} />
              <Wifi size={11} />
              <BatteryFull size={12} />
            </span>
          </div>
          {/* header do chat */}
          <div className={cn("flex items-center gap-2.5 px-2.5 py-2", HEADER_CLASS)}>
            <ArrowLeft size={18} className="shrink-0 opacity-90" />
            <div className="h-9 w-9 rounded-full bg-white/20 overflow-hidden flex items-center justify-center text-xs font-semibold shrink-0">
              {businessAvatarUrl ? (
                <img src={businessAvatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                initials(businessName) || "?"
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate leading-tight">{businessName}</p>
              <p className="text-[11px] opacity-80 leading-tight">online</p>
            </div>
            <Video size={18} className="shrink-0 opacity-90" />
            <Phone size={17} className="shrink-0 opacity-90" />
            <MoreVertical size={18} className="shrink-0 opacity-90" />
          </div>
          {/* área de mensagens */}
          <div
            className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
            style={{
              backgroundImage:
                "radial-gradient(currentColor 0.6px, transparent 0.6px), radial-gradient(currentColor 0.6px, transparent 0.6px)",
              backgroundSize: "18px 18px",
              backgroundPosition: "0 0, 9px 9px",
              color: "rgba(128,128,128,0.12)",
            }}
          >
            <div className="flex justify-center">
              <span className={cn("rounded-md px-2 py-0.5 text-[11px] shadow-sm", DATE_CHIP_CLASS)}>
                Hoje
              </span>
            </div>
            <div className="text-[#e9edef] [.light_&]:text-[#111b21]">{bubble}</div>
          </div>
          {/* barra do compositor (decorativa) */}
          <div className={cn("flex items-center gap-2 px-2.5 py-2", "bg-[#1f2c34] [.light_&]:bg-[#f0f2f5]")}>
            <div className="flex-1 h-9 rounded-full bg-[#2a3942] [.light_&]:bg-white px-3 flex items-center text-xs text-[#8696a0]">
              Mensagem
            </div>
            <div className="h-9 w-9 rounded-full bg-[#00a884] flex items-center justify-center text-white">
              <span className="text-[10px] font-bold">●</span>
            </div>
          </div>
        </div>
      </div>
      {meta}
    </div>
  );
}
