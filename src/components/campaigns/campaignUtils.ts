import type {
  CampaignPacing,
  CampaignSchedule,
  CampaignStatus,
  RecipientStatus,
  WhatsappTemplateItem,
} from "./types";
import type { WhatsAppPreviewButton, WhatsAppPreviewHeader } from "./WhatsAppPreview";

// ── Rótulos e cores ──

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  running: "Em andamento",
  paused: "Pausada",
  completed: "Concluída",
  canceled: "Cancelada",
  failed: "Falhou",
};

export type BadgeVariant = "default" | "brand" | "success" | "error" | "warning" | "info";

export const CAMPAIGN_STATUS_VARIANT: Record<CampaignStatus, BadgeVariant> = {
  draft: "default",
  scheduled: "info",
  running: "brand",
  paused: "warning",
  completed: "success",
  canceled: "default",
  failed: "error",
};

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  pending: "Na fila",
  queued: "Enviando",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  replied: "Respondeu",
  failed: "Falhou",
  skipped: "Pulado",
  opted_out: "Opt-out",
};

export const RECIPIENT_STATUS_VARIANT: Record<RecipientStatus, BadgeVariant> = {
  pending: "default",
  queued: "info",
  sent: "brand",
  delivered: "success",
  read: "success",
  replied: "success",
  failed: "error",
  skipped: "warning",
  opted_out: "warning",
};

export const RECIPIENT_STATUS_ORDER: RecipientStatus[] = [
  "pending",
  "queued",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "opted_out",
];

export const PROVIDER_LABELS = { meta: "Cloud API (Meta)", bridge: "Bridge (não oficial)" } as const;

export const SKIP_REASON_LABELS: Record<string, string> = {
  not_on_whatsapp: "Número sem WhatsApp",
  canceled: "Campanha cancelada",
  no_phone: "Sem telefone",
  invalid_phone: "Telefone inválido",
  suppressed: "Na lista de supressão",
  outro: "Outro",
};

export const ERROR_CODE_LABELS: Record<string, string> = {
  "131026": "Número sem WhatsApp (131026)",
  "131047": "Fora da janela de 24h — exige template (131047)",
  "131048": "Número restringido por spam (131048)",
  "131049": "Limite por usuário da Meta (131049)",
  "131050": "Pediu para não receber marketing (131050)",
  "130403": "Empresa bloqueou o usuário (130403)",
  "130429": "Limite de vazão (130429)",
  "131056": "Limite por destinatário (131056)",
  "132015": "Template pausado pela Meta (132015)",
  "80007": "Limite da conta WhatsApp (80007)",
};

export const TIMELINE_LABELS: Record<string, string> = {
  created: "Rascunho criado",
  launched: "Campanha lançada",
  snapshot: "Público calculado",
  started: "Envio iniciado",
  paused: "Pausada",
  resumed: "Retomada",
  completed: "Concluída",
  canceled: "Cancelada",
  retry: "Falhas reenviadas",
  imported: "Destinatários importados",
  frozen: "Canal congelado",
};

export const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

// ── Formatação ──

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("pt-BR");
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "grátis";
  return `US$ ${value.toFixed(2)}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function formatPhone(phone: string): string {
  // 5511999991234 → +55 11 99999-1234
  if (phone.startsWith("55") && (phone.length === 12 || phone.length === 13)) {
    const ddd = phone.slice(2, 4);
    const rest = phone.slice(4);
    const split = rest.length === 9 ? 5 : 4;
    return `+55 ${ddd} ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return `+${phone}`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "imediato";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}min` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} dia${days > 1 ? "s" : ""} ${restHours}h` : `${days} dia${days > 1 ? "s" : ""}`;
}

/**
 * Estimativa de duração do envio: N × delay médio + pausas de lote + tetos por
 * hora/dia (aproximação — a janela de envio pode esticar mais).
 */
