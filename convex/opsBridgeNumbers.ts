/**
 * Ops: conserta números de WhatsApp de contatos cujo envio pelo bridge falhou
 * com `no LID found` (o contato foi endereçado com a grafia errada do 9º dígito
 * BR). Só `npx convex run --prod …` depois de um dry run; NUNCA reenvia nada —
 * só corrige `whatsappNumber` ou marca "sem WhatsApp" (`contacts.whatsappCheck`).
 *
 * `internalRepairNoLidNumbers` (action, `dryRun` default TRUE; o dry run só LISTA
 * candidatos, sem consultar o gateway, salvo `lookup:true`): varre as
 * mensagens da ORG na janela por cursor, deduplica por contato DENTRO da página
 * (entre páginas quem limita é o orçamento por contato — `reserveWhatsappLookup`, 10 min
 * e 3 por dia; contato já marcado/verificado é pulado na varredura), pergunta ao
 * gateway (`checkBridgeNumber`, ~1 s entre contatos) e, fora do dry run, aplica.
 * Telefones saem mascarados. Uma auditoria por página aplicada (convenção das
 * ops: nada de activity/audit por linha).
 */
import { v, type Infer } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/secretCrypto";
import { checkBridgeNumber } from "./lib/bridgeNumberCheck";
import { resolveConversationChannelConfig } from "./lib/channelResolve";
import { configProvider } from "./channelConfigs";
import { buildSearchText } from "./lib/searchText";
import {
  canonicalContactPatch,
  contactOfConversation,
  currentSendDigits,
  digitsOf,
  isSpellingOfSameNumber,
  maskPhone,
  reserveWhatsappLookup,
  setWhatsappCheck,
} from "./lib/whatsappCheck";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 120 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const LOOKUP_GAP_MS = 1000;

const candidateValidator = v.object({
  contactId: v.id("contacts"),
  phone: v.string(),
  messageCount: v.number(),
  baseUrl: v.string(),
  tokenEncrypted: v.string(),
});

const scanReturnsValidator = v.object({
  candidates: v.array(candidateValidator),
  scanned: v.number(),
  nextCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
});
type ScanPage = Infer<typeof scanReturnsValidator>;

/** Uma página da varredura: contatos distintos com falha `no LID found` (query pura). */
export const internalScanNoLid = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    from: v.number(),
    cursor: v.union(v.string(), v.null()),
    pageSize: v.number(),
  },
  returns: scanReturnsValidator,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId).gte("_creationTime", args.from))
      .order("desc")
      .paginate({ cursor: args.cursor, numItems: args.pageSize });

    const byContact = new Map<Id<"contacts">, { phone: string; count: number; baseUrl: string; tokenEncrypted: string }>();
    for (const m of page.page) {
      if (m.direction !== "outbound" || m.isInternal || m.deliveryStatus !== "failed") continue;
      const error = String(m.metadata?.deliveryError ?? "");
      if (m.metadata?.deliveryErrorKind !== "recipient_not_found" && !error.toLowerCase().includes("no lid found")) continue;
      const conversation = await ctx.db.get(m.conversationId);
      if (!conversation || conversation.organizationId !== args.organizationId || conversation.channel !== "whatsapp") continue;
      const config = await resolveConversationChannelConfig(ctx, conversation);
      if (!config || configProvider(config) !== "bridge" || !config.bridgeBaseUrl || !config.bridgeTokenEncrypted) continue;
      const contact = await contactOfConversation(ctx, conversation);
      if (!contact) continue;
      const phone = currentSendDigits(contact);
      if (!/^\d{8,15}$/.test(phone)) continue;
      // Já conferido (marcado ou verificado) para o número ATUAL: não consulta de novo.
      if (contact.whatsappCheck?.phone === phone) continue;
      const seen = byContact.get(contact._id);
      if (seen) seen.count += 1;
      else byContact.set(contact._id, { phone, count: 1, baseUrl: config.bridgeBaseUrl, tokenEncrypted: config.bridgeTokenEncrypted });
    }
    return {
      candidates: [...byContact.entries()].map(([contactId, c]) => ({
        contactId,
        phone: c.phone,
        messageCount: c.count,
        baseUrl: c.baseUrl,
        tokenEncrypted: c.tokenEncrypted,
      })),
      scanned: page.page.length,
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Reserva UMA consulta no orçamento do contato (a mesma porta do self-heal e do retry). */
export const internalReserveContactLookup = internalMutation({
  args: { organizationId: v.id("organizations"), contactId: v.id("contacts") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.organizationId !== args.organizationId) return false;
    return (await reserveWhatsappLookup(ctx, contact._id, Date.now())).ok;
  },
});

