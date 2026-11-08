import { describe, expect, it } from "vitest";
import {
  blockedHelp,
  bufferToBase64Url,
  deviceDisplayName,
  pushStatusOf,
  pushStatusWithServer,
  pushSupportOf,
  urlBase64ToUint8Array,
  userAgentLabelOf,
} from "./subscription";

const ok = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, platform: "android" as const, standalone: false };

describe("pushSupportOf", () => {
  it("navegador completo é suportado", () => {
    expect(pushSupportOf(ok)).toBe("supported");
    expect(pushSupportOf({ ...ok, platform: "desktop" })).toBe("supported");
  });
  it("iPhone fora da Tela de Início precisa instalar o app, mesmo sem PushManager", () => {
    expect(pushSupportOf({ ...ok, platform: "ios", hasPushManager: false, hasNotification: false })).toBe("needs-install");
  });
  it("iPhone instalado com push é suportado; instalado sem push é não suportado", () => {
    expect(pushSupportOf({ ...ok, platform: "ios", standalone: true })).toBe("supported");
    expect(pushSupportOf({ ...ok, platform: "ios", standalone: true, hasPushManager: false })).toBe("unsupported");
  });
  it("sem API é não suportado", () => {
    expect(pushSupportOf({ ...ok, hasPushManager: false })).toBe("unsupported");
    expect(pushSupportOf({ ...ok, hasServiceWorker: false })).toBe("unsupported");
    expect(pushSupportOf({ ...ok, hasNotification: false })).toBe("unsupported");
  });
});

describe("pushStatusOf", () => {
  it("mapeia os estados do cartão", () => {
    expect(pushStatusOf({ support: "unsupported", permission: "unavailable", hasSubscription: false })).toBe("unsupported");
    expect(pushStatusOf({ support: "needs-install", permission: "default", hasSubscription: false })).toBe("needs-install");
    expect(pushStatusOf({ support: "supported", permission: "default", hasSubscription: false })).toBe("default");
    expect(pushStatusOf({ support: "supported", permission: "granted", hasSubscription: true })).toBe("subscribed");
    expect(pushStatusOf({ support: "supported", permission: "granted", hasSubscription: false })).toBe("default");
    expect(pushStatusOf({ support: "supported", permission: "denied", hasSubscription: false })).toBe("denied");
  });
});

describe("conversões base64url", () => {
  it("urlBase64ToUint8Array decodifica -/_ e o preenchimento ausente", () => {
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
  });
  it("bufferToBase64Url é o inverso, sem '=' nem '+'/'/'", () => {
    const buf = new Uint8Array([251, 255]).buffer;
    expect(bufferToBase64Url(buf)).toBe("-_8");
    expect(bufferToBase64Url(null)).toBe("");
  });
});

describe("textos por plataforma", () => {
  it("como reabrir a permissão bloqueada", () => {
    expect(blockedHelp("ios")).toContain("Ajustes › Notificações › HNBCRM");
    expect(blockedHelp("android")).toContain("cadeado");
    expect(blockedHelp("android")).toContain("Permissões");
    expect(blockedHelp("desktop")).toContain("barra");
  });
  it("nome do aparelho", () => {
    const chromeAndroid = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
    expect(userAgentLabelOf(chromeAndroid, "android")).toBe("Chrome no Android");
    const edgeWin = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0";
    expect(userAgentLabelOf(edgeWin, "desktop")).toBe("Edge no Windows");
    const safariIphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1";
    expect(userAgentLabelOf(safariIphone, "ios")).toBe("Safari no iPhone");
  });
  it("nome genérico quando não há rótulo", () => {
    expect(deviceDisplayName({ userAgentLabel: null, platform: "desktop" })).toBe("Computador");
    expect(deviceDisplayName({ userAgentLabel: "Chrome no Android", platform: "android" })).toBe("Chrome no Android");
  });
});

describe("pushStatusWithServer", () => {
  it("ligado exige que o servidor conheça o aparelho nesta org", () => {
    expect(pushStatusWithServer("subscribed", [{ isCurrent: true, linkedHere: true }])).toBe("subscribed");
    expect(pushStatusWithServer("subscribed", [{ isCurrent: true, linkedHere: false }])).toBe("default");
    expect(pushStatusWithServer("subscribed", [])).toBe("default");
    expect(pushStatusWithServer("subscribed", undefined)).toBe("subscribed");
    expect(pushStatusWithServer("denied", [])).toBe("denied");
  });
});
