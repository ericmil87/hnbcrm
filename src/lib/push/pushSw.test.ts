// @vitest-environment node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { safeAppTarget } from "../openLink";
import {
  GENERIC_PUSH_TITLE,
  PUSH_BADGE_ICON,
  PUSH_ICON,
  buildNotification,
  genericNotification,
  readPushData,
} from "./buildNotification";
import { closeReadNotifications, listenToServiceWorker } from "./closeReadNotifications";
import {
  PUSH_FALLBACK_URL,
  SW_NAVIGATE,
  SW_PUSH_RESUBSCRIBED,
  notificationClick,
  pickAppClient,
  safeNotificationUrl,
} from "./notificationClick";

const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const OPEN = "/app/abrir?org=org1&to=%2Fapp%2Frepasses%3Fhandoff%3Dh1";
const ASSUMIR = `${OPEN}&acao=assumir`;

/** Shape produced by convex/lib/webPush.ts buildPushPayload (handoff with preview). */
function handoffPayload(over: Record<string, unknown> = {}) {
  return {
    web_push: 8030,
    notification: {
      title: "A IA pediu ajuda: Ana",
      body: "Quer saber o preço da vivência",
      navigate: `https://hnbcrm.com${OPEN}`,
      lang: "pt-BR",
      dir: "auto",
      tag: "h-h1",
      silent: false,
      renotify: true,
      app_badge: 3,
    },
    hnb: {
      v: 1,
      type: "handoff_requested",
      notificationId: "n1",
      organizationId: "org1",
      url: OPEN,
      path: "/app/repasses?handoff=h1",
      tag: "h-h1",
      renotify: true,
      badge: 3,
      actions: [
        { action: "assumir", title: "Assumir", url: ASSUMIR },
        { action: "abrir", title: "Abrir", url: OPEN },
      ],
      ...over,
    },
  };
}

describe("buildNotification", () => {
  it("golden: handoff with preview, actions and badge", () => {
    expect(buildNotification(handoffPayload(), { supportsActions: true })).toEqual({
      title: "A IA pediu ajuda: Ana",
      generic: false,
      appBadge: 3,
      options: {
        body: "Quer saber o preço da vivência",
        tag: "h-h1",
        renotify: true,
        lang: "pt-BR",
        dir: "auto",
        icon: PUSH_ICON,
        badge: PUSH_BADGE_ICON,
        silent: false,
        actions: [
          { action: "assumir", title: "Assumir" },
          { action: "abrir", title: "Abrir" },
        ],
        data: {
          url: OPEN,
          notificationId: "n1",
          organizationId: "org1",
          type: "handoff_requested",
          actionUrls: { assumir: ASSUMIR },
        },
      },
    });
  });

  it("without preview: no body; without actions support: no actions", () => {
    const p = handoffPayload();
    delete (p.notification as { body?: string }).body;
    const b = buildNotification(p, { supportsActions: false });
    expect(b.options.body).toBeUndefined();
    expect(b.options.actions).toBeUndefined();
    expect(b.options.data.url).toBe(OPEN);
  });

  it("never uses the absolute `navigate` and keeps no PII or extra text in data", () => {
    const b = buildNotification(handoffPayload(), { supportsActions: true });
    const json = JSON.stringify(b.options.data);
    expect(json).not.toContain("https://");
    expect(json).not.toContain("Ana");
    expect(Object.keys(b.options.data).sort()).toEqual(["actionUrls", "notificationId", "organizationId", "type", "url"]);
  });

  it("unsafe hnb.url falls back to the Painel; unsafe action url drops the action", () => {
    const b = buildNotification(
      handoffPayload({ url: "https://evil.com/app/x", actions: [{ action: "assumir", url: "//evil.com" }, { action: "x" }] }),
      { supportsActions: true },
    );
    expect(b.options.data.url).toBe(PUSH_FALLBACK_URL);
    expect(b.options.actions).toBeUndefined();
    expect(b.options.data.actionUrls).toBeUndefined();
  });

  it("renotify only with a tag; badge clamped; renotify false omitted", () => {
    const p = handoffPayload({ tag: undefined, renotify: true });
    (p.notification as { tag?: string }).tag = undefined;
    expect(buildNotification(p, { supportsActions: false }).options.renotify).toBeUndefined();
    expect(buildNotification(handoffPayload({ renotify: false }), { supportsActions: false }).options.renotify).toBeUndefined();
    expect(buildNotification(handoffPayload({ badge: 5000 }), { supportsActions: false }).appBadge).toBe(999);
    expect(buildNotification(handoffPayload({ badge: 0 }), { supportsActions: false }).appBadge).toBe(0);
  });

  it("truncates a huge title and body", () => {
    const p = handoffPayload();
    p.notification.title = "x".repeat(500);
    p.notification.body = "y".repeat(500);
    const b = buildNotification(p, { supportsActions: false });
    expect(Array.from(b.title)).toHaveLength(120);
    expect(Array.from(b.options.body!)).toHaveLength(280);
  });

  it.each([null, undefined, "texto", 42, [], {}, { notification: {} }, { notification: { title: "  " } }])(
    "unreadable payload %j → generic notification",
    (payload) => {
      const b = buildNotification(payload, { supportsActions: true });
      expect(b.generic).toBe(true);
      expect(b.title).toBe(GENERIC_PUSH_TITLE);
      expect(b.options.data).toEqual({ url: "/app/painel" });
      expect(b).toEqual(genericNotification());
    },
  );

  it("readPushData never throws", () => {
    expect(readPushData(null)).toBeNull();
    expect(readPushData({ json: () => { throw new SyntaxError("x"); } })).toBeNull();
    expect(readPushData({ json: () => ({ a: 1 }) })).toEqual({ a: 1 });
  });
});

