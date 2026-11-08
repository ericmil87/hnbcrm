import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disablePush, enablePush, resyncPush, type PushBackend } from "./actions";
import { readLinkedOrgs, teardownPushOnLogout } from "./subscription";
import { closeReadDeviceNotifications } from "./readOnDevice";
import { listenToServiceWorker } from "./closeReadNotifications";
import { installPushEnv, makeSub, uninstallPushEnv } from "@/test/pushEnv";

const VAPID = "AQID"; // 3 bytes, só para o applicationServerKey

function backend(): PushBackend & { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> } {
  return { subscribe: vi.fn().mockResolvedValue({}), unsubscribe: vi.fn().mockResolvedValue({ removed: true }) };
}

beforeEach(() => localStorage.clear());
afterEach(() => uninstallPushEnv());

describe("enablePush", () => {
  it("pede a permissão, assina com userVisibleOnly e manda p256dh/auth certos ao backend", async () => {
    const env = installPushEnv({ permission: "default" });
    const b = backend();
    expect(await enablePush(b, "org1", VAPID)).toBe("enabled");
    expect(env.Notification.requestPermission).toHaveBeenCalledTimes(1);
    const call = env.pushManager.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }];
    expect(call[0].userVisibleOnly).toBe(true);
    expect(Array.from(call[0].applicationServerKey)).toEqual([1, 2, 3]);
    expect(b.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        p256dh: "BPkey_-",
        auth: "authKey_-",
        platform: "desktop",
      }),
    );
    expect(readLinkedOrgs()).toEqual(["org1"]);
  });

  it("permissão negada não assina nem chama o backend", async () => {
    const env = installPushEnv({ permission: "default", requestResult: "denied" });
    const b = backend();
    expect(await enablePush(b, "org1", VAPID)).toBe("denied");
    expect(env.pushManager.subscribe).not.toHaveBeenCalled();
    expect(b.subscribe).not.toHaveBeenCalled();
  });

  it("fechar o pedido sem escolher (default) não assina", async () => {
    installPushEnv({ permission: "default", requestResult: "default" });
    const b = backend();
    expect(await enablePush(b, "org1", VAPID)).toBe("dismissed");
    expect(b.subscribe).not.toHaveBeenCalled();
  });

  it("sem suporte não pede nada", async () => {
    const b = backend();
    expect(await enablePush(b, "org1", VAPID)).toBe("unsupported");
  });
});

