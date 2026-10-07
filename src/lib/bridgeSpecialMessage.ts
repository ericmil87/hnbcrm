// Mensagens do bridge (WhatsApp Web) de tipos que não são texto nem mídia
// comum: enquete, localização, contato, evento, álbum… O backend grava um
// placeholder em `content` e os dados estruturados em `metadata.bridgeExtra`.
// Este módulo é PURO: só descreve o que mostrar; quem desenha é o card.
import { formatPhoneForDisplay } from "../../convex/lib/phone";

export type SpecialKind =
  | "album"
  | "poll"
  | "location"
  | "live_location"
  | "contact"
  | "event"
  | "group_invite"
  | "call_log"
  | "interactive_reply"
  | "unknown"
  | "revoked";

export type SpecialIcon =
  | "images"
  | "chart"
  | "map-pin"
  | "user"
  | "calendar"
  | "link"
  | "phone"
  | "video"
  | "mouse-pointer"
  | "help"
  | "ban";

export interface SpecialAction {
  label: string;
  href: string;
}

export interface SpecialMessageInfo {
  kind: SpecialKind;
  title: string;
  /** Linhas de apoio (texto puro, nunca HTML). */
  lines: string[];
  icon: SpecialIcon;
  /** Texto curto para a prévia na lista de conversas, busca, citação… */
  previewLabel: string;
  /** Opções de enquete (não interativas). */
  options?: string[];
  /** Telefones de contato compartilhado: valor cru e formatado. */
  phones?: { raw: string; display: string }[];
  /** Ação externa (mapa, participar do evento). */
  actions?: SpecialAction[];
  /** Nota pequena e discreta no fim do card. */
  note?: string;
}

type Meta = Record<string, any> | null | undefined;

const UNKNOWN_PLACEHOLDER = "[mensagem não suportada]";

function str(v: unknown, max = 500): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function safeHttpUrl(v: unknown): string | undefined {
  const s = str(v, 2048);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatEventDate(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

function stringList(v: unknown, maxItems: number, maxLen = 200): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => str(x, maxLen))
    .filter((x): x is string => Boolean(x))
    .slice(0, maxItems);
}

export function isRevoked(metadata: Meta): boolean {
  return metadata?.revoked === true;
}

export function isEdited(metadata: Meta): boolean {
  return metadata?.edited === true;
}

export function isViewOnce(metadata: Meta): boolean {
  return metadata?.viewOnce === true;
}

