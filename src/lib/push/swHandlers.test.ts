import { describe, expect, it, vi } from "vitest";
import { GENERIC_PUSH_TITLE, buildNotification } from "./buildNotification";
import { SW_NAVIGATE_ACK_MS } from "./notificationClick";
import { openFromNotification, showPushNotification, type OpenDeps, type WindowRef } from "./swHandlers";

const ORIGIN = "https://hnbcrm.com";
const URL_ = "/app/abrir?org=o1&to=%2Fapp%2Fentrada%3Fconversation%3Dc1";

function deps(
  windows: WindowRef[],
  opts: { controlled?: string[]; ack?: boolean; navigate?: "ok" | "null" | "throw" } = {},
) {
  const calls: string[] = [];
  const d: OpenDeps<WindowRef> = {
    origin: ORIGIN,
    matchAll: vi.fn(async (inc: boolean) => (inc ? windows : windows.filter((w) => opts.controlled?.includes(w.id)))),
    askNavigate: vi.fn(async (c: WindowRef, _u: string, ms: number) => {
      calls.push(`ask:${c.id}:${ms}`);
      return opts.ack === true;
    }),
    focus: vi.fn(async (c: WindowRef) => {
      calls.push(`focus:${c.id}`);
    }),
    navigate: vi.fn(async (c: WindowRef, href: string) => {
      calls.push(`navigate:${c.id}:${href}`);
      if (opts.navigate === "throw") throw new TypeError("not controlled");
      return opts.navigate === "ok" ? c : null;
    }),
    openWindow: vi.fn(async (u: string) => {
      calls.push(`open:${u}`);
    }),
  };
  return { d, calls };
}

const win = (id: string, path = "/app/painel", extra: Partial<WindowRef> = {}): WindowRef => ({
  id,
  url: `${ORIGIN}${path}`,
  ...extra,
});

describe("openFromNotification", () => {
  it("ack from the page → focus only (no navigate, no openWindow); ask comes BEFORE focus", async () => {
    const { d, calls } = deps([win("a")], { ack: true, controlled: ["a"] });
    await openFromNotification(URL_, d);
    expect(calls).toEqual([`ask:a:${SW_NAVIGATE_ACK_MS}`, "focus:a"]);
    expect(SW_NAVIGATE_ACK_MS).toBe(250);
  });

  it("timeout with a controlled window → client.navigate (absolute) then focus", async () => {
    const { d, calls } = deps([win("a")], { controlled: ["a"], navigate: "ok" });
    await openFromNotification(URL_, d);
    expect(calls).toEqual([`ask:a:250`, `navigate:a:${ORIGIN}${URL_}`, "focus:a"]);
  });

  it.each(["null", "throw"] as const)("navigate %s → openWindow, without spending focus", async (navigate) => {
    const { d, calls } = deps([win("a")], { controlled: ["a"], navigate });
    await openFromNotification(URL_, d);
    expect(calls).toEqual([`ask:a:250`, `navigate:a:${ORIGIN}${URL_}`, `open:${URL_}`]);
  });

  it("uncontrolled window without ack → openWindow directly (no navigate, no focus)", async () => {
    const { d, calls } = deps([win("a")], { controlled: [] });
    await openFromNotification(URL_, d);
    expect(calls).toEqual([`ask:a:250`, `open:${URL_}`]);
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("no app window → openWindow at once (other origin and public pages ignored)", async () => {
    const { d, calls } = deps([{ id: "x", url: "https://evil.com/app/painel" }, win("p", "/entrar")]);
    await openFromNotification(URL_, d);
    expect(calls).toEqual([`open:${URL_}`]);
  });

  it("reuses the focused app window among several", async () => {
    const { d, calls } = deps([win("a"), win("b", "/app/entrada", { focused: true })], { ack: true });
    await openFromNotification(URL_, d);
    expect(calls).toEqual([`ask:b:250`, "focus:b"]);
  });
});

describe("showPushNotification", () => {
  const payload = {
    notification: { title: "Mensagem nova de Ana", tag: "c-1" },
    hnb: { url: "/app/painel", tag: "c-1", badge: 2, actions: [{ action: "abrir" }] },
  };
  const data = { json: () => payload };

  it("shows the built notification and applies the badge", async () => {
    const show = vi.fn(async () => {});
    const applyBadge = vi.fn(async () => {});
    await showPushNotification(data, { show, supportsActions: true, applyBadge });
    const built = buildNotification(payload, { supportsActions: true });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(built.title, built.options);
    expect(applyBadge).toHaveBeenCalledWith(2);
  });

  it("first showNotification rejects → shows the generic one", async () => {
    const show = vi.fn().mockRejectedValueOnce(new TypeError("actions")).mockResolvedValueOnce(undefined);
    await showPushNotification(data, { show, supportsActions: true, applyBadge: async () => {} });
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1][0]).toBe(GENERIC_PUSH_TITLE);
  });

  it("unreadable data → generic; badge errors never break the push", async () => {
    const show = vi.fn(async () => {});
    await showPushNotification(
      { json: () => { throw new SyntaxError("x"); } },
      { show, supportsActions: true, applyBadge: async () => { throw new Error("x"); } },
    );
    expect(show).toHaveBeenCalledWith(GENERIC_PUSH_TITLE, expect.anything());
  });

  it("a payload getter that throws inside the builder → generic", async () => {
    const evil = { get notification() { throw new Error("boom"); } };
    const show = vi.fn(async () => {});
    await showPushNotification({ json: () => evil }, { show, supportsActions: true, applyBadge: async () => {} });
    expect(show).toHaveBeenCalledWith(GENERIC_PUSH_TITLE, expect.anything());
  });
});

describe("buildNotification action names", () => {
  it("ignores inherited keys like toString/__proto__", () => {
    const b = buildNotification(
      { notification: { title: "t" }, hnb: { url: "/app/painel", actions: [{ action: "toString" }, { action: "__proto__" }, { action: "abrir" }] } },
      { supportsActions: true },
    );
    expect(b.options.actions).toEqual([{ action: "abrir", title: "Abrir" }]);
  });
});
