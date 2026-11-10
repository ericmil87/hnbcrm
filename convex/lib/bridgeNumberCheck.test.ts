import { afterEach, describe, expect, test, vi } from "vitest";
import { checkBridgeNumber } from "./bridgeNumberCheck";

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** wuzapi falso: `/user/check` devolve `jid`; `/user/lid/{p}` devolve `lidJid` para `lidFor`. */
function gw(opts: { checkJid?: string; lidFor?: string; lidJid?: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/user/check")) {
        const body = JSON.parse(String(init?.body));
        return json(200, {
          success: true,
          data: { Users: [{ Query: (body.Phone as string[])[0], IsInWhatsapp: true, JID: opts.checkJid ?? "161495166009388@lid" }] },
        });
      }
      const m = url.match(/\/user\/lid\/(\d+)$/);
      if (m && opts.lidFor === m[1]) return json(200, { success: true, data: { jid: opts.lidJid } });
      return json(404, { success: false, error: "LID not found" });
    })
  );
}

const args = { baseUrl: "https://wuzapi.example.com", token: "t", phone: "5531990001234" };

describe("checkBridgeNumber: o telefone canônico tem de ser grafia do número perguntado", () => {
  test("grafia legítima (12 dígitos) via /user/lid → ok", async () => {
    gw({ lidFor: "553190001234", lidJid: "553190001234@s.whatsapp.net" });
    expect(await checkBridgeNumber(args)).toMatchObject({ ok: true, onWhatsapp: true, canonicalPhone: "553190001234" });
  });

  test("/user/lid devolve telefone de OUTRA pessoa → inconclusivo (ok:false), nunca canonicalPhone", async () => {
    gw({ lidFor: "553190001234", lidJid: "5511987654321@s.whatsapp.net" });
    const r = await checkBridgeNumber(args);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("5511987654321");
  });

  test("/user/check devolve JID de telefone de outra pessoa → inconclusivo", async () => {
    gw({ checkJid: "5511987654321@s.whatsapp.net" });
    expect((await checkBridgeNumber(args)).ok).toBe(false);
  });

  test("número não-BR: só vale o próprio número", async () => {
    gw({ checkJid: "15550000001@s.whatsapp.net" });
    expect(await checkBridgeNumber({ ...args, phone: "15550000001" })).toMatchObject({ ok: true, canonicalPhone: "15550000001" });
    gw({ checkJid: "15550000002@s.whatsapp.net" });
    expect((await checkBridgeNumber({ ...args, phone: "15550000001" })).ok).toBe(false);
  });
});
