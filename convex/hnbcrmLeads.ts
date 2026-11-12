/**
 * Leads do próprio HNBCRM na org interna (env `HNBCRM_INTERNAL_ORG_ID`).
 * Ver `lib/hnbcrmLeads.ts` e `docs/architecture/onboarding.md` (seção "Leads do HNBCRM").
 *
 * - `internalCaptureSignupLead`: gancho de `createOrganization` (só ids no scheduler).
 * - `internalApplySignupSummary`: gancho de `applyOnboardingDraft` (nicho e plano de interesse).
 * - `internalSubmitContactRequest`: formulário público de contato/consultoria
 *   (`POST /api/v1/public/contact`, `router.ts`).
 *
 * Nenhuma função daqui envia e-mail, WhatsApp ou webhook.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { maskEmailForLog, normalizeEmail } from "./lib/emailAddress";
import { evaluateFixedWindow, normalizeIpKey } from "./lib/onboardingBudget";
import {
  SIGNUP_MARKER,
  SIGNUP_TAG,
  SUMMARY_MARKER,
  CONTACT_KIND_LABEL,
  addInternalNote,
  buildContactNote,
  findOrCreateInternalContact,
  insertInternalLead,
  parseContactRequest,
  resolveInternalTarget,
} from "./lib/hnbcrmLeads";

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
/** Tetos do formulário público (janela fixa; recusa não consome). */
const CONTACT_RATE = {
  ip: { windowMs: MS_HOUR, limit: 5 },
  email: { windowMs: MS_HOUR, limit: 3 },
  global: { windowMs: MS_DAY, limit: 300 },
} as const;

async function consumeContactRate(
  ctx: MutationCtx,
  now: number,
  subjects: Array<{ key: string; spec: { windowMs: number; limit: number } }>,
): Promise<boolean> {
  const plan: Array<{ key: string; doc: Doc<"onboardingRateLimits"> | null; next: { windowStart: number; count: number } }> = [];
  for (const s of subjects) {
    const doc = await ctx.db
      .query("onboardingRateLimits")
      .withIndex("by_key", (q) => q.eq("key", s.key))
      .unique();
    const res = evaluateFixedWindow(doc ? { windowStart: doc.windowStart, count: doc.count } : null, now, s.spec);
    if (!res.allowed) return false;
    plan.push({ key: s.key, doc, next: res.next });
  }
  for (const p of plan) {
    if (p.doc) await ctx.db.patch(p.doc._id, p.next);
    else await ctx.db.insert("onboardingRateLimits", { key: p.key, ...p.next });
  }
  return true;
}

/** Titular da conta: o admin humano mais antigo da org (quem criou). */
async function findOwner(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const humans = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human"))
    .take(50);
  return humans.find((m) => m.role === "admin" && m.removedAt === undefined && m.status !== "inactive") ?? null;
}

/** Lead de cadastro do titular (marcador no customFields), via contato por e-mail. */
async function findSignupLead(ctx: MutationCtx, internalOrgId: Id<"organizations">, email: string) {
  const contact = await ctx.db
    .query("contacts")
    .withIndex("by_organization_and_email", (q) => q.eq("organizationId", internalOrgId).eq("email", email))
    .first();
  if (!contact) return null;
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .take(50);
  return leads.find((l) => l.organizationId === internalOrgId && l.customFields?.[SIGNUP_MARKER] !== undefined) ?? null;
}

export const internalCaptureSignupLead = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    const target = await resolveInternalTarget(ctx);
    if (!target) return { status: "disabled" };
    if (target.org._id === args.organizationId) return { status: "internal_org" };
    const org = await ctx.db.get(args.organizationId);
    if (!org) return { status: "org_missing" };
    const owner = await findOwner(ctx, args.organizationId);
    const email = normalizeEmail(owner?.email);
    if (!owner || !email) return { status: "no_owner_email" };

    // Idempotente por titular: a mesma pessoa (ou a mesma org reagendada) não duplica.
    if (await findSignupLead(ctx, target.org._id, email)) return { status: "exists" };

    const name = (owner.name || email.split("@")[0]).slice(0, 80);
    const contactId = await findOrCreateInternalContact(ctx, target.org._id, {
      name,
      email,
      company: org.name.slice(0, 120),
    });
    await insertInternalLead(ctx, target, {
      title: `Cadastro: ${org.name.slice(0, 80)}`,
      contactId,
      tags: [SIGNUP_TAG],
      customFields: { [SIGNUP_MARKER]: String(args.organizationId) },
      via: "cadastro",
    });
    return { status: "created" };
  },
});

/** Campo personalizado existente na org interna (lead ou sem tipo de entidade). */
async function findLeadField(ctx: MutationCtx, orgId: Id<"organizations">, keys: string[]) {
  for (const key of keys) {
    const def = await ctx.db
      .query("fieldDefinitions")
      .withIndex("by_organization_and_key", (q) => q.eq("organizationId", orgId).eq("key", key))
      .first();
    if (def && def.entityType !== "contact") return def;
  }
  return null;
}

