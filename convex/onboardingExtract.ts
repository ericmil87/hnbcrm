"use node";
/**
 * Leitura de material do onboarding conversacional (P2.2): URL (via
 * `safeFetch`) ou arquivo enviado (`storageId`) → texto limpo.
 *
 * NÃO chama LLM e NÃO grava nada: devolve o texto (DADO não confiável, para o
 * leitor em quarentena do P2.3), título/descrição/links internos (HTML), a
 * origem e as contagens do que foi removido. Imagem e áudio seguem pelos
 * caminhos existentes (visão e Whisper).
 *
 * Limite de 5 páginas por site por sessão: quem chama mantém o contador por
 * `source.siteKey` e passa `pagesReadForSite`; com 5 ou mais a função recusa
 * (`SITE_PAGE_LIMIT`) sem rede.
 *
 * Log só com tipo, código, bytes e duração — nunca URL, nome nem conteúdo.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { safeFetch } from "./lib/safeFetchNode";
import { decodeBody, SafeFetchResult } from "./lib/safeFetch";
import {
  extractHtml,
  HtmlLink,
  HtmlRemovedCounts,
  MAX_PAGES_PER_SITE,
  siteKeyOf,
} from "./lib/htmlExtract";
import { extractPdfText, PDF_ERROR_MESSAGES, PDF_LIMITS, PdfExtractError } from "./lib/pdfExtract";
import { cleanUntrustedText, truncateText } from "./lib/untrustedText";

/** Bytes de HTML/texto considerados (o resto é cortado, `truncated:true`). */
export const HTML_MAX_BYTES = 2 * 1024 * 1024;
export const HTML_TIMEOUT_MS = 10_000;
export const PDF_FETCH_TIMEOUT_MS = 20_000;
export const EXTRACT_MAX_CHARS = 60_000;
export const EXTRACT_MIN_CHARS = 1_000;

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const TEXT_TYPES = ["text/plain"];
const PDF_TYPES = ["application/pdf"];

type ExtractKind = "html" | "pdf" | "text";

const removedValidator = v.object({
  scripts: v.number(),
  styles: v.number(),
  jsonLd: v.number(),
  comments: v.number(),
  embeds: v.number(),
  hiddenElements: v.number(),
  tinyText: v.number(),
  invisibleChars: v.number(),
  tagChars: v.number(),
});

export const fetchAndExtractReturns = v.union(
  v.object({
    ok: v.literal(true),
    text: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    links: v.optional(v.array(v.object({ url: v.string(), text: v.string() }))),
    /** PDF sem texto (só imagem): `text:""`; o chamador decide (ex.: pedir prints para a visão). */
    scanned: v.optional(v.boolean()),
    source: v.object({
      kind: v.union(v.literal("html"), v.literal("pdf"), v.literal("text")),
      url: v.optional(v.string()),
      finalUrl: v.optional(v.string()),
      siteKey: v.optional(v.string()),
      storageId: v.optional(v.id("_storage")),
      fetchedAt: v.number(),
      bytes: v.number(),
      truncated: v.boolean(),
      pages: v.optional(v.object({ total: v.number(), read: v.number() })),
    }),
    removed: removedValidator,
  }),
  v.object({
    ok: v.literal(false),
    code: v.string(),
    message: v.string(),
  })
);

type Removed = HtmlRemovedCounts;
type Ok = {
  ok: true;
  text: string;
  title?: string;
  description?: string;
  links?: HtmlLink[];
  scanned?: boolean;
  source: {
    kind: ExtractKind;
    url?: string;
    finalUrl?: string;
    siteKey?: string;
    storageId?: Id<"_storage">;
    fetchedAt: number;
    bytes: number;
    truncated: boolean;
    pages?: { total: number; read: number };
  };
  removed: Removed;
};
type Fail = { ok: false; code: string; message: string };

function zeroRemoved(): Removed {
  return {
    scripts: 0, styles: 0, jsonLd: 0, comments: 0, embeds: 0,
    hiddenElements: 0, tinyText: 0, invisibleChars: 0, tagChars: 0,
  };
}

function fail(code: string, message: string): Fail {
  return { ok: false, code, message };
}

