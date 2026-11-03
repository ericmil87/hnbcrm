/// <reference types="vite/client" />
/**
 * v0.78 — reconnect the bridge WhatsApp from Telegram. Gateway (`/session/*`)
 * and Bot API stubbed by URL path; fake timers drive the 4 s watcher.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { createNotification } from "./lib/notify";
import { encryptSecret } from "./lib/secretCrypto";
import { RECONNECT_COPY } from "./telegramReconnect";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const SECRET = "fake-telegram-webhook-secret-rc";
const CHAT = 9601;
const TEST_KEY = btoa("A".repeat(32));
const GW = "https://gw.example.test";

type Call = { method: string; body: any; at: number };
let calls: Call[];
let gwCalls: string[];
let nextMessageId: number;
let gw: { loggedInAfterStatus: number; statusCount: number; qrSequence: string[]; pairCode: string | null };
let t: TestConvex<typeof schema>;

const QR_A = "data:image/png;base64,iVBORw0KGgoAAAA=";
const QR_B = "data:image/png;base64,iVBORw0KGgoBBBB=";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:FAKE-TOKEN-rc");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "hnbcrm_test_bot");
  vi.stubEnv("APP_URL", "https://app.example.test");
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  calls = [];
  gwCalls = [];
  nextMessageId = 800;
  gw = { loggedInAfterStatus: Number.POSITIVE_INFINITY, statusCount: 0, qrSequence: [QR_A], pairCode: "ABCD1234" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.startsWith(GW)) {
        const p = new URL(url).pathname;
        gwCalls.push(p);
        if (p === "/session/status") {
          gw.statusCount++;
          const loggedIn = gw.statusCount >= gw.loggedInAfterStatus;
          return json({ success: true, data: { Connected: loggedIn, LoggedIn: loggedIn, Jid: loggedIn ? "5511987654321:1@s.whatsapp.net" : "" } });
        }
        if (p === "/session/connect") return json({ success: true, data: { details: "Connected!" } });
        if (p === "/session/pairphone") {
          return gw.pairCode ? json({ code: 200, success: true, data: { LinkingCode: gw.pairCode } }) : json({ success: false, error: "no session" }, 500);
        }
        if (p === "/session/qr") {
          const qr = gw.qrSequence.length > 1 ? gw.qrSequence.shift()! : gw.qrSequence[0]!;
          return json({ success: true, data: { QRCode: qr } });
        }
        return json({ success: true, data: {} });
      }
      if (url.includes("api.telegram.org")) {
        const method = url.split("/").pop() ?? "";
        let body: any = null;
        if (init?.body instanceof FormData) {
          const fields: Record<string, unknown> = {};
          init.body.forEach((val, k) => {
            fields[k] = typeof val === "string" ? val : { name: (val as File).name, size: (val as File).size };
          });
          body = { ...fields, chat_id: Number(fields.chat_id) };
        } else if (typeof init?.body === "string") body = JSON.parse(init.body);
        calls.push({ method, body, at: Date.now() });
        const result = method.startsWith("send") ? { message_id: nextMessageId++ } : true;
        return json({ ok: true, result });
      }
      return json({ ok: true });
    }),
  );
  for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
const of = (method: string) => calls.filter((c) => c.method === method && c.body?.chat_id === CHAT);
const sends = () => of("sendMessage");
const edits = () => of("editMessageText");
const buttons = (c: Call) =>
  ((c.body.reply_markup?.inline_keyboard ?? JSON.parse(c.body.reply_markup ?? "{}").inline_keyboard ?? []) as any[][])
    .flat()
    .map((b) => b.callback_data ?? b.url ?? b.copy_text?.text);
/** Advance one watcher tick at a time (no full drain: it would jump to the window's end). */
async function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(4_000);
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(opts: { role?: "admin" | "agent"; email?: boolean; state?: string; provider?: "bridge" | "meta"; phone?: boolean; discreet?: boolean } = {}) {
  const tokenEnc = await encryptSecret("instance-token-fake");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", opts.email === false ? {} : { email: "eric@acme.test" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Acme Corp",
      slug: "acme",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { telegram: true },
        telegram: { ...(opts.discreet ? { discreet: true } : {}) },
      },
      createdAt: now,
      updatedAt: now,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Eric Milfont", role: opts.role ?? "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const channelConfigId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: opts.provider ?? "bridge", displayName: "Principal", status: "active",
      ...(opts.provider === "meta"
        ? { phoneNumberId: "pn" }
        : { bridgeBaseUrl: GW, bridgeTokenEncrypted: tokenEnc, bridgeInstanceId: "inst-1" }),
      ...(opts.phone === false ? {} : { bridgePhone: "5511987654321" }),
      bridgeSessionState: (opts.state ?? "logged_out") as any,
      createdAt: now,
      updatedAt: now,
    } as any);
    const linkId = await ctx.db.insert("telegramLinks", {
      organizationId, teamMemberId: memberId, userId, chatId: CHAT, telegramUserId: CHAT, status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      assistant: {
        mode: "suggest", suggestOnEvents: false, autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: false, replyCustomer: false },
      },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 },
      linkedAt: now, lastSeenAt: now,
    });
    await ctx.db.insert("telegramChats", {
      chatId: CHAT, telegramUserId: CHAT, activeOrganizationId: organizationId, activeTeamMemberId: memberId, updatedAt: now,
    });
    // The channel_session_lost card already in the chat (what `rc:` is tapped on).
    const notificationId = await ctx.db.insert("notifications", {
      organizationId, memberId, type: "channel_session_lost", title: "WhatsApp caiu", body: "Sessão encerrada",
      data: { channelConfigId, state: opts.state ?? "logged_out" }, createdAt: now,
    } as any);
    await ctx.db.insert("telegramDeliveries", {
      organizationId, linkId, chatId: CHAT, messageId: 700, kind: "notification", notificationId, sentAt: now,
    });
    return { organizationId, memberId, channelConfigId, linkId, userId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

let seq = 9100;
async function tap(messageId: number, data: string) {
  const res = await t.fetch("/webhooks/telegram/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      update_id: seq++,
      callback_query: { id: `cb${seq}`, from: { id: CHAT }, message: { message_id: messageId, date: 1, chat: { id: CHAT, type: "private" } }, data },
    }),
  });
  expect(res.status).toBe(200);
  // Process the tap + the start action (not the watcher ticks).
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}
const rowOf = (s: Seed) =>
  t.run((ctx) => ctx.db.query("telegramReconnects").withIndex("by_channel_config", (q) => q.eq("channelConfigId", s.channelConfigId)).first());
