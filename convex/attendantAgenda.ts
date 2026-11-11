/**
 * Agenda externa do atendente (v0.64) — o lado de RUNTIME.
 *
 * Duas coisas, ambas chamadas de dentro da action do atendente
 * (`internalProcessQueueItem`) e do simulador:
 *  1. `consultarAgenda`: GET no endpoint da org, com a chave decifrada SÓ aqui
 *     (mesmo padrão do BYO em lib/agentRoutes). O JSON passa pela whitelist de
 *     lib/externalAgenda antes de virar resultado de tool.
 *  2. O flyer do `replyToCustomer.imageUrl`: baixado UMA vez por URL (dedupe
 *     por `files.sourceUrl`), reaproveitado em cada envio com uma linha nova de
 *     `files` apontando para o mesmo blob (o vínculo `files.messageId` é 1:1,
 *     igual ao `forwardMessage`; lib/fileRefs protege o blob compartilhado).
 *
 * Nunca logar a chave nem a URL (pode ter query string com segredo).
 */
import { v } from "convex/values";
import { deleteFileRow, insertFileRow } from "./lib/storageUsage";
import { ActionCtx, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  AgendaEvent,
  availableCategories,
  filterByCategory,
  normalizeAgendaEvents,
} from "./lib/externalAgenda";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";

export type ExternalAgendaFetchConfig = {
  url: string;
  headerName: string;
  apiKeyRef: Id<"orgSecrets"> | null;
};

/**
 * Executa `consultarAgenda`. Nunca lança: erro de rede/HTTP/parse vira
 * `{status:"erro", erro:"agenda_indisponivel"}` para o modelo seguir o bloco
 * AGENDA EXTERNA do prompt (avisar que confirma e abrir repasse).
 */
export async function runConsultarAgenda(
  ctx: Pick<ActionCtx, "runAction">,
  organizationId: Id<"organizations">,
  config: ExternalAgendaFetchConfig | null | undefined,
  argsJson: string | undefined
): Promise<{ result: Record<string, unknown>; events: AgendaEvent[] }> {
  if (!config) {
    return { result: { status: "erro", erro: "agenda_nao_configurada" }, events: [] };
  }
  let categoria: string | undefined;
  try {
    const parsed = JSON.parse(argsJson || "{}");
    if (typeof parsed?.categoria === "string") categoria = parsed.categoria.slice(0, 100);
  } catch {
    // argumento malformado = consulta sem filtro
  }

  // Rede pelo safeFetch (P2.2): URL/DNS/IP validados e conexão no IP
  // validado; a chave é decifrada dentro da action Node.
  let json: unknown;
  try {
    const res = await ctx.runAction(internal.attendantAgendaFetch.internalFetchAgendaJson, {
      organizationId,
      url: config.url,
      headerName: config.headerName,
      apiKeyRef: config.apiKeyRef,
    });
    if (!res.ok) {
      if (res.code === "SECRET_UNAVAILABLE") console.warn("[agenda] chave da agenda externa indisponível");
      else if (res.code === "HTTP_STATUS") console.warn(`[agenda] endpoint respondeu HTTP ${res.status ?? "?"}`);
      else console.warn(`[agenda] falha ao consultar a agenda externa (${res.code})`);
      return { result: { status: "erro", erro: "agenda_indisponivel" }, events: [] };
    }
    json = JSON.parse(res.body);
  } catch (e) {
    const kind = e instanceof Error ? e.name : "erro";
    console.warn(`[agenda] falha ao consultar a agenda externa (${kind})`);
    return { result: { status: "erro", erro: "agenda_indisponivel" }, events: [] };
  }

  const all = normalizeAgendaEvents(json);
  const filtered = filterByCategory(all, categoria);
  // Filtro que não casou com NADA (a taxonomia do site é outra, ou o modelo
  // chutou um nome): devolve a agenda inteira e avisa — esconder eventos por
  // causa de um filtro errado é exatamente o "nunca invente" ao contrário.
  const filtroSemResultado = !!categoria && filtered.length === 0 && all.length > 0;
  const eventos = filtroSemResultado ? all : filtered;
  // `events` (o que a IA VIU) = o que foi devolvido: a imagem permitida no
  // reply é a de um evento que de fato chegou ao modelo.
  return {
    result: {
      status: "ok",
      total: eventos.length,
      eventos,
      categoriasDisponiveis: availableCategories(all),
      ...(filtroSemResultado ? { filtroSemResultado: categoria } : {}),
    },
    events: eventos,
  };
}