export function describeSpecialMessage(metadata: Meta, content?: string | null): SpecialMessageInfo | null {
  if (!metadata) return null;

  if (isRevoked(metadata)) {
    return {
      kind: "revoked",
      title: "Mensagem apagada",
      lines: [],
      icon: "ban",
      previewLabel: "Mensagem apagada",
    };
  }

  const type = metadata.bridgeType;
  const extra: Record<string, any> =
    metadata.bridgeExtra && typeof metadata.bridgeExtra === "object" ? metadata.bridgeExtra : {};

  switch (type) {
    case "album": {
      const images = Math.max(0, num(extra.imageCount) ?? 0);
      const videos = Math.max(0, num(extra.videoCount) ?? 0);
      const parts: string[] = [];
      if (images > 0) parts.push(plural(images, "foto", "fotos"));
      if (videos > 0) parts.push(plural(videos, "vídeo", "vídeos"));
      const what = parts.length ? parts.join(" e ") : "";
      return {
        kind: "album",
        title: what ? `Álbum com ${what}` : "Álbum",
        lines: [],
        icon: "images",
        previewLabel: what ? `Álbum com ${what}` : "Álbum",
        note: "As fotos chegam como mensagens separadas.",
      };
    }
    case "poll": {
      const question = str(extra.question) ?? str(content?.replace(/^\[enquete:\s*/i, "").replace(/\]$/, "")) ?? "Enquete";
      const options = stringList(extra.options, 20);
      const sel = num(extra.selectableCount);
      return {
        kind: "poll",
        title: question,
        lines: sel && sel > 1 ? [`Escolha até ${sel} opções`] : [],
        icon: "chart",
        previewLabel: `Enquete: ${question}`,
        options,
        note: "Enquete",
      };
    }
    case "location":
    case "live_location": {
      const lat = num(extra.latitude);
      const lng = num(extra.longitude);
      const live = type === "live_location";
      const name = str(extra.name);
      const address = str(extra.address);
      const lines = [name, address].filter((x): x is string => Boolean(x));
      const href =
        safeHttpUrl(extra.url) ??
        (lat !== undefined && lng !== undefined ? `https://www.google.com/maps?q=${lat},${lng}` : undefined);
      return {
        kind: type,
        title: live ? "Localização em tempo real" : "Localização",
        lines,
        icon: "map-pin",
        previewLabel: live ? "Localização em tempo real" : "Localização",
        actions: href ? [{ label: "Abrir no mapa", href }] : undefined,
      };
    }
    case "contact": {
      const names = stringList(extra.names, 10, 120);
      const phones = stringList(extra.phones, 10, 30)
        .map((p) => p.replace(/\D/g, ""))
        .filter((p) => p.length >= 6)
        .map((raw) => ({ raw, display: formatPhoneForDisplay(raw) }));
      return {
        kind: "contact",
        title: names.length ? names.join(", ") : "Contato compartilhado",
        lines: [],
        icon: "user",
        previewLabel: names.length ? `Contato: ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : "Contato",
        phones,
      };
    }
    case "event": {
      const name = str(extra.name) ?? "Evento";
      const start = num(extra.startAt);
      const lines = [
        start !== undefined ? formatEventDate(start) : undefined,
        str(extra.location),
        str(extra.description, 300),
      ].filter((x): x is string => Boolean(x));
      const join = safeHttpUrl(extra.joinLink);
      return {
        kind: "event",
        title: name,
        lines,
        icon: "calendar",
        previewLabel: `Evento: ${name}`,
        actions: join ? [{ label: "Participar", href: join }] : undefined,
      };
    }
    case "group_invite": {
      const group = str(extra.groupName);
      return {
        kind: "group_invite",
        title: group ? `Convite para o grupo ${group}` : "Convite para grupo",
        lines: [],
        icon: "link",
        previewLabel: "Convite para grupo",
      };
    }
    case "call_log": {
      const video = extra.isVideo === true;
      const outcome = str(extra.outcome, 60);
      return {
        kind: "call_log",
        title: video ? "Chamada de vídeo" : "Chamada de voz",
        lines: outcome ? [outcome] : [],
        icon: video ? "video" : "phone",
        previewLabel: video ? "Chamada de vídeo" : "Chamada de voz",
      };
    }
    case "interactive_reply":
      return {
        kind: "interactive_reply",
        title: str(extra.selected) ?? str(content) ?? "",
        lines: [],
        icon: "mouse-pointer",
        previewLabel: str(extra.selected) ?? str(content) ?? "Resposta de botão",
        note: "resposta de botão",
      };
    case "unknown": {
      const t = str(extra.type, 60);
      return {
        kind: "unknown",
        title: "Tipo de mensagem que o CRM ainda não exibe",
        lines: [],
        icon: "help",
        previewLabel: "Mensagem de tipo não suportado",
        note: t,
      };
    }
    default:
      return null;
  }
}

/**
 * Prévia da lista de conversas. O servidor manda só o texto e o `bridgeType`
 * da última mensagem; os dados estruturados não descem, então o rótulo vem do
 * tipo (e do próprio placeholder, que já é PT-BR).
 */
export function conversationPreviewText(
  preview: string,
  bridgeType: string | null | undefined,
  revoked?: boolean
): string {
  if (revoked) return "Mensagem apagada";
  if (bridgeType === "unknown" || preview.trim() === UNKNOWN_PLACEHOLDER) return "Mensagem de tipo não suportado";
  switch (bridgeType) {
    case "album":
      return preview.replace(/^\[(.*)\]$/, "$1").replace(/^álbum/i, "Álbum");
    case "poll":
      return preview.replace(/^\[enquete:\s*/i, "Enquete: ").replace(/\]$/, "");
    case "location":
      return "Localização";
    case "live_location":
      return "Localização em tempo real";
    case "group_invite":
      return "Convite para grupo";
    default:
      return preview;
  }
}

/** Nome do ícone para a prévia (reusa os mesmos do card). */
export function previewIconFor(bridgeType: string | null | undefined): SpecialIcon | null {
  switch (bridgeType) {
    case "album":
      return "images";
    case "poll":
      return "chart";
    case "location":
    case "live_location":
      return "map-pin";
    case "contact":
      return "user";
    case "event":
      return "calendar";
    case "group_invite":
      return "link";
    case "call_log":
      return "phone";
    case "interactive_reply":
      return "mouse-pointer";
    case "unknown":
      return "help";
    default:
      return null;
  }
}
