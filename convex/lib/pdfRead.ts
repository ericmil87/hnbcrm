/**
 * Leitura de PDF recebido pelo atendente (puro, sem Node): constantes, estado
 * gravado em `messages.metadata.docRead` e o texto de histórico.
 *
 * O TEXTO extraído mora em `messages.imageDescription` (mesmo espelho
 * pesquisável da visão: `searchNorm` via `withMessageSearchPatch`, sem índice
 * novo em `messages`); o estado, em `metadata.docRead`. A extração em si é só
 * `extractPdfText` (porta única de texto de PDF) na action `pdfRead.ts`.
 */

/** Teto do arquivo lido pelo atendente (bem abaixo dos 20 MB do onboarding). */
export const PDF_READ_MAX_BYTES = 5 * 1024 * 1024;
/** Teto do texto que entra no prompt (≈ 1,5–2 mil tokens). */
export const PDF_READ_MAX_CHARS = 6000;
/** Texto de PDF que a EQUIPE enviou: só contexto, menor. */
export const PDF_READ_OUTBOUND_HISTORY_CHARS = 2000;
/** Claim em voo não é refeito antes disto (mesmo molde da visão). */
export const PDF_READ_PENDING_RETRY_AFTER_MS = 2 * 60 * 1000;
/**
 * `pending` há mais que isto (desde `at`, que o claim preserva) = a action morreu (OOM/timeout):
 * quem encontrar o estado grava `failed`/`STALE` (sem cron). Texto nunca chega depois disso.
 */
export const PDF_READ_STALE_AFTER_MS = 10 * 60 * 1000;
export const PDF_READ_STALE_CODE = "STALE";

/** Leitura `pending` órfã? (pura; `now` do chamador) */
export function isDocReadStale(doc: { status: string; at: number } | undefined, now: number): boolean {
  return doc?.status === "pending" && now - doc.at > PDF_READ_STALE_AFTER_MS;
}

export type DocReadStatus = "pending" | "done" | "scanned" | "failed" | "skipped";

export type DocReadMeta = {
  status: DocReadStatus;
  at: number;
  /** Marcado pelo claim da action (o porto de agendamento grava `pending` sem ele). */
  claimedAt?: number;
  kind?: "pdf";
  fileName?: string;
  chars?: number;
  truncated?: boolean;
  pages?: number;
  pagesRead?: number;
  /** PDF escaneado cuja imagem embutida foi lida pelo passe de visão. */
  viaVision?: boolean;
  /** Código (PdfErrorCode/TOO_LARGE/…), nunca texto do arquivo. */
  error?: string;
};

export function docReadOf(metadata: Record<string, unknown> | undefined): DocReadMeta | undefined {
  const d = metadata?.docRead;
  if (!d || typeof d !== "object") return undefined;
  const status = (d as { status?: unknown }).status;
  return typeof status === "string" ? (d as DocReadMeta) : undefined;
}

/** Candidato a PDF pelo mime/nome (os bytes `%PDF-` são conferidos na action). */
export function isPdfCandidate(mime: string | undefined, name: string | undefined): boolean {
  const m = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (m === "application/pdf" || m === "application/x-pdf") return true;
  if (m === "" || m === "application/octet-stream") return /\.pdf$/i.test((name ?? "").trim());
  return false;
}

export function hasPdfMagic(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i + 5 <= n; i++) {
    if (
      bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d
    ) return true;
  }
  return false;
}

/** Nome do arquivo seguro para rótulo: sem aspas, quebras ou controles; ≤ 120. */
export function pdfLabelName(name: string | undefined): string {
  return (name ?? "").replace(/[\u0000-\u001F\u007F"\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

const FAILURE_REASON: Record<string, string> = {
  ENCRYPTED: "protegido por senha",
  TOO_LARGE: "grande demais",
  TOO_MANY_PAGES: "páginas demais",
  TOO_BIG_EXPANSION: "não deu para abrir com segurança",
};

function placeholder(label: string): boolean {
  return label === "" || (label.startsWith("[") && label.endsWith("]"));
}

/**
 * Texto de histórico de um arquivo COM leitura de PDF, ou `null` quando o
 * chamador deve seguir o marcador antigo ("não consigo abrir arquivos").
 * Texto de terceiro: o histórico inteiro já viaja no envelope não confiável.
 */
export function pdfHistoryText(
  m: {
    direction: "inbound" | "outbound" | "internal";
    content: string;
    imageDescription?: string;
    metadata?: Record<string, unknown>;
  },
  opts?: { visionEnabled?: boolean }
): string | null {
  const doc = docReadOf(m.metadata);
  if (!doc) return null;
  const name = pdfLabelName(doc.fileName);
  const quoted = name ? ` "${name}"` : "";
  const text = m.imageDescription?.trim() ?? "";
  const caption = m.content.trim();
  const hasCaption = !placeholder(caption) && caption !== (doc.fileName ?? "").trim();

  if (m.direction === "outbound") {
    if (doc.status !== "done" || !text) return null;
    const cut = text.length > PDF_READ_OUTBOUND_HISTORY_CHARS ? `${text.slice(0, PDF_READ_OUTBOUND_HISTORY_CHARS)} […]` : text;
    return `[arquivo PDF enviado${quoted} — texto extraído]: ${cut}`;
  }

  const withCaption = (base: string) => (hasCaption ? `${base} — legenda do cliente: "${caption}"` : base);

  if (doc.status === "done" && text) {
    return withCaption(`[arquivo PDF${quoted} — texto extraído${doc.truncated ? ", cortado no limite" : ""}]: ${text}`);
  }
  if (doc.status === "scanned") {
    if (doc.viaVision && text && opts?.visionEnabled) {
      return withCaption(`[arquivo PDF${quoted} — escaneado, lido como imagem]: ${text}`);
    }
    return withCaption(`[arquivo PDF${quoted} — veio como imagem escaneada e não consegui ler o conteúdo]`);
  }
  if (doc.status === "failed" && doc.error) {
    const why = FAILURE_REASON[doc.error];
    return withCaption(`[arquivo PDF${quoted} — não consegui ler${why ? ` (${why})` : ""}]`);
  }
  return null;
}
