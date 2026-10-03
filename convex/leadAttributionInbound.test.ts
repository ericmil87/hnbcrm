/// <reference types="vite/client" />
/**
 * T07: UTM/gclid/fbclid do `POST /api/v1/inbound/lead` e do formulário público
 * gravados em `leads.attribution` como PRIMEIRO TOQUE.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { normalizeCampaignKey } from "./lib/orgModules";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = Date.UTC(2026, 9, 3, 15, 0);
const API_KEY = "hnb_test_attribution_1";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Attr",
      slug: "org-attr",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("apiKeys", {
      organizationId, teamMemberId: adminId, name: "k", keyHash: await sha256Hex(API_KEY), isActive: true, createdAt: now,
    });
    const formId = await ctx.db.insert("forms", {
      organizationId,
      name: "Contato",
      slug: "contato-attr",
      status: "published",
      fields: [{ id: "f1", type: "text", label: "Nome", isRequired: false }],
      theme: { primaryColor: "#000", backgroundColor: "#fff", textColor: "#000", borderRadius: "md", showBranding: false },
      settings: {
        submitButtonText: "Enviar",
        successMessage: "ok",
        notifyOnSubmission: false,
        leadTitle: "Lead do site",
        boardId,
        stageId,
        assignmentMode: "none",
        defaultPriority: "medium",
        defaultTemperature: "cold",
        tags: [],
        honeypotEnabled: false,
      },
      createdBy: adminId,
      submissionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminId, boardId, stageId, formId };
  });
}

async function post(t: TestConvex<typeof schema>, body: Record<string, unknown>) {
  const res = await t.fetch("/api/v1/inbound/lead", {
    method: "POST",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const getLead = (t: TestConvex<typeof schema>, id: Id<"leads">) => t.run((ctx) => ctx.db.get(id));

describe("POST /api/v1/inbound/lead — atribuição", () => {
  test("UTM + gclid gravam attribution no lead novo (campaignKey = adSpend)", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const r = await post(t, {
      title: "Lead Google",
      contact: { firstName: "Ana", email: "ana@example.org" },
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "Réveillon 2026",
      utm_term: "pousada",
      utm_content: "anuncio-a",
      gclid: "GCLID-1",
      landingUrl: "https://site.com/reveillon?utm_source=google",
      referrer: "https://www.google.com/",
    });
    expect(r.status).toBe(201);
    expect(r.json.attributionSaved).toBe(true);
    const lead = await getLead(t, r.json.leadId);
    expect(lead?.attribution).toMatchObject({
      source: "google_ads",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "Réveillon 2026",
      utmTerm: "pousada",
      utmContent: "anuncio-a",
      gclid: "GCLID-1",
      campaignName: "Réveillon 2026",
      campaignKey: normalizeCampaignKey("Réveillon 2026"),
      landingUrl: "https://site.com/reveillon",
      referrer: "https://www.google.com/",
      capturedAt: NOW,
    });
  });

  test("objeto attribution em camelCase também vale", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const r = await post(t, { title: "L", attribution: { fbclid: "FB1", utmCampaign: "Black Friday" } });
    const lead = await getLead(t, r.json.leadId);
    expect(lead?.attribution).toMatchObject({ source: "meta_ads", fbclid: "FB1", campaignKey: "black-friday" });
  });

  test("sem parâmetros de mídia não grava attribution", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const r = await post(t, { title: "Sem origem" });
    expect(r.json.attributionSaved).toBe(false);
    expect((await getLead(t, r.json.leadId))?.attribution).toBeUndefined();
  });

  test("strings longas são cortadas em 200 e o corte é informado", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const r = await post(t, { title: "L", utm_campaign: "x".repeat(300), utm_source: "s" });
    expect(r.json.attributionTruncated).toEqual(["utmCampaign"]);
    expect((await getLead(t, r.json.leadId))?.attribution?.utmCampaign).toHaveLength(200);
  });

  test("primeiro toque: lead com attribution não é sobrescrito, vazios são preenchidos", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await post(t, { title: "L", utm_source: "google", gclid: "G1" });
    const leadId = r.json.leadId as Id<"leads">;
    const applied = await t.mutation(internal.inboundLeadWelcome.internalApplyLeadAttribution, {
      organizationId: s.organizationId,
      leadId,
      attribution: {
        source: "meta_ads",
        capturedAt: NOW + 5000,
        utmSource: "facebook",
        gclid: "G-OUTRO",
        utmMedium: "social",
        fbclid: "FB9",
      },
    });
    expect(applied).toBe(true);
    const attr = (await getLead(t, leadId))?.attribution;
    expect(attr).toMatchObject({
      source: "google_ads",
      capturedAt: NOW,
      utmSource: "google",
      gclid: "G1",
      utmMedium: "social",
      fbclid: "FB9",
    });
  });

  test("lead de outra org não é tocado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await post(t, { title: "L" });
    const otherOrg = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "Outra", slug: "outra-attr", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: NOW, updatedAt: NOW,
      })
    );
    expect(s.organizationId).not.toBe(otherOrg);
    const applied = await t.mutation(internal.inboundLeadWelcome.internalApplyLeadAttribution, {
      organizationId: otherOrg,
      leadId: r.json.leadId,
      attribution: { source: "site", capturedAt: NOW, utmSource: "x" },
    });
    expect(applied).toBe(false);
    expect((await getLead(t, r.json.leadId))?.attribution).toBeUndefined();
  });
});

describe("formulário público — atribuição", () => {
  const submit = (t: TestConvex<typeof schema>, formId: Id<"forms">, extra: Record<string, unknown>) =>
    t.mutation(internal.formSubmissions.internalProcessSubmission, {
      formId,
      data: { f1: "Maria" },
      honeypotTriggered: false,
      ...extra,
    });

  test("copia UTM/gclid capturados para o lead criado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await submit(t, s.formId, {
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "Verão 2027",
      gclid: "GF1",
      landingUrl: "https://site.com/lp",
      referrer: "https://www.google.com/",
    });
    const lead = await t.run(async (ctx) => (await ctx.db.query("leads").collect())[0]);
    expect(lead.attribution).toMatchObject({
      source: "google_ads",
      utmSource: "google",
      utmMedium: "cpc",
      gclid: "GF1",
      campaignKey: "verao-2027",
      landingUrl: "https://site.com/lp",
      referrer: "https://www.google.com/",
    });
  });

  test("sem UTM o lead do formulário fica sem attribution", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await submit(t, s.formId, { referrer: "https://www.google.com/" });
    const lead = await t.run(async (ctx) => (await ctx.db.query("leads").collect())[0]);
    expect(lead.attribution).toBeUndefined();
  });
});
