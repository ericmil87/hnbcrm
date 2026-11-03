/// <reference types="vite/client" />
/**
 * opsTelegram (F0): dryRun por padrão, URL sempre do próprio deployment,
 * saída sem token nem segredo. `fetch` stubado.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const FAKE_TOKEN = "123456:FAKE-TOKEN-ops";
const SECRET = "fake-telegram-webhook-secret-ops";
const SITE = "https://fake-deployment-123.convex.site";

let t: TestConvex<typeof schema>;
let methods: { method: string; body: Record<string, unknown> }[];

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", FAKE_TOKEN);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "hnbcrm_test_bot");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  methods = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      methods.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
      const result =
        method === "getMe"
          ? { id: 42, is_bot: true, first_name: "HNBCRM", username: "hnbcrm_test_bot" }
          : method === "getWebhookInfo"
            ? { url: `${SITE}/webhooks/telegram/platform`, pending_update_count: 3, last_error_message: "x" }
            : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }),
  );
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const noSecrets = (out: unknown) => {
  const s = JSON.stringify(out);
  expect(s).not.toContain(FAKE_TOKEN);
  expect(s).not.toContain(SECRET);
};

describe("opsTelegram", () => {
  test("setWebhook dryRun (padrão) não chama setWebhook e relata o plano", async () => {
    const out = await t.action(internal.opsTelegram.internalTelegramSetWebhook, {});
    expect(out).toMatchObject({
      dryRun: true,
      ok: true,
      url: `${SITE}/webhooks/telegram/platform`,
      allowedUpdates: ["message", "callback_query", "my_chat_member", "stopped_message_generation"],
      secretSet: true,
      botUsername: "hnbcrm_test_bot",
      usernameMatchesEnv: true,
    });
    expect(methods.map((m) => m.method)).toEqual(["getMe"]);
    noSecrets(out);
  });

  test("setWebhook real manda URL, secret_token e allowed_updates", async () => {
    const out = await t.action(internal.opsTelegram.internalTelegramSetWebhook, { dryRun: false });
    expect(out.ok).toBe(true);
    const call = methods.find((m) => m.method === "setWebhook")!;
    expect(call.body).toEqual({
      url: `${SITE}/webhooks/telegram/platform`,
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query", "my_chat_member", "stopped_message_generation"],
    });
    noSecrets(out);
  });

  test("setWebhook recusa sem segredo", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    const out = await t.action(internal.opsTelegram.internalTelegramSetWebhook, { dryRun: false });
    expect(out).toMatchObject({ ok: false, refused: "TELEGRAM_WEBHOOK_SECRET ausente", secretSet: false });
    expect(methods.some((m) => m.method === "setWebhook")).toBe(false);
  });

  test("setWebhook recusa quando o bot do token ≠ TELEGRAM_BOT_USERNAME (dryRun e real)", async () => {
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "hnbcrm_bot");
    for (const dryRun of [true, false]) {
      const out = await t.action(internal.opsTelegram.internalTelegramSetWebhook, { dryRun });
      expect(out).toMatchObject({
        dryRun,
        ok: false,
        refused: "bot ≠ TELEGRAM_BOT_USERNAME",
        botUsername: "hnbcrm_test_bot",
        usernameMatchesEnv: false,
      });
    }
    expect(methods.some((m) => m.method === "setWebhook")).toBe(false);
  });

  test("webhookInfo, getMe, setCommands e deleteWebhook", async () => {
    const info = await t.action(internal.opsTelegram.internalTelegramWebhookInfo, {});
    expect(info).toMatchObject({ ok: true, matchesExpected: true, pendingUpdateCount: 3 });
    const me = await t.action(internal.opsTelegram.internalTelegramGetMe, {});
    expect(me).toMatchObject({ ok: true, botId: 42, usernameMatchesEnv: true });

    const dryCmds = await t.action(internal.opsTelegram.internalTelegramSetCommands, {});
    expect(dryCmds.commands.map((c) => c.command)).toEqual(["ajuda", "sair"]);
    expect(methods.some((m) => m.method === "setMyCommands")).toBe(false);
    await t.action(internal.opsTelegram.internalTelegramSetCommands, { dryRun: false });
    expect(methods.find((m) => m.method === "setMyCommands")?.body).toEqual({
      commands: [
        { command: "ajuda", description: "Como usar o bot" },
        { command: "sair", description: "Desconectar este Telegram" },
      ],
    });

    await t.action(internal.opsTelegram.internalTelegramDeleteWebhook, {});
    expect(methods.some((m) => m.method === "deleteWebhook")).toBe(false);
    for (const out of [info, me, dryCmds]) noSecrets(out);
  });

  test("sem token tudo vira disabled, sem rede", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await t.action(internal.opsTelegram.internalTelegramGetMe, {});
    expect(out).toMatchObject({ ok: false, error: { kind: "disabled" } });
    expect(methods).toEqual([]);
    warn.mockRestore();
  });
});
