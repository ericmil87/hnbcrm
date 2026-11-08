/// <reference types="vite/client" />
/**
 * E1 — Web Push + escada de canais (integração): assinatura multi-tenant e
 * troca de conta, gate de I/O, "lido → não envia", e-mail de rede de
 * segurança, pausa/silêncio/bypass, prévia (membro × org × 413), respostas
 * 404/410/413/429 com `fetch` mockado, revogação e retenção.
 *
 * O payload é DECIFRADO no teste (chave privada do "aparelho" gerada aqui),
 * então as asserções olham o que o celular de fato receberia.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { createECDH, randomBytes, type ECDH } from "node:crypto";
import { createRequire } from "node:module";
import webpush from "web-push";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notify";
import { EMAIL_SAFETY_NET_MS } from "./lib/notificationChannels";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const ece = createRequire(import.meta.url)("http_ece") as {
  decrypt: (buf: Buffer, opts: { version: string; privateKey: ECDH; authSecret: Buffer }) => Buffer;
};

const NOW = Date.UTC(2026, 10, 4, 15, 0, 0); // 12:00 em São Paulo
const HOUR = 3_600_000;

let t: TestConvex<typeof schema>;
let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
  // Par VAPID gerado na hora (nunca versionado).
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:ops@example.com";
  fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...savedEnv };
});

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seedOrg(slug: string, opts: { hidePreview?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.hidePreview ? { notificationDefaults: { preset: "all", hidePreviewOnLockScreen: true } } : {}),
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const mk = async (name: string, role: "admin" | "agent", userId?: Id<"users">) => {
      const uid = userId ?? (await ctx.db.insert("users", {}));
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId: uid, name, email: `${name.toLowerCase()}@${slug}.com.br`, role, type: "human",
        status: "active", createdAt: NOW, updatedAt: NOW,
      });
      return { userId: uid, memberId };
    };
    return { organizationId, admin: await mk("Admin", "admin"), agent: await mk("Agente", "agent") };
  });
}
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Who = Org["admin"];

async function addMember(org: Org, name: string, userId?: Id<"users">): Promise<Who> {
  return await t.run(async (ctx) => {
    const uid = userId ?? (await ctx.db.insert("users", {}));
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId: org.organizationId, userId: uid, name, role: "agent", type: "human",
      status: "active", createdAt: NOW, updatedAt: NOW,
    });
    return { userId: uid, memberId };
  });
}

const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

/** "Aparelho": endpoint + chaves; guarda a privada para decifrar o que chegou. */
function device(suffix = randomBytes(6).toString("hex")) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    ecdh,
    authSecret,
    endpoint: `https://fcm.googleapis.com/fcm/send/fake-${suffix}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: authSecret.toString("base64url"),
  };
}
type Device = ReturnType<typeof device>;

async function subscribe(org: Org, who: Who, d: Device, platform: "android" | "ios" | "desktop" | "other" = "android") {
  return await as(who.userId).mutation(api.push.subscribe, {
    organizationId: org.organizationId,
    endpoint: d.endpoint,
    p256dh: d.p256dh,
    auth: d.auth,
    platform,
    userAgentLabel: "Chrome no Android",
  });
}

async function notify(
  org: Org,
  who: Who,
  type: "task_assigned" | "handoff_requested" | "new_message" | "campaign_completed",
  extra: Record<string, unknown> = {}
) {
  return await t.run((ctx) =>
    createNotification(ctx, {
      organizationId: org.organizationId,
      memberId: who.memberId,
      type,
      title: type === "new_message" ? "Mensagem nova de Ana" : "Aviso",
      body: "Prévia: me liga no +55 81 99999-1234",
      ...extra,
    })
  );
}

const jobs = (fragment: string) =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes(fragment)));
const pendingJobs = async (fragment: string) => (await jobs(fragment)).filter((j) => j.state.kind === "pending");
const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
const subsOf = (userId: Id<"users">) =>
  t.run((ctx) => ctx.db.query("pushSubscriptions").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
const linksOf = (memberId: Id<"teamMembers">) =>
  t.run((ctx) => ctx.db.query("pushSubscriptionMembers").withIndex("by_member", (q) => q.eq("teamMemberId", memberId)).collect());
const stats = async (organizationId: Id<"organizations">) => {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("pushDeliveryStats")
      .withIndex("by_organization_and_day_and_type_and_outcome_and_shard", (q) => q.eq("organizationId", organizationId))
      .collect()
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.outcome] = (out[r.outcome] ?? 0) + r.count;
  return out;
};

/** O que o aparelho recebeu na chamada N do fetch (decifrado). */
function received(call: number, d: Device) {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  const body = Buffer.from(init.body as Uint8Array);
  const plain = ece.decrypt(body, { version: "aes128gcm", privateKey: d.ecdh, authSecret: d.authSecret });
  return { url, headers: init.headers as Record<string, string>, payload: JSON.parse(plain.toString("utf8")) };
}

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------

describe("subscribe / unsubscribe / aparelhos", () => {
  test("assina, vincula à org ativa e é idempotente", async () => {
    const org = await seedOrg("a");
    const d = device();
    const first = await subscribe(org, org.agent, d);
    const again = await subscribe(org, org.agent, d);
    expect(again.subscriptionId).toBe(first.subscriptionId);
    expect(first.reassigned).toBe(false);
    expect(await subsOf(org.agent.userId)).toHaveLength(1);
    expect(await linksOf(org.agent.memberId)).toHaveLength(1);
  });

  test("multi-tenant: não-membro não assina; endpoint fora dos serviços de push é recusado", async () => {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    await expect(subscribe(b, a.agent, device())).rejects.toThrow();
    await expect(t.mutation(api.push.subscribe, {
      organizationId: a.organizationId, endpoint: device().endpoint, p256dh: device().p256dh, auth: device().auth, platform: "android",
    })).rejects.toThrow();
    const evil = { ...device(), endpoint: "https://169.254.169.254/latest/meta-data" };
    await expect(subscribe(a, a.agent, evil)).rejects.toThrow(/não é suportado/);
    await expect(subscribe(a, a.agent, { ...device(), p256dh: "curta" })).rejects.toThrow(/inválida/);
  });

  test("mesmo usuário em duas orgs: um aparelho, dois vínculos; sair de uma mantém a outra", async () => {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    const inB = await addMember(b, "Agente", a.agent.userId);
    const d = device();
    const s1 = await subscribe(a, a.agent, d);
    const s2 = await subscribe(b, inB, d);
    expect(s2.subscriptionId).toBe(s1.subscriptionId);
    expect(await linksOf(a.agent.memberId)).toHaveLength(1);
    expect(await linksOf(inB.memberId)).toHaveLength(1);
    expect(await as(a.agent.userId).mutation(api.push.unsubscribe, { organizationId: a.organizationId, endpoint: d.endpoint })).toEqual({ removed: true });
    expect(await linksOf(a.agent.memberId)).toHaveLength(0);
    expect(await subsOf(a.agent.userId)).toHaveLength(1);
    await as(a.agent.userId).mutation(api.push.unsubscribe, { organizationId: b.organizationId, endpoint: d.endpoint });
    expect(await subsOf(a.agent.userId)).toHaveLength(0);
  });

  test("troca de conta no aparelho: o endpoint passa ao novo usuário e o anterior perde todos os vínculos", async () => {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    const d = device();
    await subscribe(a, a.agent, d);
    const res = await subscribe(b, b.admin, d);
    expect(res.reassigned).toBe(true);
    expect(await subsOf(a.agent.userId)).toHaveLength(0);
    expect(await linksOf(a.agent.memberId)).toHaveLength(0);
    const subs = await subsOf(b.admin.userId);
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe(d.endpoint);
    // O usuário anterior não consegue mais tirar o vínculo do novo.
    expect(await as(a.agent.userId).mutation(api.push.unsubscribe, { organizationId: a.organizationId, endpoint: d.endpoint })).toEqual({ removed: false });
    expect(await linksOf(b.admin.memberId)).toHaveLength(1);
  });

  test("getMyDevices: só os do próprio usuário, com linkedHere/isCurrent e sem endpoint; removeDevice exige ser o dono", async () => {
    const a = await seedOrg("a");
    const d1 = device();
    const d2 = device();
    await subscribe(a, a.agent, d1, "android");
    await subscribe(a, a.agent, d2, "desktop");
    await subscribe(a, a.admin, device());
    const mine = await as(a.agent.userId).query(api.push.getMyDevices, { organizationId: a.organizationId, currentEndpoint: d2.endpoint });
    expect(mine).toHaveLength(2);
    expect(mine.filter((x) => x.isCurrent).map((x) => x.platform)).toEqual(["desktop"]);
    expect(mine.every((x) => x.linkedHere && x.userAgentLabel === "Chrome no Android")).toBe(true);
    expect(JSON.stringify(mine)).not.toContain("fcm.googleapis.com");
    await expect(
      as(a.admin.userId).mutation(api.push.removeDevice, { organizationId: a.organizationId, subscriptionId: mine[0].subscriptionId })
    ).rejects.toThrow(/não encontrado/);
    await as(a.agent.userId).mutation(api.push.removeDevice, { organizationId: a.organizationId, subscriptionId: mine[0].subscriptionId });
    expect(await subsOf(a.agent.userId)).toHaveLength(1);
    expect(await linksOf(a.agent.memberId)).toHaveLength(1);
  });

  test("teto de 10 aparelhos por membro: o vínculo mais antigo sai", async () => {
    const a = await seedOrg("a");
    for (let i = 0; i < 11; i++) {
      vi.setSystemTime(NOW + i * 1000);
      await subscribe(a, a.agent, device(`d${i}`));
    }
    const links = await linksOf(a.agent.memberId);
    expect(links).toHaveLength(10);
    const subs = await subsOf(a.agent.userId);
    expect(subs.map((s) => s.endpoint)).not.toContain("https://fcm.googleapis.com/fcm/send/fake-d0");
  });

  test("getVapidPublicKey: chave do deployment ou null", async () => {
    expect(await t.query(api.push.getVapidPublicKey, {})).toBe(process.env.VAPID_PUBLIC_KEY);
    delete process.env.VAPID_PUBLIC_KEY;
    expect(await t.query(api.push.getVapidPublicKey, {})).toBeNull();
  });

  test("remover membro apaga os vínculos (e a assinatura que ficou sem nenhum)", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    await as(a.admin.userId).mutation(api.teamMembers.removeTeamMember, { teamMemberId: a.agent.memberId });
    expect(await linksOf(a.agent.memberId)).toHaveLength(0);
    expect(await subsOf(a.agent.userId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher e entrega
// ---------------------------------------------------------------------------

describe("escada: push", () => {
  test("gate de I/O: sem aparelho vinculado nada é agendado; com aparelho, um job", async () => {
    const a = await seedOrg("a");
    await notify(a, a.agent, "task_assigned");
    expect(await jobs("internalDeliverPush")).toHaveLength(0);
    await subscribe(a, a.agent, device());
    await notify(a, a.agent, "task_assigned");
    expect(await jobs("internalDeliverPush")).toHaveLength(1);
    // Tipo informativo: sem push mesmo com aparelho.
    await notify(a, a.agent, "campaign_completed");
    expect(await jobs("internalDeliverPush")).toHaveLength(1);
  });

  test("entrega: headers RFC 8030, payload decifrado sem PII, contador `sent`", async () => {
    const a = await seedOrg("a");
    const d = device();
    await subscribe(a, a.agent, d);
    const id = await notify(a, a.agent, "new_message", { conversationId: undefined });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const got = received(0, d);
    expect(got.url).toBe(d.endpoint);
    expect(got.headers).toMatchObject({ TTL: "14400", Urgency: "high", "Content-Encoding": "aes128gcm" });
    expect(got.headers.Authorization).toMatch(/^vapid t=/);
    expect(got.headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(got.payload.web_push).toBe(8030);
    expect(got.payload.notification).toMatchObject({ title: "Mensagem nova de Ana", lang: "pt-BR", dir: "auto", app_badge: 1 });
    expect(got.payload.notification.body).toBe("Prévia: me liga no [telefone]");
    expect(got.payload.notification.navigate).toMatch(/^https:\/\/.+\/app\/abrir\?org=/);
    expect(got.payload.hnb).toMatchObject({ v: 1, notificationId: id, organizationId: a.organizationId, renotify: true });
    expect(JSON.stringify(got.payload)).not.toMatch(/99999|@/);
    expect(await stats(a.organizationId)).toEqual({ sent: 1 });
  });

  test("tarefas: urgência normal e TTL 24 h", async () => {
    const a = await seedOrg("a");
    const d = device();
    await subscribe(a, a.agent, d);
    await notify(a, a.agent, "task_assigned");
    await drain();
    expect(received(0, d).headers).toMatchObject({ TTL: "86400", Urgency: "normal" });
  });

  test("lido antes de sair → não envia (conta `suppressed_read`)", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    const id = await notify(a, a.agent, "task_assigned");
    await as(a.agent.userId).mutation(api.notifications.markRead, { organizationId: a.organizationId, notificationId: id! });
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await stats(a.organizationId)).toEqual({ suppressed_read: 1 });
  });

  test("pausa segura o push; pedido de ajuda fura (E3); com bypass desligado, segura também", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    await as(a.agent.userId).mutation(api.notificationPreferences.pauseFor, { organizationId: a.organizationId, mode: "1h" });
    await notify(a, a.agent, "task_assigned");
    expect(await jobs("internalDeliverPush")).toHaveLength(0);
    await notify(a, a.agent, "handoff_requested");
    expect(await jobs("internalDeliverPush")).toHaveLength(1);
    await t.run(async (ctx) => {
      const p = await ctx.db.query("notificationPreferences").withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", a.organizationId).eq("teamMemberId", a.agent.memberId)).first();
      await ctx.db.patch(p!._id, { urgentBypass: false });
    });
    await notify(a, a.agent, "handoff_requested");
    expect(await jobs("internalDeliverPush")).toHaveLength(1);
  });

  test("silêncio (21h–8h no fuso do membro) segura o push", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        organizationId: a.organizationId, teamMemberId: a.agent.memberId, invite: true, handoffRequested: true,
        handoffResolved: true, taskOverdue: true, taskAssigned: true, leadAssigned: true, newMessage: true,
        dailyDigest: true, quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "America/Sao_Paulo" },
        createdAt: NOW, updatedAt: NOW,
      })
    );
    await notify(a, a.agent, "task_assigned");
    expect(await jobs("internalDeliverPush")).toHaveLength(0);
  });

  test("canal push desligado na matriz do membro: nada agendado", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        organizationId: a.organizationId, teamMemberId: a.agent.memberId, invite: true, handoffRequested: true,
        handoffResolved: true, taskOverdue: true, taskAssigned: true, leadAssigned: true, newMessage: true,
        dailyDigest: true, channels: { push: { taskAssigned: false } }, createdAt: NOW, updatedAt: NOW,
      })
    );
    await notify(a, a.agent, "task_assigned");
    expect(await jobs("internalDeliverPush")).toHaveLength(0);
  });

  test("prévia: org que oculta na tela de bloqueio e membro com showPreview:false → sem corpo", async () => {
    const hidden = await seedOrg("saude", { hidePreview: true });
    const d1 = device();
    await subscribe(hidden, hidden.agent, d1);
    await notify(hidden, hidden.agent, "new_message");
    await drain();
    const p1 = received(0, d1).payload;
    expect(p1.notification.body).toBeUndefined();
    expect(p1.notification.title).toBe("Mensagem nova de Ana");

    const open = await seedOrg("aberta");
    const d2 = device();
    await subscribe(open, open.agent, d2);
    await as(open.agent.userId).mutation(api.notificationPreferences.setShowPreview, { organizationId: open.organizationId, showPreview: false });
    await notify(open, open.agent, "new_message");
    await drain();
    expect(received(1, d2).payload.notification.body).toBeUndefined();
  });

  test("multi-org: nome da org no título", async () => {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    await addMember(b, "Agente", a.agent.userId);
    const d = device();
    await subscribe(a, a.agent, d);
    await notify(a, a.agent, "task_assigned");
    await drain();
    expect(received(0, d).payload.notification.title).toBe("Org a · Aviso");
  });

  test("404/410 apaga a assinatura e os vínculos", async () => {
    for (const status of [404, 410]) {
      const a = await seedOrg(`g${status}`);
      fetchMock.mockImplementation(async () => new Response(null, { status }));
      await subscribe(a, a.agent, device());
      await notify(a, a.agent, "task_assigned");
      await drain();
      expect(await subsOf(a.agent.userId)).toHaveLength(0);
      expect(await linksOf(a.agent.memberId)).toHaveLength(0);
      expect(await stats(a.organizationId)).toEqual({ gone: 1 });
    }
  });

  test("413 reenvia sem prévia", async () => {
    const a = await seedOrg("a");
    const d = device();
    await subscribe(a, a.agent, d);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 413 }));
    await notify(a, a.agent, "new_message");
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received(0, d).payload.notification.body).toBeDefined();
    expect(received(1, d).payload.notification.body).toBeUndefined();
    expect(await stats(a.organizationId)).toEqual({ sent: 1, sent_without_preview: 1 });
  });

  test("429/5xx reagenda até 3 tentativas e para", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    fetchMock.mockImplementation(async () => new Response(null, { status: 429, headers: { "Retry-After": "5" } }));
    await notify(a, a.agent, "task_assigned");
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await stats(a.organizationId)).toEqual({ retry: 3, retry_exhausted: 1 });
    expect(await subsOf(a.agent.userId)).toHaveLength(1);
  });

  test("5xx e depois 201: o reenvio relê a notificação e entrega", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await notify(a, a.agent, "task_assigned");
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await stats(a.organizationId)).toEqual({ retry: 1, sent: 1 });
  });

  test("sem VAPID no deployment: nenhum fetch, conta `not_configured`", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    delete process.env.VAPID_PRIVATE_KEY;
    await notify(a, a.agent, "task_assigned");
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await stats(a.organizationId)).toEqual({ not_configured: 1 });
  });

  test("membro removido entre o agendamento e a entrega: não envia", async () => {
    const a = await seedOrg("a");
    await subscribe(a, a.agent, device());
    await notify(a, a.agent, "task_assigned");
    await t.run((ctx) => ctx.db.patch(a.agent.memberId, { removedAt: NOW, status: "inactive" }));
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("agrupamento: patch da janela do relay empurra de novo, renotify só depois de 5 min", async () => {
    const a = await seedOrg("a");
    const d = device();
    await subscribe(a, a.agent, d);
    const coalesced = (count: number) =>
      t.run((ctx) =>
        createNotification(ctx, {
          organizationId: a.organizationId, memberId: a.agent.memberId, type: "new_message",
          title: `${count} mensagens`, coalesce: { key: "new_message:fake", increment: 1, telegramOnPatch: true },
        })
      );
    await coalesced(1);
    await drain();
    vi.setSystemTime(NOW + 60_000);
    await coalesced(2);
    await drain();
    vi.setSystemTime(NOW + 6 * 60_000);
    await coalesced(3);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => received(i, d).payload.hnb.renotify)).toEqual([true, false, true]);
    // Patch sem `telegramOnPatch` é silencioso.
    await t.run((ctx) =>
      createNotification(ctx, {
        organizationId: a.organizationId, memberId: a.agent.memberId, type: "new_message",
        title: "x", coalesce: { key: "new_message:fake", increment: 1 },
      })
    );
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// E-mail de rede de segurança
// ---------------------------------------------------------------------------

async function runEmailJobsAndSeeSend(): Promise<boolean> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await drain();
    return spy.mock.calls.some((c) => String(c[0]).includes("falha ao enfileirar"));
  } finally {
    spy.mockRestore();
  }
}

describe("escada: e-mail de rede de segurança", () => {
  const email = { eventType: "taskAssigned", templateData: { taskTitle: "T", taskUrl: "https://x.com.br/app/tarefas?task=1", assignedByName: "Admin" } };

  test("agendado para +30 min (tarefas) com onlyIfUnread; +10 min no pedido de ajuda", async () => {
    const a = await seedOrg("a");
    const id = await notify(a, a.agent, "task_assigned", { email });
    const [job] = await jobs("dispatchNotification");
    expect(job.scheduledTime).toBe(NOW + EMAIL_SAFETY_NET_MS.tasks);
    expect((job.args[0] as any).onlyIfUnread).toEqual([id]);
    await notify(a, a.admin, "handoff_requested", {
      email: { eventType: "handoffRequested", templateData: { leadTitle: "L", leadUrl: "https://x.com.br/app/repasses" } },
    });
    const all = await jobs("dispatchNotification");
    expect(all.map((j) => j.scheduledTime).sort()).toEqual([NOW + EMAIL_SAFETY_NET_MS.attendance, NOW + EMAIL_SAFETY_NET_MS.tasks].sort());
  });

  test("lido antes do prazo → e-mail não sai; não lido → sai", async () => {
    const a = await seedOrg("a");
    const id = await notify(a, a.agent, "task_assigned", { email });
    await as(a.agent.userId).mutation(api.notifications.markRead, { organizationId: a.organizationId, notificationId: id! });
    expect(await runEmailJobsAndSeeSend()).toBe(false);

    const b = await seedOrg("b");
    await notify(b, b.agent, "task_assigned", { email });
    expect(await runEmailJobsAndSeeSend()).toBe(true);
  });

  test("tipo fora da rede de segurança passado como email é ignorado; patch nunca agenda e-mail", async () => {
    const a = await seedOrg("a");
    await notify(a, a.agent, "task_assigned", { email: { eventType: "leadAssigned", templateData: {} } });
    expect(await jobs("dispatchNotification")).toHaveLength(0);
    const co = { key: "k", telegramOnPatch: true };
    await t.run((ctx) => createNotification(ctx, { organizationId: a.organizationId, memberId: a.agent.memberId, type: "task_assigned", title: "x", coalesce: co, email }));
    await t.run((ctx) => createNotification(ctx, { organizationId: a.organizationId, memberId: a.agent.memberId, type: "task_assigned", title: "x", coalesce: co, email }));
    expect(await jobs("dispatchNotification")).toHaveLength(1);
  });

  test("prazo da tarefa encurta a espera (lembrete não chega depois do vencimento)", async () => {
    const a = await seedOrg("a");
    await notify(a, a.agent, "task_assigned", {
      type: "task_due_soon", email: { eventType: "taskDueSoon", templateData: {}, deadlineAt: NOW + 5 * 60_000 },
    });
    const [job] = await jobs("dispatchNotification");
    expect(job.scheduledTime).toBe(NOW + 5 * 60_000);
  });

  test("call site real: pedido de ajuda em broadcast agenda o e-mail de reserva por destinatário", async () => {
    const a = await seedOrg("a");
    const ai = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: a.organizationId, name: "IA", role: "ai", type: "ai", status: "active", createdAt: NOW, updatedAt: NOW,
      })
    );
    const leadId = await t.run(async (ctx) => {
      const boardId = await ctx.db.insert("boards", {
        organizationId: a.organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: NOW, updatedAt: NOW,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId: a.organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
        isClosedWon: false, isClosedLost: false, createdAt: NOW, updatedAt: NOW,
      });
      return await ctx.db.insert("leads", {
        organizationId: a.organizationId, title: "Ana Souza", boardId, stageId, value: 0, currency: "BRL",
        priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
        lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW,
      });
    });
    await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId, reason: "Cliente pediu humano", suggestedActions: [], teamMemberId: ai,
    });
    const emails = await jobs("dispatchNotification");
    // Broadcast: admin + agente (inbox:reply), cada um com o próprio aviso.
    expect(emails).toHaveLength(2);
    expect(emails.every((j) => j.scheduledTime === NOW + EMAIL_SAFETY_NET_MS.attendance)).toBe(true);
    for (const j of emails) {
      const args = j.args[0] as { recipientMemberId: Id<"teamMembers">; onlyIfUnread: Id<"notifications">[] };
      expect(args.onlyIfUnread).toHaveLength(1);
      const n = await t.run((ctx) => ctx.db.get(args.onlyIfUnread[0]));
      expect(n?.memberId).toBe(args.recipientMemberId);
      expect(n?.type).toBe("handoff_requested");
    }
  });
});

// ---------------------------------------------------------------------------
// Retenção
// ---------------------------------------------------------------------------

describe("retenção", () => {
  test("assinatura parada há > 60 dias sai com os vínculos; recente fica", async () => {
    const a = await seedOrg("a");
    vi.setSystemTime(NOW - 61 * 24 * HOUR);
    await subscribe(a, a.agent, device("velho"));
    vi.setSystemTime(NOW);
    await subscribe(a, a.admin, device("novo"));
    await t.mutation(internal.retention.internalRunRetention, { table: "pushSubscriptions", onlyTable: true, manual: true });
    expect(await subsOf(a.agent.userId)).toHaveLength(0);
    expect(await linksOf(a.agent.memberId)).toHaveLength(0);
    expect(await subsOf(a.admin.userId)).toHaveLength(1);
  });
});