const audits = (event: string) =>
  t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => (a.metadata as any)?.event === event));

describe("cartão do canal caído", () => {
  test("logged_out: botão 🔄 Reconectar com o id do canal", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      await createNotification(ctx, {
        organizationId: s.organizationId, memberId: s.memberId, type: "channel_session_lost", title: "WhatsApp caiu",
        body: "Sessão encerrada", data: { channelConfigId: s.channelConfigId, state: "logged_out" },
      });
    });
    await drain();
    expect(buttons(sends()[0])).toContain(`rc:${s.channelConfigId}`);
  });

  test("temporarily_banned: sem Reconectar", async () => {
    const s = await seed({ state: "temporarily_banned" });
    await t.run(async (ctx) => {
      await createNotification(ctx, {
        organizationId: s.organizationId, memberId: s.memberId, type: "channel_session_lost", title: "WhatsApp bloqueado",
        body: "Banido", data: { channelConfigId: s.channelConfigId, state: "temporarily_banned" },
      });
    });
    await drain();
    expect(buttons(sends()[0]).some((b) => String(b).startsWith("rc:"))).toBe(false);
  });
});

describe("reconexão por código (padrão)", () => {
  test("caminho feliz: código XXXX-XXXX → loggedIn no 3º status → conectado, health check, presença, auditorias, token limpo", async () => {
    const s = await seed();
    gw.loggedInAfterStatus = 3; // 1 = start probe, 2 = 1st tick, 3 = 2nd tick
    await tap(700, `rc:${s.channelConfigId}`);
    expect(gwCalls).toEqual(["/session/status", "/session/connect", "/session/pairphone"]);
    const codeCard = edits().at(-1)!;
    expect(codeCard.body.text).toContain("<code>ABCD-1234</code>");
    expect(codeCard.body.text).toContain("Conectar com número de telefone");
    expect(buttons(codeCard)).toEqual(expect.arrayContaining(["ABCD-1234", `rcq:${s.channelConfigId}`, `rcx:${s.channelConfigId}`]));
    expect((await rowOf(s))!.token).toBeDefined();
    await tick(2);
    const done = edits().at(-1)!;
    expect(done.body.text).toMatch(/^✅ <b>WhatsApp \(…4321\) conectado<\/b> · \d\d:\d\d/);
    const config = await t.run((ctx) => ctx.db.get(s.channelConfigId));
    expect(config!.bridgeSessionState).toBe("connected");
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.filter((j) => j.name.includes("internalBridgeApplyPresence"))).toHaveLength(2);
    expect(await audits("channel.reconnect_requested")).toHaveLength(1);
    expect(await audits("channel.reconnect_succeeded")).toHaveLength(1);
    const row = await rowOf(s);
    expect(row!.token).toBeUndefined();
    // The audit never carries the code, the token or the URL.
    const all = JSON.stringify(await t.run((ctx) => ctx.db.query("auditLogs").collect()));
    expect(all).not.toContain("ABCD");
    expect(all).not.toContain("instance-token-fake");
    expect(all).not.toContain(GW);
  });

  test("expira: código sem login em 150 s → cartão de código vencido; a tentativa conta", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    await tick(40);
    expect(edits().at(-1)!.body.text).toMatch(/^⌛ <b>O código venceu\.<\/b>/);
    expect(buttons(edits().at(-1)!)).toContain(`rc:${s.channelConfigId}`);
    const row = await rowOf(s);
    expect(row!.attempts).toBe(1);
    expect(row!.token).toBeUndefined();
    expect(await audits("channel.reconnect_expired")).toHaveLength(1);
  });

  test("cancelar: '✖ Reconexão cancelada' + Tentar de novo; o watcher para", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    await tap(700, `rcx:${s.channelConfigId}`);
    expect(edits().at(-1)!.body.text).toBe("✖ Reconexão cancelada.");
    expect(buttons(edits().at(-1)!)).toContain(`rc:${s.channelConfigId}`);
    const before = gwCalls.length;
    await tick(3);
    expect(gwCalls.length).toBe(before);
  });

  test("4ª tentativa na hora: cartão de limite com a próxima hora", async () => {
    const s = await seed();
    await t.run((ctx) =>
      ctx.db.insert("telegramReconnects", {
        organizationId: s.organizationId, channelConfigId: s.channelConfigId, hourStart: Date.now() - 10 * 60_000, attempts: 3, updatedAt: Date.now(),
      }),
    );
    await tap(700, `rc:${s.channelConfigId}`);
    expect(sends().at(-1)!.body.text).toContain("Já foram 3 tentativas nesta hora.");
    expect(sends().at(-1)!.body.text).toContain("Próxima às 15:50"); // 18:00 UTC = 15:00 local; window opened 10 min ago
    expect(gwCalls).toEqual([]);
  });

  test("sem settings:manage: cópia de permissão do §4.10", async () => {
    const s = await seed({ role: "agent" });
    await tap(700, `rc:${s.channelConfigId}`);
    expect(sends().at(-1)!.body.text).toMatch(/^🚫 Você não tem permissão para isso/);
    expect(gwCalls).toEqual([]);
  });

  test("membro sem conta com e-mail: recusado", async () => {
    const s = await seed({ email: false });
    await tap(700, `rc:${s.channelConfigId}`);
    expect(sends().at(-1)!.body.text).toContain("exige uma conta com e-mail");
    expect(gwCalls).toEqual([]);
  });

  test("estados que não reconectam (temporarily_banned, outdated) e Meta: cartão de não permitido, nada no gateway", async () => {
    for (const [opts, expected] of [
      [{ state: "temporarily_banned" }, "banido temporariamente"],
      [{ state: "outdated" }, "não pode ser reconectado daqui"],
      [{ provider: "meta" as const }, "não pode ser reconectado pelo Telegram"],
    ] as const) {
      calls = [];
      t = convexTest(schema, modules);
      const s = await seed(opts as any);
      await tap(700, `rc:${s.channelConfigId}`);
      expect(edits().at(-1)!.body.text).toContain(expected);
    }
    expect(gwCalls).toEqual([]);
  });

  test("canal sem telefone (self-hosted): cai no QR sozinho, com a linha explicando", async () => {
    const s = await seed({ phone: false });
    await tap(700, `rc:${s.channelConfigId}`);
    expect(gwCalls).not.toContain("/session/pairphone");
    expect(edits().some((e) => e.body.text === RECONNECT_COPY.noPhoneQr)).toBe(true);
    expect(of("sendPhoto")).toHaveLength(1);
  });

  test("watcher zumbi (token antigo) para em silêncio", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    const before = { gw: gwCalls.length, tg: calls.length };
    await t.action(internal.telegramReconnect.internalWatchReconnect, { channelConfigId: s.channelConfigId, token: "token-antigo" });
    expect(gwCalls.length).toBe(before.gw);
    expect(calls.length).toBe(before.tg);
  });
});

