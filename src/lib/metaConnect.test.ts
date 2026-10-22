import { describe, expect, it } from "vitest";
import {
  STANDARD_ACCESS_NOTICE,
  daysUntil,
  expiringDays,
  groupMetaConfigs,
  humanizeAuthDetail,
  metaCardView,
  metaConnectionState,
  metaReturnMessage,
  verifiedAgoLabel,
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

describe("metaReturnMessage reconnect", () => {
  it("says the connection was renewed only when reconnecting", () => {
    expect(metaReturnMessage("ok", true)?.text).toBe("Conexão renovada.");
    expect(metaReturnMessage("ok")?.text).toBe("Conta conectada com sucesso.");
    expect(metaReturnMessage("falha_meta", true)?.kind).toBe("error");
  });
});

describe("card health helpers", () => {
  const NOW = 1_000_000_000_000;
  const DAY = 86_400_000;
  const base = {
    metaAuthState: "ok" as const,
    metaSubscribed: true,
    disabledByModuleAt: null,
    metaAuthDetail: null,
    metaDataAccessExpiresAt: null,
  };

  it("computes days until expiry, rounding up and never negative", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil(NOW + 3 * DAY - 1000, NOW)).toBe(3);
    expect(daysUntil(NOW - DAY, NOW)).toBe(0);
  });

  it("detects expiring access by detail or by date", () => {
    expect(expiringDays(base, NOW)).toBeNull();
    expect(expiringDays({ ...base, metaDataAccessExpiresAt: NOW + 30 * DAY }, NOW)).toBeNull();
    expect(expiringDays({ ...base, metaDataAccessExpiresAt: NOW + 5 * DAY }, NOW)).toBe(5);
    expect(
      expiringDays({ ...base, metaAuthDetail: "data_access_expiring", metaDataAccessExpiresAt: NOW + 2 * DAY }, NOW)
    ).toBe(2);
    expect(expiringDays({ ...base, metaAuthState: "reauth_required", metaDataAccessExpiresAt: NOW + DAY }, NOW)).toBeNull();
  });

  it("humanizes the auth detail with a default", () => {
    expect(humanizeAuthDetail(null)).toContain("senha trocada");
    expect(humanizeAuthDetail("qualquer coisa")).toContain("papel perdido");
  });

  it("formats the last verification", () => {
    expect(verifiedAgoLabel(null, NOW)).toBeNull();
    expect(verifiedAgoLabel(NOW - 10_000, NOW)).toBe("Verificado agora");
    expect(verifiedAgoLabel(NOW - 30 * 60_000, NOW)).toBe("Verificado há 30min");
    expect(verifiedAgoLabel(NOW - 3 * 3_600_000, NOW)).toBe("Verificado há 3h");
    expect(verifiedAgoLabel(NOW - 2 * DAY, NOW)).toBe("Verificado há 2d");
  });

  it("picks the action and notice per state", () => {
    expect(metaCardView(base, NOW)).toEqual({ action: null, actionLabel: null, notice: null });

    const reauth = metaCardView({ ...base, metaAuthState: "reauth_required" }, NOW);
    expect(reauth.action).toBe("reconnect");
    expect(reauth.actionLabel).toBe("Reconectar");
    expect(reauth.notice?.text).toContain("A Meta invalidou a credencial");

    const revoked = metaCardView({ ...base, metaAuthState: "revoked" }, NOW);
    expect(revoked.actionLabel).toBe("Conectar de novo");
    expect(revoked.action).toBe("reconnect");

    const incomplete = metaCardView({ ...base, metaSubscribed: false }, NOW);
    expect(incomplete.action).toBe("complete");
    expect(incomplete.actionLabel).toBe("Concluir conexão");

    const expiring = metaCardView(
      { ...base, metaAuthDetail: "data_access_expiring", metaDataAccessExpiresAt: NOW + 3 * DAY },
      NOW
    );
    expect(expiring.action).toBe("reconnect");
    expect(expiring.notice?.text).toBe("Acesso expira em 3 dias. Reconecte para manter.");
    expect(
      metaCardView({ ...base, metaDataAccessExpiresAt: NOW + DAY - 1000 }, NOW).notice?.text
    ).toContain("1 dia.");
  });

  it("offers no action when disabled by the module", () => {
    expect(metaCardView({ ...base, disabledByModuleAt: 1, metaSubscribed: false }, NOW).action).toBeNull();
  });
});