export function estimateCampaignDurationMs(recipients: number, pacing: CampaignPacing, schedule: CampaignSchedule): number {
  if (recipients <= 0) return 0;
  const avgDelayMs = ((pacing.minDelaySec + pacing.maxDelaySec) / 2) * 1000;
  let ms = recipients * avgDelayMs;
  if (pacing.batchSize > 0) {
    const pauses = Math.floor((recipients - 1) / pacing.batchSize);
    ms += pauses * pacing.batchPauseMin * 60_000;
  }
  const perHourMs = (recipients / Math.max(1, pacing.maxPerHour)) * 3_600_000;
  ms = Math.max(ms, perHourMs);
  const windowHours = Math.max(1, schedule.windowEndHour - schedule.windowStartHour);
  const perDay = Math.min(pacing.maxPerDay, pacing.maxPerHour * windowHours);
  const days = Math.ceil(recipients / Math.max(1, perDay));
  if (days > 1) ms = Math.max(ms, (days - 1) * 86_400_000 + Math.min(ms, windowHours * 3_600_000));
  return ms;
}

export function scheduleSummary(schedule: CampaignSchedule): string {
  const days = schedule.days.length === 7 ? "todos os dias" : schedule.days.map((d) => WEEKDAY_LABELS[d]).join(", ");
  return `${String(schedule.windowStartHour).padStart(2, "0")}h–${String(schedule.windowEndHour).padStart(2, "0")}h · ${days}`;
}

export function pacingSummary(p: CampaignPacing): string {
  const parts = [`${p.minDelaySec}–${p.maxDelaySec}s entre envios`, `${p.maxPerHour}/h`, `${p.maxPerDay}/dia`];
  if (p.batchSize > 0) parts.push(`pausa de ${p.batchPauseMin} min a cada ${p.batchSize}`);
  if (p.maxNewContactsPerDay !== undefined) parts.push(`${p.maxNewContactsPerDay} novos/dia`);
  return parts.join(" · ");
}

// ── Template → preview ──

export function templateHeaderForPreview(
  template: WhatsappTemplateItem | null,
  headerUrl: string | null,
  headerFilename?: string
): WhatsAppPreviewHeader | undefined {
  if (!template) return undefined;
  const components = Array.isArray(template.components) ? (template.components as Array<Record<string, unknown>>) : [];
  const header = components.find((c) => c?.type === "HEADER");
  if (!header) return undefined;
  const format = String(header.format ?? "TEXT").toUpperCase();
  if (format === "TEXT") return { format: "TEXT", text: String(header.text ?? "") };
  if (format === "IMAGE" || format === "VIDEO" || format === "DOCUMENT") {
    return { format, url: headerUrl, filename: headerFilename };
  }
  return undefined;
}

export function templateFooterForPreview(template: WhatsappTemplateItem | null): string | undefined {
  if (!template) return undefined;
  const components = Array.isArray(template.components) ? (template.components as Array<Record<string, unknown>>) : [];
  const footer = components.find((c) => c?.type === "FOOTER");
  return footer?.text ? String(footer.text) : undefined;
}

export function templateButtonsForPreview(template: WhatsappTemplateItem | null): WhatsAppPreviewButton[] | undefined {
  if (!template || template.buttons.length === 0) return undefined;
  return template.buttons.map((b) => ({
    type: (b.type === "URL" || b.type === "PHONE_NUMBER" ? b.type : "QUICK_REPLY") as WhatsAppPreviewButton["type"],
    text: b.text,
  }));
}

/** Substitui {{1}}…{{n}} do body pelo valor resolvido (para o preview). */
export function resolveTemplateBody(
  bodyText: string,
  params: { source: "field" | "const"; value: string }[] | undefined,
  vars: Record<string, string>
): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => {
    const param = params?.[Number(n) - 1];
    if (!param) return `{{${n}}}`;
    if (param.source === "const") return param.value;
    const key = param.value.toLowerCase();
    return vars[key] ?? vars[param.value] ?? `{{${param.value}}}`;
  });
}

// ── CSV ──

export function toCsv(rows: Record<string, string | number | null | undefined>[], columns: string[]): string {
  const escape = (value: string | number | null | undefined) => {
    const s = value === null || value === undefined ? "" : String(value);
    const safe = /^[=+@-]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
    return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.join(";")];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(";"));
  return "﻿" + lines.join("\r\n");
}

export function downloadTextFile(name: string, content: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** XLSX → CSV (1ª planilha) no navegador; SheetJS entra por import() dinâmico. */
export async function xlsxFileToCsv(file: File): Promise<string> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("Planilha vazia");
  return XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheet], { FS: ",", RS: "\n", blankrows: false });
}

export function contentTypeForMime(mime: string): "text" | "image" | "file" | "audio" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