function isPdfMagic(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

function decideKind(requested: "auto" | ExtractKind, mime: string, bytes: Uint8Array): ExtractKind | null {
  if (requested === "pdf") return isPdfMagic(bytes) ? "pdf" : null;
  if (requested !== "auto") return requested;
  // MIME HTML declarado vence (uma página que cita "%PDF-" no começo continua HTML).
  if (HTML_TYPES.includes(mime)) return "html";
  if (isPdfMagic(bytes) || mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  return null;
}

type ExtractInput = {
  bytes: Uint8Array;
  mime: string;
  charset: string | null;
  baseUrl?: string;
  bytesTruncated: boolean;
  maxChars: number;
};

/** Extração por tipo (sem rede). Exportada para teste direto. */
export async function extractByKind(
  kind: ExtractKind,
  input: ExtractInput
): Promise<
  | { ok: true; text: string; title?: string; description?: string; links?: HtmlLink[]; scanned?: boolean; truncated: boolean; pages?: { total: number; read: number }; removed: Removed }
  | Fail
> {
  if (kind === "pdf") {
    try {
      const r = await extractPdfText(input.bytes, { maxChars: input.maxChars });
      const removed = zeroRemoved();
      removed.invisibleChars = r.invisibleChars;
      removed.tagChars = r.tagChars;
      return {
        ok: true,
        text: r.text,
        scanned: r.scanned,
        truncated: r.truncated,
        pages: { total: r.numPages, read: r.pagesRead },
        removed,
      };
    } catch (e) {
      if (e instanceof PdfExtractError) return fail(e.code, e.message);
      return fail("PARSE_FAILED", PDF_ERROR_MESSAGES.PARSE_FAILED);
    }
  }
  const bytes = input.bytes.byteLength > HTML_MAX_BYTES ? input.bytes.subarray(0, HTML_MAX_BYTES) : input.bytes;
  const cut = input.bytesTruncated || bytes !== input.bytes;
  if (kind === "html") {
    const html = decodeBody(bytes, input.charset, true);
    const r = extractHtml(html, { baseUrl: input.baseUrl, maxChars: input.maxChars });
    return {
      ok: true,
      text: r.text,
      ...(r.title ? { title: r.title } : {}),
      ...(r.description ? { description: r.description } : {}),
      links: r.links,
      truncated: r.truncated || cut,
      removed: r.removed,
    };
  }
  const cleaned = cleanUntrustedText(decodeBody(bytes, input.charset));
  const { text, truncated } = truncateText(cleaned.text, input.maxChars);
  const removed = zeroRemoved();
  removed.invisibleChars = cleaned.stats.invisibleChars;
  removed.tagChars = cleaned.stats.tagChars;
  return { ok: true, text, truncated: truncated || cut, removed };
}

function fetchOptionsFor(kind: "auto" | ExtractKind) {
  switch (kind) {
    case "html":
      return { contentTypes: HTML_TYPES, maxBytes: HTML_MAX_BYTES, timeoutMs: HTML_TIMEOUT_MS, onOverflow: "truncate" as const };
    case "text":
      return { contentTypes: TEXT_TYPES, maxBytes: HTML_MAX_BYTES, timeoutMs: HTML_TIMEOUT_MS, onOverflow: "truncate" as const };
    case "pdf":
      // octet-stream só passa se os bytes começarem com %PDF- (decideKind)
      return {
        contentTypes: [...PDF_TYPES, "application/octet-stream"],
        maxBytes: PDF_LIMITS.maxBytes,
        timeoutMs: PDF_FETCH_TIMEOUT_MS,
        onOverflow: "abort" as const,
      };
    default:
      return {
        contentTypes: [...HTML_TYPES, ...TEXT_TYPES, ...PDF_TYPES],
        maxBytes: PDF_LIMITS.maxBytes,
        timeoutMs: PDF_FETCH_TIMEOUT_MS,
        onOverflow: "abort" as const,
      };
  }
}

export const internalFetchAndExtract = internalAction({
  args: {
    organizationId: v.id("organizations"),
    kind: v.union(v.literal("auto"), v.literal("html"), v.literal("pdf"), v.literal("text")),
    url: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    /** Páginas JÁ lidas deste site nesta sessão (contador do chamador por `source.siteKey`). */
    pagesReadForSite: v.optional(v.number()),
    /** Teto de caracteres do texto (1.000–60.000; padrão 60.000). */
    maxChars: v.optional(v.number()),
  },
  returns: fetchAndExtractReturns,
  handler: async (ctx, args): Promise<Ok | Fail> => {
    const started = Date.now();
    const maxChars = Math.min(
      EXTRACT_MAX_CHARS,
      Math.max(EXTRACT_MIN_CHARS, Number.isFinite(args.maxChars) ? Math.floor(args.maxChars!) : EXTRACT_MAX_CHARS)
    );
    const log = (kind: string, code: string, bytes: number) =>
      console.log(JSON.stringify({ event: "onboardingExtract", kind, code, bytes, ms: Date.now() - started }));

    if ((args.url === undefined) === (args.storageId === undefined)) {
      return fail("BAD_ARGS", "Informe um endereço ou um arquivo.");
    }

    // ---- URL ----
    if (args.url !== undefined) {
      const siteKey = siteKeyOf(args.url);
      if (!siteKey) return fail("INVALID_URL", "Endereço inválido.");
      const used = args.pagesReadForSite ?? 0;
      if (!Number.isFinite(used) || used < 0) return fail("BAD_ARGS", "Contador de páginas inválido.");
      if (used >= MAX_PAGES_PER_SITE) {
        return fail("SITE_PAGE_LIMIT", `Já li ${MAX_PAGES_PER_SITE} páginas deste site.`);
      }
      const res: SafeFetchResult = await safeFetch(args.url, fetchOptionsFor(args.kind));
      if (!res.ok) {
        log(args.kind, res.code, 0);
        return fail(res.code, res.message);
      }
      const kind = decideKind(args.kind, res.mime, res.bytes);
      if (!kind) {
        log(args.kind, "CONTENT_TYPE", res.bytes.byteLength);
        return fail("CONTENT_TYPE", "Tipo de conteúdo não aceito.");
      }
      const r = await extractByKind(kind, {
        bytes: res.bytes,
        mime: res.mime,
        charset: res.charset,
        baseUrl: res.finalUrl,
        bytesTruncated: res.truncated,
        maxChars,
      });
      log(kind, r.ok ? "OK" : r.code, res.bytes.byteLength);
      if (!r.ok) return r;
      const { ok: _ok, truncated, pages, removed, ...rest } = r;
      return {
        ok: true,
        ...rest,
        source: {
          kind,
          url: args.url,
          finalUrl: res.finalUrl,
          siteKey,
          fetchedAt: Date.now(),
          bytes: res.bytes.byteLength,
          truncated,
          ...(pages ? { pages } : {}),
        },
        removed,
      };
    }

    // ---- Arquivo enviado ----
    const storageId = args.storageId!;
    const info = await ctx.runQuery(internal.onboardingSources.internalGetOwnedBlobInfo, {
      organizationId: args.organizationId,
      storageId,
    });
    if (!info) return fail("NOT_FOUND", "Arquivo não encontrado.");
    if (info.size > PDF_LIMITS.maxBytes) {
      log(args.kind, "TOO_LARGE", info.size);
      return fail("TOO_LARGE", PDF_ERROR_MESSAGES.TOO_LARGE);
    }
    const blob = await ctx.storage.get(storageId);
    if (!blob) return fail("NOT_FOUND", "Arquivo não encontrado.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = (info.contentType ?? blob.type ?? "").split(";")[0].trim().toLowerCase();
    const kind = decideKind(args.kind, mime, bytes);
    if (!kind) {
      log(args.kind, "CONTENT_TYPE", bytes.byteLength);
      return fail("CONTENT_TYPE", "Tipo de arquivo não aceito.");
    }
    const r = await extractByKind(kind, {
      bytes,
      mime,
      charset: null,
      bytesTruncated: false,
      maxChars,
    });
    log(kind, r.ok ? "OK" : r.code, bytes.byteLength);
    if (!r.ok) return r;
    const { ok: _ok, truncated, pages, removed, links: _links, ...rest } = r;
    return {
      ok: true,
      ...rest,
      source: {
        kind,
        storageId,
        fetchedAt: Date.now(),
        bytes: bytes.byteLength,
        truncated,
        ...(pages ? { pages } : {}),
      },
      removed,
    };
  },
});