function fileNameFromUrl(url: string, mimeType: string): string {
  let base = "flyer";
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) base = decodeURIComponent(last).slice(0, 120);
  } catch {
    // mantém o padrão
  }
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const ext = mimeType.split("/")[1]?.split(";")[0] ?? "jpg";
  return `${base}.${ext === "jpeg" ? "jpg" : ext}`;
}

/**
 * Garante uma linha de `files` (sem `messageId` ainda) com o flyer da URL.
 * Reaproveita o blob de um envio anterior da mesma org+URL; senão baixa
 * pelo `safeFetch` (só https público, 10 s, ≤ 5 MB, `image/*`). Devolve null em qualquer falha — o turno segue
 * só com texto, nunca falha por causa da imagem.
 */
export async function prepareAgendaImageFile(
  ctx: Pick<ActionCtx, "runMutation" | "runAction">,
  args: {
    organizationId: Id<"organizations">;
    agentMemberId: Id<"teamMembers">;
    url: string;
  }
): Promise<Id<"files"> | null> {
  const reused = await ctx.runMutation(internal.attendantAgenda.internalReuseAgendaImageFile, args);
  if (reused) return reused;

  try {
    // safeFetch (P2.2): só https público, `image/*`, ≤ 5 MB, 10 s.
    const res = await ctx.runAction(internal.attendantAgendaFetch.internalDownloadAgendaImage, {
      url: args.url,
    });
    if (!res.ok) {
      if (res.code === "HTTP_STATUS") console.warn(`[agenda] download do flyer respondeu HTTP ${res.status ?? "?"}`);
      else console.warn(`[agenda] flyer recusado (${res.code})`);
      return null;
    }
    const { storageId, mimeType, size } = res;
    return await ctx.runMutation(internal.attendantAgenda.internalInsertAgendaImageFile, {
      organizationId: args.organizationId,
      agentMemberId: args.agentMemberId,
      url: args.url,
      storageId,
      name: fileNameFromUrl(args.url, mimeType),
      mimeType,
      size,
    });
  } catch (e) {
    const kind = e instanceof Error ? e.name : "erro";
    console.warn(`[agenda] falha ao baixar o flyer (${kind})`);
    return null;
  }
}

/** Dedupe: nova linha de `files` sobre o blob de um envio anterior da mesma URL. */
export const internalReuseAgendaImageFile = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    url: v.string(),
  },
  returns: v.union(v.id("files"), v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_organization_and_source_url", (q) =>
        q.eq("organizationId", args.organizationId).eq("sourceUrl", args.url)
      )
      .order("desc")
      .take(5);
    for (const row of rows) {
      // O blob ainda existe? (a cascata de lead pode ter levado o último dono)
      const blob = await ctx.db.system.get(row.storageId as Id<"_storage">);
      if (!blob) continue;
      return await insertFileRow(ctx, {
        organizationId: args.organizationId,
        storageId: row.storageId,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        fileType: "message_attachment",
        uploadedBy: args.agentMemberId,
        sourceUrl: args.url,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

export const internalInsertAgendaImageFile = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    url: v.string(),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    return await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      fileType: "message_attachment",
      uploadedBy: args.agentMemberId,
      sourceUrl: args.url,
      createdAt: Date.now(),
    });
  },
});

/**
 * O commit não aconteceu (elegibilidade caiu, lock perdido…): a linha
 * preparada ficou sem mensagem. Apaga a linha e — só se ninguém mais o usa —
 * o blob.
 */
export const internalDiscardUnlinkedFiles = internalMutation({
  args: { fileIds: v.array(v.id("files")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const fileId of args.fileIds) {
      const file = await ctx.db.get(fileId);
      if (!file || file.messageId) continue;
      await deleteFileRow(ctx, file);
      await deleteBlobIfUnreferenced(ctx, file);
    }
    return null;
  },
});