describe("notificationClick", () => {
  const data = buildNotification(handoffPayload(), { supportsActions: true }).options.data;
  it("assumir → action URL; abrir / body click → data.url", () => {
    expect(notificationClick("assumir", data)).toBe(ASSUMIR);
    expect(notificationClick("abrir", data)).toBe(OPEN);
    expect(notificationClick("", data)).toBe(OPEN);
    expect(notificationClick(undefined, data)).toBe(OPEN);
  });
  it("assumir without its URL falls back to data.url", () => {
    expect(notificationClick("assumir", { url: OPEN })).toBe(OPEN);
  });
  it.each([
    "https://evil.com/app/x",
    "//evil.com/app/x",
    "javascript:alert(1)",
    "/app/abrir?org=o&to=//evil.com",
    "/app/abrir?org=o&to=https://evil.com",
    "/app/abrir?to=/app/painel",
    "/app/abrir?org=o&to=/app/abrir?org=o",
    "/app\\evil",
    "/f/form",
    "/",
    "/app/x\u0000",
  ])("rejects %j → Painel", (url) => {
    expect(notificationClick(undefined, { url })).toBe(PUSH_FALLBACK_URL);
    expect(notificationClick("assumir", { url, actionUrls: { assumir: url } })).toBe(PUSH_FALLBACK_URL);
  });
  it("garbage data → Painel", () => {
    expect(notificationClick(undefined, null)).toBe(PUSH_FALLBACK_URL);
    expect(notificationClick("assumir", "x")).toBe(PUSH_FALLBACK_URL);
  });
});

describe("safeNotificationUrl", () => {
  it("matches safeAppTarget for inner app paths (parity with src/lib/openLink.ts)", () => {
    for (const p of ["/app/painel", "/app/x/./y?a=1#h", "/app/tarefas?task=t1", "//x", "/app/../f/x", "/app\\x", "/app/%2e%2e/f"]) {
      expect(safeNotificationUrl(p), p).toBe(safeAppTarget(p));
    }
  });
  it("accepts /app/abrir only with org and a safe `to`", () => {
    expect(safeNotificationUrl(OPEN)).toBe(OPEN);
    expect(safeNotificationUrl(ASSUMIR)).toBe(ASSUMIR);
    expect(safeAppTarget(OPEN)).toBeNull(); // why the SW needs its own rule
  });
});

describe("pickAppClient", () => {
  const o = "https://hnbcrm.com";
  it("prefers focused, then visible, then first; only same origin under /app/", () => {
    expect(pickAppClient([], o)).toBe(-1);
    expect(pickAppClient([{ url: "https://evil.com/app/x", focused: true }, { url: `${o}/` }], o)).toBe(-1);
    expect(pickAppClient([{ url: `${o}/app/a` }, { url: `${o}/app/b`, visibilityState: "visible" }], o)).toBe(1);
    expect(pickAppClient([{ url: `${o}/app/a`, visibilityState: "visible" }, { url: `${o}/app/b`, focused: true }], o)).toBe(1);
    expect(pickAppClient([{ url: `${o}/entrar` }, { url: `${o}/app/a` }], o)).toBe(1);
  });
});

