/**
 * Cliente da Bot API (D12/D13): fallback para texto puro quando o Telegram não
 * consegue ler o HTML, e `sentCount` para retomar um envio em blocos. `fetch`
 * stubado, token falso.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { editMessageText, sendMessageChunks } from "./telegramApi";

type Call = { method: string; body: Record<string, any> };
let calls: Call[];

function stubFetch(respond: (call: Call, index: number) => { status: number; json: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call = { method: String(url).split("/").pop() ?? "", body: JSON.parse(String(init?.body ?? "{}")) };
      calls.push(call);
      const r = respond(call, calls.length - 1);
      return new Response(JSON.stringify(r.json), { status: r.status });
    }),
  );
}

const PARSE_ERROR = {
  status: 400,
  json: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unexpected end tag at byte offset 9" },
};
const OK = { status: 200, json: { ok: true, result: { message_id: 1 } } };

beforeEach(() => {
  calls = [];
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:FAKE-TOKEN-api");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fallback de 'can't parse entities'", () => {
  test("sendMessage repete UMA vez sem parse_mode, tags removidas e entidades decodificadas", async () => {
    stubFetch((c) => (c.body.parse_mode ? PARSE_ERROR : OK));
    const res = await sendMessageChunks({ chatId: 1, chunks: ["<b>a &amp; b</i>"] });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.parse_mode).toBe("HTML");
    expect(calls[1].body.parse_mode).toBeUndefined();
    expect(calls[1].body.text).toBe("a & b");
  });

  test("não repete em outro 400 nem em texto puro", async () => {
    stubFetch(() => ({ status: 400, json: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }));
    const res = await sendMessageChunks({ chatId: 1, chunks: ["<b>x</b>"] });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
    calls = [];
    stubFetch(() => PARSE_ERROR);
    await sendMessageChunks({ chatId: 1, chunks: ["x"], parseMode: null });
    expect(calls).toHaveLength(1);
  });

  test("editMessageText faz o mesmo fallback", async () => {
    stubFetch((c) => (c.body.parse_mode ? PARSE_ERROR : { status: 200, json: { ok: true, result: true } }));
    const res = await editMessageText({ chatId: 1, messageId: 9, text: "<s>a <b>b</s></b>" });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => [c.method, c.body.parse_mode, c.body.text])).toEqual([
      ["editMessageText", "HTML", "<s>a <b>b</s></b>"],
      ["editMessageText", undefined, "a b"],
    ]);
  });
});

describe("envio em blocos", () => {
  test("falha no meio devolve quantos blocos já saíram", async () => {
    stubFetch((_c, i) =>
      i === 1
        ? { status: 429, json: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } } }
        : OK,
    );
    const res = await sendMessageChunks({ chatId: 1, chunks: ["a", "b", "c"] });
    expect(res).toMatchObject({ ok: false, kind: "rate_limited", retryAfterSeconds: 3, sentCount: 1 });
  });
});