describe("resyncPush", () => {
  it("com assinatura no navegador, vincula de novo a org ativa (idempotente)", async () => {
    installPushEnv({ permission: "granted", subscription: makeSub() });
    const b = backend();
    expect(await resyncPush(b, "org2", VAPID)).toBe("synced");
    expect(b.subscribe).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org2", p256dh: "BPkey_-", auth: "authKey_-" }));
    expect(readLinkedOrgs()).toEqual(["org2"]);
  });

  it("sem assinatura não cria uma (a pessoa pode ter desligado)", async () => {
    const env = installPushEnv({ permission: "granted", subscription: null });
    const b = backend();
    expect(await resyncPush(b, "org1", VAPID)).toBe("idle");
    expect(env.pushManager.subscribe).not.toHaveBeenCalled();
    expect(b.subscribe).not.toHaveBeenCalled();
  });

  it("permissão revogada: desvincula as orgs, cancela a assinatura e limpa o rastro", async () => {
    const sub = makeSub();
    installPushEnv({ permission: "denied", subscription: sub });
    localStorage.setItem("hnbcrm.push.linkedOrgs", JSON.stringify(["org1", "org2"]));
    const b = backend();
    expect(await resyncPush(b, "org1", VAPID)).toBe("cleaned");
    expect(b.unsubscribe).toHaveBeenCalledTimes(2);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(readLinkedOrgs()).toEqual([]);
    expect(b.subscribe).not.toHaveBeenCalled();
  });

  it("assinatura de outra chave VAPID é refeita sem pedir permissão", async () => {
    const stale = makeSub();
    stale.options.applicationServerKey = new Uint8Array([9, 9, 9]).buffer;
    const env = installPushEnv({ permission: "granted", subscription: stale });
    await resyncPush(backend(), "org1", VAPID);
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(env.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(env.Notification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("solta o vínculo em todas as orgs vinculadas e cancela a assinatura", async () => {
    const sub = makeSub();
    installPushEnv({ permission: "granted", subscription: sub });
    localStorage.setItem("hnbcrm.push.linkedOrgs", JSON.stringify(["org1", "org2"]));
    const b = backend();
    await disablePush(b, "org1");
    expect(b.unsubscribe).toHaveBeenCalledWith({ organizationId: "org1", endpoint: sub.endpoint });
    expect(b.unsubscribe).toHaveBeenCalledWith({ organizationId: "org2", endpoint: sub.endpoint });
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(readLinkedOrgs()).toEqual([]);
  });
});

describe("logout", () => {
  it("chama unsubscribe do endpoint atual por org vinculada ANTES de cancelar no navegador", async () => {
    const sub = makeSub();
    installPushEnv({ permission: "granted", subscription: sub });
    localStorage.setItem("hnbcrm.push.linkedOrgs", JSON.stringify(["org1"]));
    const order: string[] = [];
    const unsubscribe = vi.fn(async () => {
      order.push("backend");
    });
    sub.unsubscribe.mockImplementation(async () => {
      order.push("browser");
      return true;
    });
    await teardownPushOnLogout({ unsubscribe, extraOrgIds: ["org1", "org9"] });
    expect(unsubscribe).toHaveBeenCalledWith({ organizationId: "org1", endpoint: sub.endpoint });
    expect(unsubscribe).toHaveBeenCalledWith({ organizationId: "org9", endpoint: sub.endpoint });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["backend", "backend", "browser"]);
    expect(readLinkedOrgs()).toEqual([]);
  });

  it("backend lento não segura o logout além do prazo", async () => {
    installPushEnv({ permission: "granted", subscription: makeSub() });
    const unsubscribe = vi.fn(() => new Promise<never>(() => {}));
    const t0 = Date.now();
    await teardownPushOnLogout({ unsubscribe, extraOrgIds: ["org1"], timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("sem service worker termina na hora e não falha", async () => {
    const unsubscribe = vi.fn();
    await expect(teardownPushOnLogout({ unsubscribe, extraOrgIds: ["org1"] })).resolves.toBeUndefined();
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});

describe("mensagens do service worker", () => {
  it("hnb:navigate leva ao destino validado (com acao=assumir) e descarta URL externa", () => {
    const env = installPushEnv({ permission: "granted" });
    const onNavigate = vi.fn();
    const onResubscribed = vi.fn();
    listenToServiceWorker(env.serviceWorker as never, { onNavigate, onResubscribed });
    const url = "/app/abrir?org=o1&to=" + encodeURIComponent("/app/repasses?handoff=h1") + "&acao=assumir";
    env.emit({ type: "hnb:navigate", url });
    env.emit({ type: "hnb:navigate", url: "https://evil.com/app/painel" });
    env.emit({ type: "hnb:push-resubscribed" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(url);
    expect(onResubscribed).toHaveBeenCalledTimes(1);
  });
});

describe("closeReadDeviceNotifications", () => {
  it("fecha no aparelho só as notificações já lidas da org ativa", async () => {
    const closeRead = vi.fn();
    const closeUnread = vi.fn();
    installPushEnv({
      permission: "granted",
      shown: [
        { data: { notificationId: "read1", organizationId: "org1" }, close: closeRead },
        { data: { notificationId: "unread1", organizationId: "org1" }, close: closeUnread },
      ],
    });
    const n = await closeReadDeviceNotifications({ organizationId: "org1", unreadIds: ["unread1"], unreadTotal: 1 });
    expect(n).toBe(1);
    expect(closeRead).toHaveBeenCalled();
    expect(closeUnread).not.toHaveBeenCalled();
  });
});