describe("closeReadNotifications", () => {
  const make = (tag: string, notificationId?: string) => ({ tag, data: notificationId ? { notificationId } : undefined, close: vi.fn() });
  it("closes by tag or by notificationId and counts", async () => {
    const list = [make("c-1", "n1"), make("h-2", "n2"), make("t-3", "n3")];
    const reg = { getNotifications: vi.fn(async () => list) };
    expect(await closeReadNotifications(reg, { tags: ["c-1"], notificationIds: ["n3"] })).toBe(2);
    expect(list[0].close).toHaveBeenCalled();
    expect(list[1].close).not.toHaveBeenCalled();
    expect(list[2].close).toHaveBeenCalled();
  });
  it("never throws and is a no-op when unsupported or empty", async () => {
    expect(await closeReadNotifications(null, { tags: ["x"] })).toBe(0);
    expect(await closeReadNotifications({}, { tags: ["x"] })).toBe(0);
    const reg = { getNotifications: vi.fn(async () => { throw new Error("x"); }) };
    expect(await closeReadNotifications(reg, { tags: ["x"] })).toBe(0);
    const reg2 = { getNotifications: vi.fn(async () => []) };
    expect(await closeReadNotifications(reg2, {})).toBe(0);
    expect(reg2.getNotifications).not.toHaveBeenCalled();
  });
});

describe("listenToServiceWorker", () => {
  function fakeContainer() {
    let l: ((e: MessageEvent) => void) | null = null;
    return {
      addEventListener: (_: "message", fn: (e: MessageEvent) => void) => (l = fn),
      removeEventListener: vi.fn(() => (l = null)),
      emit: (data: unknown, port?: { postMessage: (m: unknown) => void }) =>
        l?.({ data, ports: port ? [port] : [] } as unknown as MessageEvent),
    };
  }
  it("navigates with a re-validated URL and acks on the port", () => {
    const c = fakeContainer();
    const onNavigate = vi.fn();
    const port = { postMessage: vi.fn() };
    const off = listenToServiceWorker(c, { onNavigate });
    c.emit({ type: SW_NAVIGATE, url: OPEN }, port);
    expect(onNavigate).toHaveBeenCalledWith(OPEN);
    expect(port.postMessage).toHaveBeenCalledWith({ ok: true });
    c.emit({ type: SW_NAVIGATE, url: "//evil.com" }, port);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenLastCalledWith({ ok: false });
    off();
    expect(c.removeEventListener).toHaveBeenCalled();
  });
  it("forwards hnb:push-resubscribed and ignores the rest", () => {
    const c = fakeContainer();
    const onResubscribed = vi.fn();
    const onNavigate = vi.fn();
    listenToServiceWorker(c, { onNavigate, onResubscribed });
    c.emit({ type: SW_PUSH_RESUBSCRIBED });
    c.emit({ type: "SKIP_WAITING" });
    c.emit(null);
    expect(onResubscribed).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("service worker push handlers (source guard)", () => {
  const sw = read("src/sw.ts");
  /** Body of each `self.addEventListener("<type>", …)` up to the closing `});`. */
  const handlers = (type: string) => {
    const out: string[] = [];
    const re = new RegExp(`addEventListener\\("${type}"`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sw))) out.push(sw.slice(m.index, sw.indexOf("\n});", m.index)));
    return out;
  };
  it("every push handler shows the notification inside waitUntil", () => {
    const push = handlers("push");
    expect(push.length).toBeGreaterThan(0);
    for (const h of push) expect(h).toMatch(/waitUntil\(\s*showPush\(/);
    expect(sw).toMatch(/async function showPush[\s\S]*?showNotification\([\s\S]*?catch[\s\S]*?showNotification\(/);
  });
  it("click and subscription-change handlers use waitUntil; click closes the notification", () => {
    for (const t of ["notificationclick", "pushsubscriptionchange"]) {
      const hs = handlers(t);
      expect(hs, t).toHaveLength(1);
      expect(hs[0], t).toContain("waitUntil(");
    }
    expect(handlers("notificationclick")[0]).toContain("notification.close()");
  });
  it("makes no network calls (no fetch, no backend) and reads the relative hnb.url only", () => {
    const code = sw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|importScripts|convex\.(cloud|site)|from "convex|ConvexHttpClient|sendBeacon/);
    expect(code).not.toMatch(/\.navigate\b(?!\()/); // never reads notification.navigate (only client.navigate(...))
  });
  it("pure push modules bundled into the SW import nothing heavy", () => {
    for (const f of ["src/lib/push/buildNotification.ts", "src/lib/push/notificationClick.ts"]) {
      const imports = [...read(f).matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
      for (const i of imports) expect(i, f).toMatch(/^\.\/notificationClick$/);
    }
  });
});
