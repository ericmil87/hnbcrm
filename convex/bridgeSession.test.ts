/// <reference types="vite/client" />
import { expect, test, describe } from "vitest";
import {
  buildBridgeStatusRequest,
  buildBridgeConnectRequest,
  buildBridgeQrRequest,
  buildBridgeProvisionRequest,
  parseBridgeStatusResponse,
  parseBridgeQrResponse,
  parseBridgeProvisionResponse,
  mapBridgeSessionState,
  phoneFromJid,
} from "./lib/bridgeSession";

const BASE = "https://wuzapi.example.com";
const TOKEN = "tok_fake_wxyz";
const ADMIN = "admin_fake_token";

describe("bridgeSession request builders", () => {
  test("status is a GET with the per-instance token header (base URL trailing slash trimmed)", () => {
    const req = buildBridgeStatusRequest({ baseUrl: `${BASE}/`, token: TOKEN });
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE}/session/status`);
    expect(req.headers.token).toBe(TOKEN);
    expect(req.body).toBeUndefined();
  });

  test("connect is a POST subscribing to Message by default", () => {
    const req = buildBridgeConnectRequest({ baseUrl: BASE, token: TOKEN });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/session/connect`);
    expect(req.headers.token).toBe(TOKEN);
    expect(JSON.parse(req.body!)).toEqual({ Subscribe: ["Message"], Immediate: false });
  });

  test("qr is a GET on /session/qr", () => {
    const req = buildBridgeQrRequest({ baseUrl: BASE, token: TOKEN });
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE}/session/qr`);
    expect(req.headers.token).toBe(TOKEN);
  });

  test("provision posts to /admin/users with the ADMIN token in Authorization", () => {
    const req = buildBridgeProvisionRequest({
      baseUrl: BASE,
      adminToken: ADMIN,
      name: "org_abc_123",
      token: "instancetoken",
      webhook: "https://deploy.convex.site/webhooks/bridge",
      hmacKey: "fake-hmac-secret-with-at-least-32-chars!",
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/admin/users`);
    expect(req.headers.Authorization).toBe(ADMIN);
    expect(req.headers.token).toBeUndefined(); // never the instance token header here
    expect(JSON.parse(req.body!)).toEqual({
      name: "org_abc_123",
      token: "instancetoken",
      webhook: "https://deploy.convex.site/webhooks/bridge",
      // Confirmado no piloto: ReadReceipt = ticks; demais são sinais de sessão
      events: "Message,ReadReceipt,LoggedOut,TemporaryBan,ClientOutdated",
      // Confirmado no piloto: sem hmacKey na criação o webhook chega sem assinatura
      hmacKey: "fake-hmac-secret-with-at-least-32-chars!",
    });
  });
});

describe("bridgeSession response parsers", () => {
  test("status: connected + logged in", () => {
    const r = parseBridgeStatusResponse(true, 200, {
      code: 200,
      success: true,
      data: { Connected: true, LoggedIn: true },
    });
    expect(r).toEqual({ ok: true, connected: true, loggedIn: true, jid: undefined });
  });

  test("status: carries the jid when present", () => {
    const r = parseBridgeStatusResponse(true, 200, {
      success: true,
      data: { Connected: true, LoggedIn: true, Jid: "5491155554444.0:52@s.whatsapp.net" },
    });
    expect(r.ok && r.jid).toBe("5491155554444.0:52@s.whatsapp.net");
  });

  test("status: 401 → readable instance-token error", () => {
    const r = parseBridgeStatusResponse(false, 401, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/instância/i);
  });

  test("status: explicit success=false is an error even on HTTP 200", () => {
    const r = parseBridgeStatusResponse(true, 200, { success: false, error: "boom" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("boom");
  });

  test("qr: extracts the data-URI QRCode", () => {
    const r = parseBridgeQrResponse(true, 200, {
      success: true,
      data: { QRCode: "data:image/png;base64,iVBORw0KGgo=" },
    });
    expect(r).toEqual({ ok: true, qrCode: "data:image/png;base64,iVBORw0KGgo=", loggedIn: false });
  });

  test("qr: logged-in session returns no QR but is still ok", () => {
    const r = parseBridgeQrResponse(true, 200, { success: true, data: { LoggedIn: true } });
    expect(r).toEqual({ ok: true, qrCode: undefined, loggedIn: true });
  });

  test("provision: { id } → ok with stringified id", () => {
    expect(parseBridgeProvisionResponse(true, 200, { id: 2 })).toEqual({ ok: true, id: "2" });
  });

  test("provision: 401 → admin-token error", () => {
    const r = parseBridgeProvisionResponse(false, 401, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/admin token/i);
  });
});

describe("phoneFromJid", () => {
  test("strips device/agent suffix and domain", () => {
    expect(phoneFromJid("5491155554444.0:52@s.whatsapp.net")).toBe("5491155554444");
    expect(phoneFromJid("15550000000@s.whatsapp.net")).toBe("15550000000");
  });
  test("undefined for empty/garbage", () => {
    expect(phoneFromJid(undefined)).toBeUndefined();
    expect(phoneFromJid("@s.whatsapp.net")).toBeUndefined();
  });
});

describe("mapBridgeSessionState", () => {
  test("connected + logged in → connected with phone in detail", () => {
    const m = mapBridgeSessionState({ connected: true, loggedIn: true, jid: "15550000000@s.whatsapp.net" });
    expect(m.state).toBe("connected");
    expect(m.phone).toBe("15550000000");
    expect(m.healthDetail).toContain("15550000000");
  });
  test("logged in but socket down → connecting", () => {
    expect(mapBridgeSessionState({ connected: false, loggedIn: true }).state).toBe("connecting");
  });
  test("not logged in with QR → qr", () => {
    const m = mapBridgeSessionState({ connected: false, loggedIn: false, hasQr: true });
    expect(m.state).toBe("qr");
    expect(m.healthDetail).toMatch(/QR/);
  });
  test("not logged in without QR → disconnected", () => {
    const m = mapBridgeSessionState({ connected: false, loggedIn: false });
    expect(m.state).toBe("disconnected");
    expect(m.healthDetail).toMatch(/Deslogado/);
  });
});