describe("reconexão por QR", () => {
  test("foto por upload com protect_content; editMessageMedia só quando o QR muda; foto apagada ao conectar", async () => {
    const s = await seed();
    gw.qrSequence = [QR_A, QR_A, QR_B];
    await tap(700, `rc:${s.channelConfigId}`);
    await tap(700, `rcq:${s.channelConfigId}`);
    const photo = of("sendPhoto")[0]!;
    expect(photo.body.protect_content).toBe("true");
    expect(photo.body.photo.name).toBe("qr.png");
    expect(String(photo.body.caption)).toContain("QR do WhatsApp (…4321)");
    const qrMessageId = nextMessageId - 1;
    await tick(1); // same QR → no edit
    expect(of("editMessageMedia")).toHaveLength(0);
    await tick(1); // QR_B → one edit
    expect(of("editMessageMedia")).toHaveLength(1);
    gw.loggedInAfterStatus = gw.statusCount + 1;
    await tick(1);
    expect(of("deleteMessage").map((c) => c.body.message_id)).toContain(qrMessageId);
    expect(edits().at(-1)!.body.text).toMatch(/conectado<\/b>/);
    // Switching code → QR inside one attempt does not cost another attempt.
    expect((await rowOf(s))!.attempts).toBe(1);
    // The QR is never stored.
    expect(JSON.stringify(await rowOf(s))).not.toContain("base64");
  });

  test("revogar o vínculo apaga a foto do QR (≤ 48 h)", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    await tap(700, `rcq:${s.channelConfigId}`);
    const qrMessageId = nextMessageId - 1;
    await t.mutation(internal.telegram.internalRevokeLinksForMember, { teamMemberId: s.memberId, actorId: s.memberId });
    await tick(1);
    await t.finishInProgressScheduledFunctions();
    expect(of("deleteMessage").map((c) => c.body.message_id)).toContain(qrMessageId);
  });

  test("modo discreto: o código não oferece QR e rcq: é recusado", async () => {
    const s = await seed({ discreet: true });
    await tap(700, `rc:${s.channelConfigId}`);
    expect(buttons(edits().at(-1)!).some((b) => String(b).startsWith("rcq:"))).toBe(false);
    await tap(700, `rcq:${s.channelConfigId}`);
    expect(sends().at(-1)!.body.text).toContain("modo discreto o QR fica desligado");
    expect(of("sendPhoto")).toHaveLength(0);
  });
});


