import { describe, expect, it } from "vitest";
import {
  STANDARD_ACCESS_NOTICE,
  groupMetaConfigs,
  metaConnectionState,
  metaReturnMessage,
} from "./metaConnect";

describe("metaReturnMessage", () => {
  it("maps every documented code", () => {
    for (const code of [
      "ok",
      "cancelado",
      "expirado",
      "conta_em_uso",
      "sem_permissao",
      "sem_pagina",
      "sem_papel",
      "modulo_off",
      "falha_meta",
    ]) {
      expect(metaReturnMessage(code)?.text.length).toBeGreaterThan(10);
    }
    expect(metaReturnMessage("ok")?.kind).toBe("success");
    expect(metaReturnMessage("conta_em_uso")?.text).toBe(
      "Esta conta já está conectada a outra organização."
    );
    expect(metaReturnMessage("sem_papel")?.text).toBe(STANDARD_ACCESS_NOTICE);
  });

  it("has no message for selecionar and a generic one for unknown codes", () => {
    expect(metaReturnMessage("selecionar")).toBeNull();
    expect(metaReturnMessage("xyz")?.kind).toBe("error");
  });
});

describe("metaConnectionState", () => {
  const base = { metaAuthState: "ok" as const, metaSubscribed: true, disabledByModuleAt: null };

  it("covers the auth states", () => {
    expect(metaConnectionState(base)).toEqual({ label: "Conectado", variant: "success" });
    expect(metaConnectionState({ ...base, metaAuthState: "reauth_required" }).label).toBe(
      "Precisa reconectar"
    );
    expect(metaConnectionState({ ...base, metaAuthState: "revoked" }).label).toBe("Desconectado");
  });

  it("flags an incomplete subscription and module-disabled configs", () => {
    expect(metaConnectionState({ ...base, metaSubscribed: false }).label).toBe("Conexão incompleta");
    expect(metaConnectionState({ ...base, disabledByModuleAt: 1 }).label).toBe("Desativado pelo módulo");
  });
});

describe("groupMetaConfigs", () => {
  it("groups by connection with the Page name and Messenger first", () => {
    const groups = groupMetaConfigs([
      { _id: "a", channel: "instagram", displayName: "@casa", metaConnectionId: "c1" },
      { _id: "b", channel: "messenger", displayName: "Casa Lumiar", metaConnectionId: "c1" },
      { _id: "c", channel: "messenger", displayName: "Outra", metaConnectionId: "c2" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].title).toBe("Casa Lumiar: Messenger + Instagram");
    expect(groups[0].configs.map((c) => c._id)).toEqual(["b", "a"]);
    expect(groups[1].title).toBe("Outra: Messenger");
  });

  it("keeps configs without a connection as their own group", () => {
    const groups = groupMetaConfigs([
      { _id: "a", channel: "instagram", displayName: "@x", metaConnectionId: null },
      { _id: "b", channel: "instagram", displayName: "@y", metaConnectionId: null },
    ]);
    expect(groups).toHaveLength(2);
  });
});
