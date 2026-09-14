/**
 * Segmentação server-side do público de uma campanha (leads existentes).
 *
 * Primeiro corte por índice (estágio > responsável > board > org), o resto em
 * JS. Cada lead vira no máximo 1 candidato (1 telefone). Devolve também a
 * contagem de exclusões por motivo, para a UI mostrar "12 sem telefone,
 * 3 na lista de supressão…".
 *
 * Limite de varredura: MAX_SCAN leads (v1 — orgs maiores segmentam por board).
 */
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { normalizeCampaignPhone } from "./phone";

export const MAX_SCAN = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AudienceFilters {
  boardId?: Id<"boards">;
  stageIds?: Id<"stages">[];
  tags?: string[];
  assignedTo?: Id<"teamMembers">;
  temperature?: "cold" | "warm" | "hot";
  priority?: "low" | "medium" | "high" | "urgent";
  lastActivityBefore?: number;
  lastActivityAfter?: number;
  onlyOpenWindow?: boolean;
  excludeCampaignedWithinDays?: number;
  excludeRepliedToCampaigns?: boolean;
}

export interface AudienceCandidate {
  leadId: Id<"leads">;
  contactId: Id<"contacts">;
  phone: string;
  displayName?: string;
  vars: Record<string, string>;
}

export type ExclusionReason =
  | "no_contact"
  | "no_phone"
  | "invalid_phone"
  | "duplicate_phone"
  | "opted_out"
  | "window_closed"
  | "campaigned_recently"
  | "replied_before";

export interface AudienceResult {
  candidates: AudienceCandidate[];
  excluded: Record<ExclusionReason, number>;
  scanned: number;
  truncated: boolean;
}

export function contactDisplayName(contact: Doc<"contacts">): string | undefined {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  return name || undefined;
}

export function contactVars(contact: Doc<"contacts">, lead?: Doc<"leads"> | null): Record<string, string> {
  const vars: Record<string, string> = {};
  const set = (k: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) vars[k] = v.trim();
  };
  set("nome", contactDisplayName(contact));
  set("primeiro_nome", contact.firstName);
  set("sobrenome", contact.lastName);
  set("email", contact.email);
  set("empresa", contact.company);
  set("cargo", contact.title);
  set("cidade", contact.city);
  set("estado", contact.state);
  if (lead) {
    set("lead", lead.title);
    for (const [k, v] of Object.entries(lead.customFields ?? {})) {
      if (typeof v === "string" || typeof v === "number") vars[k] = String(v);
    }
  }
  return vars;
}

export async function isPhoneSuppressed(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  phone: string
): Promise<boolean> {
  const row = await ctx.db
    .query("optOuts")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", organizationId).eq("phone", phone)
    )
    .first();
  return row !== null;
}

/** Já recebeu campanha nos últimos N dias / já respondeu a alguma campanha? */
async function campaignHistory(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  phone: string
): Promise<Doc<"campaignRecipients">[]> {
  return await ctx.db
    .query("campaignRecipients")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", organizationId).eq("phone", phone)
    )
    .take(50);
}