const resultValidator = v.union(
  v.object({ status: v.literal("on_whatsapp"), canonicalPhone: v.string() }),
  v.object({ status: v.literal("not_on_whatsapp") }),
  v.object({ status: v.literal("check_failed") })
);

/** Aplica o veredito a UM contato (idempotente). Não grava activity/audit por linha. */
export const internalApplyNumberRepair = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    contactId: v.id("contacts"),
    checkedPhone: v.string(),
    result: resultValidator,
  },
  returns: v.union(v.literal("corrected"), v.literal("marked"), v.literal("verified"), v.literal("skipped")),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.organizationId !== args.organizationId) return "skipped" as const;
    const now = Date.now();
    // O número mudou desde a varredura: a resposta não vale.
    if (currentSendDigits(contact) !== digitsOf(args.checkedPhone)) return "skipped" as const;
    if (args.result.status === "check_failed") return "skipped" as const;
    if (args.result.status === "not_on_whatsapp") {
      await setWhatsappCheck(ctx, contact._id, "not_on_whatsapp", now, args.checkedPhone);
      return "marked" as const;
    }
    const canonical = args.result.canonicalPhone;
    // Inconclusivo: o gateway diz que ESTE número existe mas o envio deu `no LID
    // found`, ou devolveu um telefone que não é grafia do número perguntado.
    // Nada de marcador nem de reescrita (mesma regra do dispatch).
    if (canonical === digitsOf(args.checkedPhone) || !isSpellingOfSameNumber(args.checkedPhone, canonical)) {
      return "skipped" as const;
    }
    const { patch } = canonicalContactPatch(contact, canonical);
    await ctx.db.patch(contact._id, {
      ...patch,
      searchText: buildSearchText({ ...contact, ...patch }),
      whatsappCheck: { phone: canonical, status: "verified", checkedAt: now },
      ...(contact.whatsappFails ? { whatsappFails: undefined } : {}),
      updatedAt: now,
    });
    return "corrected" as const;
  },
});

export const internalAuditNumberRepair = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    summary: v.object({ scanned: v.number(), contacts: v.number(), corrected: v.number(), marked: v.number(), verified: v.number(), skipped: v.number() }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorType: "system",
      metadata: { op: "opsBridgeNumbers:internalRepairNoLidNumbers", ...args.summary },
      description: "Reparo de números de WhatsApp com falha 'no LID found' (op)",
      severity: "medium",
      createdAt: Date.now(),
    });
    return null;
  },
});

type RepairRow = {
  contactId: Id<"contacts">;
  phoneMasked: string;
  messages: number;
  outcome: "on_whatsapp_same" | "on_whatsapp_other_spelling" | "not_on_whatsapp" | "check_failed" | "not_checked" | "skipped_budget";
  canonicalMasked?: string;
  applied?: "corrected" | "marked" | "verified" | "skipped";
};

const repairReturnsValidator = v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    rows: v.array(
      v.object({
        contactId: v.id("contacts"),
        phoneMasked: v.string(),
        messages: v.number(),
        outcome: v.union(
          v.literal("on_whatsapp_same"),
          v.literal("on_whatsapp_other_spelling"),
          v.literal("not_on_whatsapp"),
          v.literal("check_failed"),
          v.literal("not_checked"),
          v.literal("skipped_budget")
        ),
        canonicalMasked: v.optional(v.string()),
        applied: v.optional(v.union(v.literal("corrected"), v.literal("marked"), v.literal("verified"), v.literal("skipped"))),
      })
    ),
    nextCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    fromMs: v.number(),
  });

