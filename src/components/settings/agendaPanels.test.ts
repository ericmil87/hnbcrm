import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, SETTINGS_PANELS } from "./registry";
import type { OrgModules } from "@/hooks/useOrgModules";
import { groupSettingsPanels, resolveSettingsPanel, visibleSettingsPanels, type SettingsCtx } from "@/lib/settingsNav";
import { resolvePermissions, hasPermission, type Role } from "../../../convex/lib/permissions";

const NO_MODULES: OrgModules = {
  units: false, departments: false, attribution: false, central: false, demoMode: false, metaMessaging: false, telegram: false, translation: false, scheduling: false,
};
const ctxFor = (role: Role, scheduling: boolean, explicit?: Parameters<typeof resolvePermissions>[1]): SettingsCtx => {
  const perms = resolvePermissions(role, explicit);
  return { can: (c, l) => hasPermission(perms, c, l), modules: { ...NO_MODULES, scheduling } };
};

const AGENDA_IDS = ["agenda", "agenda-services", "agenda-resources", "agenda-closures", "agenda-automation"];
const idsOf = (ctx: SettingsCtx) => visibleSettingsPanels(ctx).filter((p) => p.group === "agenda").map((p) => p.id);

describe("painéis da Agenda v2 no registro", () => {
  it("grupo Agenda existe e tem os 5 painéis, cada um com componente próprio", () => {
    expect(SETTINGS_GROUPS.find((g) => g.id === "agenda")?.label).toBe("Agenda");
    const panels = SETTINGS_PANELS.filter((p) => p.group === "agenda");
    expect(panels.map((p) => p.id)).toEqual(AGENDA_IDS);
    for (const p of panels) {
      expect(p.Component, p.id).toBeDefined();
      expect(p.permission, p.id).toEqual({ category: "agenda", level: "manage" });
    }
  });

  it("com o módulo ligado, quem tem agenda:manage vê os 5", () => {
    expect(idsOf(ctxFor("admin", true))).toEqual(AGENDA_IDS);
  });

  it("com o módulo desligado, só o painel de ligar aparece", () => {
    expect(idsOf(ctxFor("admin", false))).toEqual(["agenda"]);
  });

  it("sem agenda:manage nenhum painel da Agenda aparece, com ou sem módulo", () => {
    for (const role of ["manager", "agent"] as const) {
      expect(idsOf(ctxFor(role, true)), role).toEqual([]);
      expect(idsOf(ctxFor(role, false)), role).toEqual([]);
    }
    expect(idsOf(ctxFor("admin", true, { agenda: "edit" } as never))).toEqual([]);
  });

  it("painel escondido cai no primeiro visível do mesmo grupo", () => {
    const visible = visibleSettingsPanels(ctxFor("admin", false));
    const resolved = resolveSettingsPanel("agenda-services", visible);
    expect(resolved?.id).toBe("agenda");
  });

  it("agrupa depois do Atendente IA e antes da Equipe", () => {
    const groups = groupSettingsPanels(visibleSettingsPanels(ctxFor("admin", true))).map((g) => g.id);
    expect(groups.indexOf("agenda")).toBe(groups.indexOf("atendente") + 1);
    expect(groups.indexOf("agenda")).toBeLessThan(groups.indexOf("equipe"));
  });

  it("quem não tem acesso à Agenda não ganha nada: os painéis visíveis são os de antes", () => {
    const ids = visibleSettingsPanels(ctxFor("agent", false)).map((p) => p.id);
    expect(ids.some((id) => id.startsWith("agenda"))).toBe(false);
  });

  it("a busca acha os painéis pelos termos do plano e da especificação", () => {
    const has = (word: string) => SETTINGS_PANELS.filter((p) => p.group === "agenda" && p.keywords?.some((k) => k.includes(word))).map((p) => p.id);
    expect(has("regras de sugestão")).toEqual(["agenda-automation"]);
    expect(has("política da ia")).toEqual(["agenda-automation"]);
    expect(has("horários e exceções")).toEqual(["agenda-closures"]);
  });
});
