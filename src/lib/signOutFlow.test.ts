import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGN_OUT_TIMEOUT_MS, createSignOutGuard, withTimeout, loginReturnState, postLoginTarget } from "./signOutFlow";

describe("createSignOutGuard", () => {
  it("ignora o segundo toque enquanto sai (sem duplo teardown)", async () => {
    const g = createSignOutGuard();
    const task = vi.fn().mockResolvedValue(undefined);
    const [a, b] = await Promise.all([g.run(task), g.run(task)]);
    expect([a, b]).toEqual([true, false]);
    expect(task).toHaveBeenCalledTimes(1);
    expect(g.busy).toBe(true);
  });
  it("falha libera para tentar de novo", async () => {
    const g = createSignOutGuard();
    expect(await g.run(() => Promise.reject(new Error("x")))).toBe(false);
    expect(g.busy).toBe(false);
    expect(await g.run(async () => undefined)).toBe(true);
  });
});

describe("loginReturnState", () => {
  it("guarda caminho, query e hash; saída voluntária não guarda", () => {
    expect(loginReturnState("/app/tarefas", "?task=1", "", false)).toEqual({ from: "/app/tarefas?task=1" });
    expect(loginReturnState("/app/tarefas", "?task=1", "", true)).toBeUndefined();
  });
});

describe("postLoginTarget", () => {
  it("volta ao destino seguro, inclusive /app/abrir", () => {
    expect(postLoginTarget({ from: "/app/entrada?conversation=c1" })).toBe("/app/entrada?conversation=c1");
    expect(postLoginTarget({ from: "/app/abrir?org=o1&to=%2Fapp%2Ftarefas%3Ftask%3D1" })).toBe("/app/abrir?org=o1&to=%2Fapp%2Ftarefas%3Ftask%3D1");
  });
  it.each([null, undefined, {}, { from: "//evil.com" }, { from: "https://evil.com/app/x" }, { from: "/entrar" }, { from: "/app/abrir?to=/app/x" }, { from: 5 }])(
    "cai em /app para %j",
    (state) => {
      expect(postLoginTarget(state)).toBe("/app");
    },
  );
});

describe("signOut que nunca responde (offline)", () => {
  afterEach(() => vi.useRealTimers());
  it("estoura em 5 s, libera o guard e permite tentar de novo", async () => {
    vi.useFakeTimers();
    const g = createSignOutGuard();
    const never = () => new Promise<void>(() => undefined);
    const result = g.run(async () => {
      await withTimeout(never(), SIGN_OUT_TIMEOUT_MS);
    });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS - 1);
    expect(g.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(g.busy).toBe(false);
    expect(await g.run(async () => undefined)).toBe(true);
  });
  it("resposta a tempo passa direto", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(7), 5000)).resolves.toBe(7);
  });
});
