/// <reference types="vite/client" />
/**
 * Classes de aviso de cobranca (PR 1): `planAlert` (uso), `billingNotices` (desativavel, com
 * `List-Unsubscribe`) e `billingCritical` (obrigatorio, nunca com `List-Unsubscribe`).
 * O Resend nao e registrado nos testes: `resend.sendEmail` e espionado para provar a TENTATIVA
 * de envio (e os cabecalhos), e o componente real nunca roda.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { resend } from "./email";
import { notifyBillingAdmins, type BillingNoticeType } from "./lib/billingNotify";
import { billingUnsubEmailExtras, verifyUnsubToken } from "./lib/billingUnsub";
import { PREFERENCE_FLAG, MANDATORY_FLAGS } from "./lib/notificationPolicy";
import { patchMemberPrefs, type PrefsPatch } from "./lib/notificationPrefs";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const SECRET = "fake-unsub-secret-0123456789abcdef0123456789abcdef";
const SITE = "https://fake-deploy.convex.site";

let t: TestConvex<typeof schema>;
let sendSpy: ReturnType<typeof vi.spyOn>;
let seq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  t = convexTest(schema, modules);
  vi.stubEnv("NOTIFICATION_UNSUB_SECRET", SECRET);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  sendSpy = vi.spyOn(resend, "sendEmail").mockResolvedValue("email-1" as never) as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Billing = Doc<"organizations">["billing"];

async function seed(billing: Billing = { plan: "profissional", status: "active", updatedAt: 1 }) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Cobranca",
      slug: "org-cobranca",
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      email: "admin-cobranca@acme.com.br",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminId };
  });
}

async function setPrefs(s: { organizationId: Id<"organizations">; adminId: Id<"teamMembers"> }, patch: PrefsPatch) {
  await t.run((ctx) => patchMemberPrefs(ctx, s.organizationId, s.adminId, patch, Date.now()));
}

/** Avisa e drena o agendador (o `dispatchNotification` roda aqui). Devolve quantos admins avisou. */
async function notify(s: { organizationId: Id<"organizations"> }, type: BillingNoticeType): Promise<number> {
  const n = await t.run((ctx) =>
    notifyBillingAdmins(ctx, {
      organizationId: s.organizationId,
      type,
      data: { amountBrl: "R$ 497,00", dueDate: "14/12/2026", planLabel: "Profissional" },
      dedupeKey: `${type}:${++seq}`,
    })
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return n;
}

const sentOptions = () => sendSpy.mock.calls.map((c: unknown[]) => c[1] as { headers?: { name: string; value: string }[]; subject?: string });
const headerNames = (o: { headers?: { name: string; value: string }[] }) => (o.headers ?? []).map((h) => h.name);

const CRITICAL: BillingNoticeType[] = ["plan_payment_overdue", "plan_read_only", "plan_cancel_scheduled", "plan_canceled", "plan_refunded"];
const NOTICES: BillingNoticeType[] = ["plan_payment_received", "plan_charge_upcoming", "plan_changed", "plan_change_scheduled"];
const USAGE: BillingNoticeType[] = ["plan_usage_warning", "plan_usage_reached", "plan_overage_cap_reached", "trial_ending"];

describe("tipo -> flag", () => {
  test("cada tipo de cobranca cai na classe certa", () => {
    for (const ty of CRITICAL) expect(PREFERENCE_FLAG[ty], ty).toBe("billingCritical");
    for (const ty of NOTICES) expect(PREFERENCE_FLAG[ty], ty).toBe("billingNotices");
    for (const ty of USAGE) expect(PREFERENCE_FLAG[ty], ty).toBe("planAlert");
    expect([...MANDATORY_FLAGS]).toEqual(["billingCritical"]);
  });
});

describe("critico (obrigatorio)", () => {
  test.each([
    ["preset none", { preset: "none" as const }],
    ["pausa", { pausedUntil: Date.parse("2026-10-15T18:00:00Z") }],
    ["horario de silencio", { quietHours: { enabled: true, start: "00:00", end: "23:59", timeZone: "UTC" } }],
    ["Avisos do plano desligado (coluna)", { planAlert: false }],
  ])("fura %s e sai SEM List-Unsubscribe", async (_label, prefs) => {
    const s = await seed();
    await setPrefs(s, prefs as PrefsPatch);
    expect(await notify(s, "plan_payment_overdue")).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(headerNames(sentOptions()[0])).toEqual([]);
  });

  test("todos os tipos criticos tentam o e-mail, mesmo com o sino do tipo desligado", async () => {
    const s = await seed();
    await setPrefs(s, { preset: "none", planAlert: false });
    for (const ty of CRITICAL) await notify(s, ty);
    expect(sendSpy).toHaveBeenCalledTimes(CRITICAL.length);
    for (const o of sentOptions()) expect(headerNames(o)).toEqual([]);
  });

  test("sem segredo de descadastro o critico continua saindo", async () => {
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET", "");
    const s = await seed();
    await notify(s, "plan_read_only");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe("billingNotices (desativavel)", () => {
  test("sai com List-Unsubscribe e One-Click, por destinatario", async () => {
    const s = await seed();
    await notify(s, "plan_payment_received");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const headers = Object.fromEntries((sentOptions()[0].headers ?? []).map((h: { name: string; value: string }) => [h.name, h.value]));
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const m = /^<(https:\/\/fake-deploy\.convex\.site\/notifications\/unsubscribe\?t=([^>]+))>, <https:\/\/[^>]+\/notificacoes\/desativar\?t=[^>]+>$/.exec(
      headers["List-Unsubscribe"],
    );
    expect(m).not.toBeNull();
    const claims = await verifyUnsubToken(decodeURIComponent(m![2]), { current: SECRET });
    expect(claims).toEqual({ organizationId: s.organizationId, memberId: s.adminId });
  });

  test("todos os tipos da classe levam o cabecalho", async () => {
    const s = await seed();
    for (const ty of NOTICES) await notify(s, ty);
    expect(sendSpy).toHaveBeenCalledTimes(NOTICES.length);
    for (const o of sentOptions()) expect(headerNames(o)).toEqual(["List-Unsubscribe", "List-Unsubscribe-Post"]);
  });

  test("coluna billingNotices=false nao envia", async () => {
    const s = await seed();
    await setPrefs(s, { billingNotices: false } as PrefsPatch);
    expect(await notify(s, "plan_charge_upcoming")).toBe(1); // o sino registra
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test("channels.email.billingNotices=false nao envia", async () => {
    const s = await seed();
    await setPrefs(s, { channels: { email: { billingNotices: false } } } as PrefsPatch);
    await notify(s, "plan_payment_received");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test("sem segredo (ou segredo curto) o e-mail da classe e RETIDO", async () => {
    for (const bad of ["", "curto"]) {
      vi.stubEnv("NOTIFICATION_UNSUB_SECRET", bad);
      const s = await seed();
      await notify(s, "plan_charge_upcoming");
      expect(sendSpy).not.toHaveBeenCalled();
      await t.run(async (ctx) => {
        const n = await ctx.db.query("notifications").collect();
        expect(n.length).toBeGreaterThan(0); // o sino nao depende do segredo
      });
      t = convexTest(schema, modules);
    }
  });

  test("sem CONVEX_SITE_URL o e-mail da classe e RETIDO", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "");
    const s = await seed();
    await notify(s, "plan_payment_received");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test("a mensagem de retencao nao carrega e-mail nem token", async () => {
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET", "");
    const warn = vi.spyOn(console, "warn");
    const s = await seed();
    await notify(s, "plan_payment_received");
    const text = warn.mock.calls.flat().join(" ");
    expect(text).toContain("retido");
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/v1\./);
  });
});

describe("planAlert (uso) segue como antes", () => {
  test("sem List-Unsubscribe e respeita preset none", async () => {
    const s = await seed();
    await notify(s, "plan_usage_warning");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(headerNames(sentOptions()[0])).toEqual([]);
    await setPrefs(s, { preset: "none" });
    await notify(s, "plan_usage_reached");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe("quiet e legacy silenciam tudo (inclusive o critico)", () => {
  test.each([
    ["quiet", { plan: "profissional", status: "active", quiet: true, updatedAt: 1 } as Billing],
    ["legacy", { status: "legacy", updatedAt: 1 } as Billing],
  ])("%s", async (_label, billing) => {
    const s = await seed(billing);
    for (const ty of [...CRITICAL, ...NOTICES]) expect(await notify(s, ty)).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    await t.run(async (ctx) => {
      expect(await ctx.db.query("notifications").collect()).toHaveLength(0);
    });
  });
});

describe("billingUnsubEmailExtras (pura)", () => {
  const claims = { organizationId: "o1", memberId: "m1" };
  test("monta cabecalhos e link da pagina", async () => {
    const x = await billingUnsubEmailExtras(claims, { current: SECRET });
    expect(x?.unsubUrl).toMatch(/\/notificacoes\/desativar\?t=v1\./);
    expect(x?.headers["List-Unsubscribe"]).toContain(`<${SITE}/notifications/unsubscribe?t=v1.`);
    expect(x?.headers["List-Unsubscribe"]).toContain(`<${x?.unsubUrl}>`);
  });
  test("sem segredo atual, ou so com o anterior, retem (null)", async () => {
    expect(await billingUnsubEmailExtras(claims, {})).toBeNull();
    expect(await billingUnsubEmailExtras(claims, { prev: SECRET })).toBeNull();
  });
  test("sem CONVEX_SITE_URL retem (null)", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "");
    expect(await billingUnsubEmailExtras(claims, { current: SECRET })).toBeNull();
  });
});