describe("revisão v0.78", () => {
  test("#1 rcq: repetido na tentativa: um connect/QR só e a janela não cresce", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    const startedAt = (await rowOf(s))!.startedAt!;
    await tap(700, `rcq:${s.channelConfigId}`);
    const qrCalls = () => gwCalls.filter((p) => p === "/session/qr").length;
    expect(qrCalls()).toBe(1);
    await tap(700, `rcq:${s.channelConfigId}`);
    expect(qrCalls()).toBe(1);
    // The reply waits for its pacing slot (1 s after the photo).
    vi.advanceTimersByTime(1_100);
    await t.finishInProgressScheduledFunctions();
    expect(sends().at(-1)!.body.text).toContain("O QR já está logo abaixo");
    const row = (await rowOf(s))!;
    expect(row.until).toBe(startedAt + 180_000);
    expect(row.attempts).toBe(1);
  });

  test("#2 rc: de outro admin durante a tentativa: recusado com o nome de quem está reconectando", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    const OTHER = 9602;
    await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { email: "ana@acme.test" });
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, userId, name: "Ana Paula", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      const link = (await ctx.db.get(s.linkId))!;
      const { _id, _creationTime, ...rest } = link;
      void _id;
      void _creationTime;
      const linkId = await ctx.db.insert("telegramLinks", { ...rest, teamMemberId: memberId, userId, chatId: OTHER, telegramUserId: OTHER });
      await ctx.db.insert("telegramChats", { chatId: OTHER, telegramUserId: OTHER, activeOrganizationId: s.organizationId, activeTeamMemberId: memberId, updatedAt: now });
      await ctx.db.insert("telegramDeliveries", { organizationId: s.organizationId, linkId, chatId: OTHER, messageId: 701, kind: "notification", sentAt: now });
    });
    const before = gwCalls.length;
    await t.fetch("/webhooks/telegram/platform", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
      body: JSON.stringify({
        update_id: seq++,
        callback_query: { id: `cb${seq}`, from: { id: OTHER }, message: { message_id: 701, date: 1, chat: { id: OTHER, type: "private" } }, data: `rc:${s.channelConfigId}` },
      }),
    });
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1);
      await t.finishInProgressScheduledFunctions();
    }
    const refusal = calls.filter((c) => c.method === "sendMessage" && c.body?.chat_id === OTHER).at(-1)!;
    expect(refusal.body.text).toMatch(/^⏳ Eric Milfont já está reconectando este número desde \d\d:\d\d\. Aguarde ou peça que cancele\.$/);
    expect(gwCalls.length).toBe(before);
    expect((await rowOf(s))!.chatId).toBe(CHAT);
  });

  test("#2 nova tentativa no mesmo chat: a foto antiga vai embora", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    await tap(700, `rcq:${s.channelConfigId}`);
    const qrMessageId = nextMessageId - 1;
    await tap(700, `rc:${s.channelConfigId}`);
    expect(of("deleteMessage").map((c) => c.body.message_id)).toContain(qrMessageId);
    // The QR step left the session in "qr": a new attempt is still accepted (no "não pode" card).
    expect(edits().some((e) => /não pode ser reconectado/.test(e.body.text))).toBe(false);
  });

  test("#3 permissão perdida no meio: QR apagado e cartão 'interrompida'", async () => {
    const s = await seed();
    await tap(700, `rc:${s.channelConfigId}`);
    await tap(700, `rcq:${s.channelConfigId}`);
    const qrMessageId = nextMessageId - 1;
    await t.run((ctx) => ctx.db.patch(s.memberId, { role: "agent" }));
    await tick(2);
    expect(of("deleteMessage").map((c) => c.body.message_id)).toContain(qrMessageId);
    expect(edits().some((e) => e.body.message_id === 700 && e.body.text === "✖ Reconexão interrompida.")).toBe(true);
    expect((await rowOf(s))!.token).toBeUndefined();
  });

  test("#4 id de canal de outra org no callback: não encontrado, nada no gateway", async () => {
    const s = await seed();
    const foreign = await t.run(async (ctx) => {
      const now = Date.now();
      const org = await ctx.db.insert("organizations", { name: "Beta", slug: "beta", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now });
      return await ctx.db.insert("channelConfigs", {
        organizationId: org, channel: "whatsapp", provider: "bridge", displayName: "Beta", status: "active",
        bridgeBaseUrl: GW, bridgeSessionState: "logged_out", createdAt: now, updatedAt: now,
      } as any);
    });
    await tap(700, `rc:${foreign}`);
    expect(sends().at(-1)!.body.text).toContain("Não encontrei este item");
    expect(gwCalls).toEqual([]);
    void s;
  });

  test("#5 erro do gateway na partida: a tentativa volta (3 soluços não travam a hora)", async () => {
    const s = await seed();
    gw.pairCode = null; // pairphone → 500
    for (let i = 0; i < 4; i++) await tap(700, `rc:${s.channelConfigId}`);
    expect(edits().at(-1)!.body.text).toBe(RECONNECT_COPY.gatewayDown);
    expect((await rowOf(s))!.attempts).toBe(0);
    expect(sends().some((c) => /Já foram 3 tentativas/.test(c.body.text))).toBe(false);
    // The alerted state is untouched by a code-mode failure (review #8).
    expect((await t.run((ctx) => ctx.db.get(s.channelConfigId)))!.bridgeSessionState).toBe("logged_out");
  });
});
