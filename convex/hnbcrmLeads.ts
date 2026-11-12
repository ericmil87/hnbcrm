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
import { sha256Hex } from "./lib/auditText";
import { evaluateFixedWindow, normalizeIpKey } from "./lib/onboardingBudget";
import {
  CONTACT_KIND_LABEL,
  CONTACT_SOURCE_NAME,
  SIGNUP_MARKER,
  SIGNUP_SOURCE_NAME,
  SIGNUP_TAG,
  SUMMARY_MARKER,
  addInternalNote,
  buildContactNote,
  cleanFormText,
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
  /** Sem IP válido: um balde COMPARTILHADO e mais baixo (nunca pula o limite). */
  ipUnknown: { windowMs: MS_HOUR, limit: 10 },
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

/** Titular da conta: o admin humano mais antigo da org (quem criou). Para ao achar. */
async function findOwner(ctx: MutationCtx, organizationId: Id<"organizations">) {
  for await (const m of ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human"))) {
    if (m.role === "admin" && m.removedAt === undefined && m.status !== "inactive") return m;
  }
  return null;
}

/** Lead de cadastro do titular (marcador no customFields), via contato por e-mail. */
async function findSignupLead(ctx: MutationCtx, internalOrgId: Id<"organizations">, email: string) {
  const contact = await ctx.db
    .query("contacts")
    .withIndex("by_organization_and_email", (q) => q.eq("organizationId", internalOrgId).eq("email", email))
    .first();
  if (!contact) return null;
  for await (const l of ctx.db.query("leads").withIndex("by_contact", (q) => q.eq("contactId", contact._id))) {
    if (l.organizationId === internalOrgId && l.customFields?.[SIGNUP_MARKER] !== undefined) return l;
  }
  return null;
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

    const orgName = cleanFormText(org.name, 80) || "organização";
    const name = cleanFormText(owner.name || email.split("@")[0], 80) || "Titular";
    // Só por e-mail: contato que já existe na org interna não é alterado.
    const { contactId } = await findOrCreateInternalContact(ctx, target, { name, email, company: orgName });
    await insertInternalLead(ctx, target, {
      title: `Cadastro: ${orgName}`,
      contactId,
      tags: [SIGNUP_TAG],
      customFields: { [SIGNUP_MARKER]: String(args.organizationId) },
      via: "cadastro",
      sourceName: SIGNUP_SOURCE_NAME,
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

    // O lead é de OUTRA org do mesmo titular: não mistura campos; só nota com o nome da org.
    if (lead.customFields?.[SIGNUP_MARKER] !== String(args.organizationId)) {
      const org = await ctx.db.get(args.organizationId);
      const orgName = cleanFormText(org?.name, 80) || "outra organização";
      await addInternalNote(ctx, target, lead._id, `Resumo do onboarding da organização "${orgName}". ${summary}`);
      return { status: "noted_other_org" };
    }

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
      severity: "medium",
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
    // E-mail só como hash na chave (a tabela não guarda o endereço em claro).
    const emailHash = (await sha256Hex(req.email)).slice(0, 32);
    const subjects = [
      ip ? { key: `contact:ip:${ip}`, spec: CONTACT_RATE.ip } : { key: "contact:ip:unknown", spec: CONTACT_RATE.ipUnknown },
      { key: `contact:email:${emailHash}`, spec: CONTACT_RATE.email },
      { key: "contact:global", spec: CONTACT_RATE.global },
    ];
    if (!(await consumeContactRate(ctx, now, subjects))) {
      console.warn(`[contact] teto atingido (${maskEmailForLog(req.email)})`);
      return { ok: false as const, code: "rate_limited", message: "Muitos pedidos em pouco tempo. Tente de novo mais tarde." };
    }

    // Contato só por e-mail; existente não é alterado e telefone já usado por outro contato não é
    // gravado: nesses casos o telefone informado vai só na nota.
    const { contactId, phoneStored } = await findOrCreateInternalContact(ctx, target, {
      name: req.name,
      email: req.email,
      company: req.business || undefined,
      phone: req.phone,
    });
    const note = buildContactNote(req) + (!phoneStored && req.phone ? `\nTelefone informado: ${req.phone}` : "");

    // Mesma pessoa pedindo o mesmo tipo de novo: nota no lead aberto, sem lead duplicado.
    let open: Doc<"leads"> | null = null;
    for await (const l of ctx.db.query("leads").withIndex("by_contact", (q) => q.eq("contactId", contactId))) {
      if (l.organizationId === target.org._id && l.closedAt === undefined && l.tags.includes(req.kind)) {
        open = l;
        break;
      }
    }
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
        sourceName: CONTACT_SOURCE_NAME,
      });
    }
    return { ok: true as const };
  },
});
