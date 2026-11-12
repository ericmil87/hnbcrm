import { describe, expect, it, vi } from "vitest";
import { submitNewsletterSignup } from "./newsletter";

const input = { email: "a@b.test", source: "landing" };
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const CLOUD = "https://x.convex.cloud";

describe("submitNewsletterSignup", () => {
  it("200 ok: posta o corpo na rota pública", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true }));
    expect(await submitNewsletterSignup(input, f, CLOUD)).toEqual({ ok: true });
    expect(f.mock.calls[0][0]).toBe("https://x.convex.site/api/v1/public/newsletter");
    expect(f.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual(input);
  });
  it("invalid: usa a mensagem do servidor, ou a padrão se vier vazia", async () => {
    const f = vi.fn().mockResolvedValue(res(400, { ok: false, code: "invalid", message: "E-mail inválido." }));
    expect(await submitNewsletterSignup(input, f, CLOUD)).toEqual({ ok: false, code: "invalid", message: "E-mail inválido." });
    const g = vi.fn().mockResolvedValue(res(400, { ok: false, code: "invalid" }));
    expect(await submitNewsletterSignup(input, g, CLOUD)).toMatchObject({ message: "Confira o e-mail e tente de novo." });
  });
  it("rate_limited e unavailable usam a mensagem padrão", async () => {
    const a = vi.fn().mockResolvedValue(res(429, { ok: false, code: "rate_limited", message: "x" }));
    expect(await submitNewsletterSignup(input, a, CLOUD)).toMatchObject({
      code: "rate_limited",
      message: "Muitas tentativas em pouco tempo. Tente de novo mais tarde.",
    });
    const b = vi.fn().mockResolvedValue(res(503, { ok: false, code: "unavailable", message: "x" }));
    expect(await submitNewsletterSignup(input, b, CLOUD)).toMatchObject({
      code: "unavailable",
      message: "A inscrição está indisponível agora. Tente de novo mais tarde.",
    });
  });
  it("código desconhecido ou corpo ilegível vira error", async () => {
    const a = vi.fn().mockResolvedValue(res(500, { ok: false, code: "zzz" }));
    expect(await submitNewsletterSignup(input, a, CLOUD)).toMatchObject({ code: "error" });
    const b = vi.fn().mockResolvedValue(new Response("nada", { status: 500 }));
    expect(await submitNewsletterSignup(input, b, CLOUD)).toMatchObject({
      code: "error",
      message: "Não foi possível inscrever agora. Tente de novo mais tarde.",
    });
  });
  it("sem URL ou rede caída: unavailable/error, sem lançar", async () => {
    expect(await submitNewsletterSignup(input, vi.fn(), "")).toMatchObject({ code: "unavailable" });
    const boom = vi.fn().mockRejectedValue(new Error("rede"));
    expect(await submitNewsletterSignup(input, boom, CLOUD)).toMatchObject({ code: "error" });
  });
});