export const internalApplySignupSummary = internalMutation({
  args: { organizationId: v.id("organizations"), sessionId: v.id("onboardingSessions") },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    const target = await resolveInternalTarget(ctx);
    if (!target) return { status: "disabled" };
    if (target.org._id === args.organizationId) return { status: "internal_org" };
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId || !session.draft) {
      return { status: "no_draft" };
    }
    const owner = await findOwner(ctx, args.organizationId);
    const email = normalizeEmail(owner?.email);
    if (!email) return { status: "no_owner_email" };
    const lead = await findSignupLead(ctx, target.org._id, email);
    if (!lead) return { status: "no_lead" };

    // Só valores de listas fechadas (segmento, plano): nenhum texto livre atravessa.
    const wanted: Array<{ label: string; keys: string[]; value: string }> = [
      { label: "Segmento", keys: ["segmento", "nicho"], value: session.draft.business.segment },
    ];
    if (session.draft.planInterest) {
      wanted.push({ label: "Plano de interesse", keys: ["plano_interesse", "plano"], value: session.draft.planInterest });
    }
    const summary = wanted.map((w) => `${w.label}: ${w.value}`).join("; ");
    if (lead.customFields?.[SUMMARY_MARKER] === summary) return { status: "unchanged" };

    const customFields: Record<string, unknown> = { ...lead.customFields, [SUMMARY_MARKER]: summary };
    const leftovers: string[] = [];
    for (const w of wanted) {
      const def = await findLeadField(ctx, target.org._id, w.keys);
      const optionOk = def?.type === "select" ? def.options?.includes(w.value) === true : def?.type === "text";
      if (def && optionOk) customFields[def.key] = w.value;
      else leftovers.push(`${w.label}: ${w.value}`);
    }
    const now = Date.now();
    await ctx.db.patch(lead._id, { customFields, lastActivityAt: now, updatedAt: now });
    await ctx.db.insert("auditLogs", {
      organizationId: target.org._id,
      entityType: "lead",
      entityId: lead._id,
      action: "update",
      actorId: target.actor._id,
      actorType: "system",
      metadata: { via: "onboarding_summary" },
      description: "Resumo do onboarding aplicado ao lead de cadastro",
      severity: "low",
      createdAt: now,
    });
    if (leftovers.length > 0) {
      await addInternalNote(ctx, target, lead._id, `Resumo do onboarding. ${leftovers.join("; ")}`);
    }
    return { status: "updated" };
  },
});

export const internalSubmitContactRequest = internalMutation({
  args: {
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    business: v.optional(v.string()),
    teamSize: v.optional(v.string()),
    need: v.string(),
    kind: v.string(),
    ipKey: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  ),
  handler: async (ctx, args) => {
    const parsed = parseContactRequest(args);
    if (!parsed.ok) return { ok: false as const, code: "invalid", message: parsed.message };
    const req = parsed.value;

    const target = await resolveInternalTarget(ctx);
    if (!target) {
      return { ok: false as const, code: "unavailable", message: "Formulário indisponível agora. Use o e-mail de contato." };
    }

    const now = Date.now();
    const ip = normalizeIpKey(args.ipKey);
    const subjects = [
      ...(ip ? [{ key: `contact:ip:${ip}`, spec: CONTACT_RATE.ip }] : []),
      { key: `contact:email:${req.email}`, spec: CONTACT_RATE.email },
      { key: "contact:global", spec: CONTACT_RATE.global },
    ];
    if (!(await consumeContactRate(ctx, now, subjects))) {
      console.warn(`[contact] teto atingido (${maskEmailForLog(req.email)})`);
      return { ok: false as const, code: "rate_limited", message: "Muitos pedidos em pouco tempo. Tente de novo mais tarde." };
    }

    const contactId = await findOrCreateInternalContact(ctx, target.org._id, {
      name: req.name,
      email: req.email,
      company: req.business || undefined,
      phone: req.phone,
    });
    const note = buildContactNote(req);

    // Mesma pessoa pedindo o mesmo tipo de novo: nota no lead aberto, sem lead duplicado.
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .take(50);
    const open = leads.find(
      (l) => l.organizationId === target.org._id && l.closedAt === undefined && l.tags.includes(req.kind),
    );
    if (open) {
      await addInternalNote(ctx, target, open._id, note);
    } else {
      await insertInternalLead(ctx, target, {
        title: `${CONTACT_KIND_LABEL[req.kind]}: ${req.name}`,
        contactId,
        tags: [req.kind],
        customFields: {},
        note,
        via: "formulário de contato",
      });
    }
    return { ok: true as const };
  },
});
