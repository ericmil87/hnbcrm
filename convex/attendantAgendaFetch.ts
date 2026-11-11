"use node";
/**
 * Rede da agenda externa (v0.64) pelo `safeFetch` (P2.2): o endpoint da org e
 * o flyer do evento são destinos escolhidos por terceiros, então passam pela
 * validação de URL + DNS + IP com conexão no IP validado (lib/safeFetchNode).
 *
 * Chamadas por `attendantAgenda.ts` (runtime padrão) via `ctx.runAction`: a
 * pinagem de IP exige `dns`/`https` do Node. A chave da agenda é decifrada
 * AQUI (nunca trafega como argumento) e só vai para a origem configurada —
 * um redirect para outro host perde o cabeçalho. Nunca logar URL nem chave.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/secretCrypto";
import { safeFetch } from "./lib/safeFetchNode";
import {
  AGENDA_FETCH_TIMEOUT_MS,
  AGENDA_IMAGE_MAX_BYTES,
  AGENDA_IMAGE_TIMEOUT_MS,
} from "./lib/externalAgenda";

/** Teto do JSON da agenda (antes não havia; 20 eventos cabem com folga). */
export const AGENDA_JSON_MAX_BYTES = 5 * 1024 * 1024;

type FetchFailure = { ok: false; code: string; status?: number };

const fetchFailure = v.object({
  ok: v.literal(false),
  code: v.string(),
  status: v.optional(v.number()),
});

export const internalFetchAgendaJson = internalAction({
  args: {
    organizationId: v.id("organizations"),
    url: v.string(),
    headerName: v.string(),
    apiKeyRef: v.union(v.id("orgSecrets"), v.null()),
  },
  returns: v.union(v.object({ ok: v.literal(true), body: v.string() }), fetchFailure),
  handler: async (ctx, args): Promise<{ ok: true; body: string } | FetchFailure> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (args.apiKeyRef) {
      try {
        const encrypted = await ctx.runQuery(internal.orgSecrets.internalGetOrgSecretEncrypted, {
          secretId: args.apiKeyRef,
          organizationId: args.organizationId,
        });
        if (encrypted) headers[args.headerName] = await decryptSecret(encrypted);
      } catch {
        return { ok: false as const, code: "SECRET_UNAVAILABLE" };
      }
    }
    const res = await safeFetch(args.url, {
      // O JSON passa pela whitelist de lib/externalAgenda: qualquer
      // content-type é aceito, como antes da migração.
      contentTypes: ["*/*"],
      accept: "application/json",
      maxBytes: AGENDA_JSON_MAX_BYTES,
      timeoutMs: AGENDA_FETCH_TIMEOUT_MS,
      headers,
    });
    if (!res.ok) {
      return { ok: false as const, code: res.code, ...(res.status !== undefined ? { status: res.status } : {}) };
    }
    return { ok: true as const, body: new TextDecoder("utf-8").decode(res.bytes) };
  },
});

/** Baixa o flyer (`image/*`, ≤ 5 MB, 10 s) e guarda o blob. Sem linha de `files`. */
export const internalDownloadAgendaImage = internalAction({
  args: { url: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      storageId: v.id("_storage"),
      mimeType: v.string(),
      size: v.number(),
    }),
    fetchFailure
  ),
  handler: async (
    ctx,
    args
  ): Promise<{ ok: true; storageId: Id<"_storage">; mimeType: string; size: number } | FetchFailure> => {
    const res = await safeFetch(args.url, {
      contentTypes: ["image/*"],
      maxBytes: AGENDA_IMAGE_MAX_BYTES,
      timeoutMs: AGENDA_IMAGE_TIMEOUT_MS,
    });
    if (!res.ok) {
      return { ok: false as const, code: res.code, ...(res.status !== undefined ? { status: res.status } : {}) };
    }
    if (res.bytes.byteLength === 0) return { ok: false as const, code: "EMPTY" };
    const storageId = await ctx.storage.store(new Blob([res.bytes], { type: res.mime }));
    return { ok: true as const, storageId, mimeType: res.mime, size: res.bytes.byteLength };
  },
});