export async function resolveSegmentAudience(
  ctx: QueryCtx | MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    filters: AudienceFilters;
    now: number;
    limit?: number; // teto de candidatos devolvidos (preview usa pequeno)
    scanOffset?: number; // snapshot em lotes: pula os N primeiros leads do corte
    scanLimit?: number; // e varre no máximo M (default MAX_SCAN)
  }
): Promise<AudienceResult> {
  const { organizationId, filters, now } = args;
  const excluded: Record<ExclusionReason, number> = {
    no_contact: 0,
    no_phone: 0,
    invalid_phone: 0,
    duplicate_phone: 0,
    opted_out: 0,
    window_closed: 0,
    campaigned_recently: 0,
    replied_before: 0,
  };

  const scanOffset = Math.max(0, args.scanOffset ?? 0);
  const scanLimit = Math.max(1, Math.min(MAX_SCAN, args.scanLimit ?? MAX_SCAN));
  const takeN = scanOffset + scanLimit + 1;

  // Primeiro corte por índice
  let leads: Doc<"leads">[];
  if (filters.stageIds && filters.stageIds.length === 1) {
    const stageId = filters.stageIds[0];
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_stage", (q) =>
        q.eq("organizationId", organizationId).eq("stageId", stageId)
      )
      .take(takeN);
  } else if (filters.assignedTo) {
    const assignedTo = filters.assignedTo;
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_assigned", (q) =>
        q.eq("organizationId", organizationId).eq("assignedTo", assignedTo)
      )
      .take(takeN);
  } else if (filters.boardId) {
    const boardId = filters.boardId;
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_board", (q) =>
        q.eq("organizationId", organizationId).eq("boardId", boardId)
      )
      .take(takeN);
  } else {
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_archived", (q) =>
        q.eq("organizationId", organizationId).eq("archivedAt", undefined)
      )
      .take(takeN);
  }
  const truncated = leads.length > scanOffset + scanLimit;
  leads = leads.slice(scanOffset, scanOffset + scanLimit);
  const scannedCount = leads.length;

  // Filtros em JS
  const stageSet = filters.stageIds && filters.stageIds.length > 0 ? new Set(filters.stageIds) : null;
  const tagList = (filters.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  leads = leads.filter((lead) => {
    if (lead.archivedAt !== undefined) return false;
    if (filters.boardId && lead.boardId !== filters.boardId) return false;
    if (stageSet && !stageSet.has(lead.stageId)) return false;
    if (filters.assignedTo && lead.assignedTo !== filters.assignedTo) return false;
    if (filters.temperature && lead.temperature !== filters.temperature) return false;
    if (filters.priority && lead.priority !== filters.priority) return false;
    if (filters.lastActivityBefore !== undefined && (lead.lastActivityAt ?? lead.updatedAt) >= filters.lastActivityBefore) return false;
    if (filters.lastActivityAfter !== undefined && (lead.lastActivityAt ?? lead.updatedAt) < filters.lastActivityAfter) return false;
    if (tagList.length > 0) {
      const leadTags = new Set(lead.tags.map((t) => t.toLowerCase()));
      if (!tagList.every((t) => leadTags.has(t))) return false;
    }
    return true;
  });

  const seen = new Set<string>();
  const candidates: AudienceCandidate[] = [];
  const limit = args.limit ?? Number.MAX_SAFE_INTEGER;

  for (const lead of leads) {
    if (!lead.contactId) {
      excluded.no_contact++;
      continue;
    }
    const contact = await ctx.db.get(lead.contactId);
    if (!contact) {
      excluded.no_contact++;
      continue;
    }
    const raw = contact.whatsappNumber ?? contact.phone;
    if (!raw) {
      excluded.no_phone++;
      continue;
    }
    const normalized = normalizeCampaignPhone(raw);
    if (!normalized.ok) {
      excluded.invalid_phone++;
      continue;
    }
    const phone = normalized.phone;
    if (seen.has(phone)) {
      excluded.duplicate_phone++;
      continue;
    }
    if (await isPhoneSuppressed(ctx, organizationId, phone)) {
      seen.add(phone);
      excluded.opted_out++;
      continue;
    }
    if (filters.onlyOpenWindow) {
      const convo = await ctx.db
        .query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", lead._id).eq("channel", "whatsapp"))
        .first();
      const open = convo?.lastInboundAt !== undefined && convo.lastInboundAt + DAY_MS > now;
      if (!open) {
        seen.add(phone);
        excluded.window_closed++;
        continue;
      }
    }
    if (filters.excludeCampaignedWithinDays || filters.excludeRepliedToCampaigns) {
      const history = await campaignHistory(ctx, organizationId, phone);
      if (filters.excludeRepliedToCampaigns && history.some((r) => r.status === "replied")) {
        seen.add(phone);
        excluded.replied_before++;
        continue;
      }
      if (filters.excludeCampaignedWithinDays) {
        const since = now - filters.excludeCampaignedWithinDays * DAY_MS;
        const recent = history.some(
          (r) => (r.sentAt ?? r.createdAt) >= since && r.status !== "pending" && r.status !== "skipped"
        );
        if (recent) {
          seen.add(phone);
          excluded.campaigned_recently++;
          continue;
        }
      }
    }
    seen.add(phone);
    candidates.push({
      leadId: lead._id,
      contactId: contact._id,
      phone,
      displayName: contactDisplayName(contact),
      vars: contactVars(contact, lead),
    });
    if (candidates.length >= limit) break;
  }

  return { candidates, excluded, scanned: scannedCount, truncated };
}