export const internalRepairNoLidNumbers = internalAction({
  args: {
    organizationId: v.id("organizations"),
    sinceMs: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    // O dry run NÃO consulta o gateway (só lista os candidatos) salvo `lookup: true`.
    // Fora do dry run a consulta é sempre feita.
    lookup: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    // Fim da janela fixado na 1ª página (as seguintes herdam), para o cursor não derivar.
    fromMs: v.optional(v.number()),
  },
  returns: repairReturnsValidator,
  handler: async (ctx, args): Promise<Infer<typeof repairReturnsValidator>> => {
    const dryRun = args.dryRun !== false;
    const window = Math.min(Math.max(args.sinceMs ?? DEFAULT_WINDOW_MS, 60_000), MAX_WINDOW_MS);
    const fromMs = args.fromMs ?? Date.now() - window;
    const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE), 10), MAX_PAGE_SIZE);

    const page: ScanPage = await ctx.runQuery(internal.opsBridgeNumbers.internalScanNoLid, {
      organizationId: args.organizationId,
      from: fromMs,
      cursor: args.cursor ?? null,
      pageSize,
    });

    const doLookup = !dryRun || args.lookup === true;
    let stopped = false;
    const rows: RepairRow[] = [];
    const tally = { corrected: 0, marked: 0, verified: 0, skipped: 0 };
    let first = true;
    for (const c of page.candidates) {
      if (!doLookup) {
        rows.push({ contactId: c.contactId, phoneMasked: maskPhone(c.phone), messages: c.messageCount, outcome: "not_checked" });
        continue;
      }
      // O orçamento é do CONTATO (10 min / 3 por dia, o mesmo do self-heal e do
      // "Tentar novamente"): sem vaga, não consulta.
      const reserved = await ctx.runMutation(internal.opsBridgeNumbers.internalReserveContactLookup, {
        organizationId: args.organizationId,
        contactId: c.contactId,
      });
      if (!reserved) {
        rows.push({ contactId: c.contactId, phoneMasked: maskPhone(c.phone), messages: c.messageCount, outcome: "skipped_budget" });
        continue;
      }
      // Poucas consultas e espaçadas: o gateway é de uma conta de cliente.
      if (!first) await new Promise((r) => setTimeout(r, LOOKUP_GAP_MS));
      first = false;
      let result: { status: "on_whatsapp"; canonicalPhone: string } | { status: "not_on_whatsapp" } | { status: "check_failed" };
      try {
        const token = await decryptSecret(c.tokenEncrypted);
        const res = await checkBridgeNumber({ baseUrl: c.baseUrl, token, phone: c.phone });
        result = !res.ok
          ? { status: "check_failed" }
          : res.onWhatsapp
            ? { status: "on_whatsapp", canonicalPhone: res.canonicalPhone }
            : { status: "not_on_whatsapp" };
      } catch {
        result = { status: "check_failed" };
      }
      const row: RepairRow = {
        contactId: c.contactId,
        phoneMasked: maskPhone(c.phone),
        messages: c.messageCount,
        outcome:
          result.status === "check_failed"
            ? "check_failed"
            : result.status === "not_on_whatsapp"
              ? "not_on_whatsapp"
              : result.canonicalPhone === c.phone
                ? "on_whatsapp_same"
                : "on_whatsapp_other_spelling",
        ...(result.status === "on_whatsapp" && result.canonicalPhone !== c.phone
          ? { canonicalMasked: maskPhone(result.canonicalPhone) }
          : {}),
      };
      if (!dryRun) {
        const applied = await ctx.runMutation(internal.opsBridgeNumbers.internalApplyNumberRepair, {
          organizationId: args.organizationId,
          contactId: c.contactId,
          checkedPhone: c.phone,
          result,
        });
        row.applied = applied;
        tally[applied] += 1;
      }
      rows.push(row);
      // Gateway falhando (429, fora do ar): para a página AQUI, sem insistir nos
      // demais contatos nem agendar a próxima página.
      if (result.status === "check_failed") {
        stopped = true;
        break;
      }
    }

    if (!dryRun) {
      if (rows.length > 0) {
        await ctx.runMutation(internal.opsBridgeNumbers.internalAuditNumberRepair, {
          organizationId: args.organizationId,
          summary: { scanned: page.scanned, contacts: rows.length, ...tally },
        });
      }
      if (!stopped && !page.isDone && page.nextCursor) {
        await ctx.scheduler.runAfter(0, internal.opsBridgeNumbers.internalRepairNoLidNumbers, {
          organizationId: args.organizationId,
          dryRun: false,
          cursor: page.nextCursor,
          pageSize,
          fromMs,
        });
      }
    }
    return { dryRun, scanned: page.scanned, rows, nextCursor: page.nextCursor, isDone: page.isDone, fromMs };
  },
});
