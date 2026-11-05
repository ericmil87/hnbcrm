import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, SETTINGS_PANELS, PLANNED_PANEL_IDS } from "@/components/settings/registry";
import type { OrgModules } from "@/hooks/useOrgModules";
import { groupOf, groupSettingsPanels, resolveSettingsPanel, resolveSettingsPanelState, visibleSettingsPanels, type SettingsCtx } from "./settingsNav";

const NO_MODULES: OrgModules = {
  units: false, departments: false, attribution: false, central: false, demoMode: false, metaMessaging: false,
};
const ctx = (allowed: Array<[string, string]>, modules: Partial<OrgModules> = {}): SettingsCtx => ({
  can: (c, l) => allowed.some(([ac, al]) => ac === c && (al === l || (al === "manage" && l === "view"))),
  modules: { ...NO_MODULES, ...modules },
});

const MEMBER = ctx([["settings", "view"], ["team", "view"]]);
const ADMIN = ctx([["settings", "manage"], ["team", "view"]]);
const LEGACY_IDS = ["general", "ai", "apikeys", "fields", "sources", "webhooks", "channels", "data", "notifications", "central"];

describe("resolveSettingsPanel", () => {
  it("todos os ids legados resolvem para um painel (admin)", () => {
    const visible = visibleSettingsPanels(ADMIN);
    for (const id of LEGACY_IDS) expect(resolveSettingsPanel(id, visible)?.id, id).toBe(id);
  });

  it("id desconhecido ou ausente -> null", () => {
    const visible = visibleSettingsPanels(ADMIN);
    expect(resolveSettingsPanel("nao-existe", visible)).toBeNull();
    expect(resolveSettingsPanel(null, visible)).toBeNull();
    expect(resolveSettingsPanel("", visible)).toBeNull();
  });

  it("central fica invisível sem manage e sem módulo, e cai no primeiro visível do grupo", () => {
    const visible = visibleSettingsPanels(MEMBER);
    expect(visible.some((p) => p.id === "central")).toBe(false);
    expect(resolveSettingsPanel("central", visible)?.id).toBe("apikeys");
  });

  it("central aparece com algum módulo ligado ou com manage", () => {
    expect(visibleSettingsPanels(ctx([["settings", "view"]], { units: true })).some((p) => p.id === "central")).toBe(true);
    expect(visibleSettingsPanels(ADMIN).some((p) => p.id === "central")).toBe(true);
    // metaMessaging não acende a Central
    expect(visibleSettingsPanels(ctx([["settings", "view"]], { metaMessaging: true })).some((p) => p.id === "central")).toBe(false);
  });

  it("appearance é pessoal: aparece para todos, até sem permissões", () => {
    expect(visibleSettingsPanels(ADMIN).some((p) => p.id === "appearance")).toBe(true);
    expect(resolveSettingsPanel("appearance", visibleSettingsPanels(ADMIN))?.id).toBe("appearance");
    expect(visibleSettingsPanels(ctx([])).some((p) => p.id === "appearance")).toBe(true);
  });

  it("sem permissão nenhuma só resta Aparência", () => {
    const none = ctx([]);
    expect(visibleSettingsPanels(none).map((p) => p.id)).toEqual(["appearance"]);
    expect(resolveSettingsPanel("general", [])).toBeNull();
  });

  it("team só com team:view", () => {
    expect(visibleSettingsPanels(ctx([["settings", "view"]])).some((p) => p.id === "team")).toBe(false);
    expect(visibleSettingsPanels(MEMBER).find((p) => p.id === "team")?.href).toBe("/app/equipe");
  });
});

describe("registro", () => {
  it("ids únicos, grupos existentes, e cada painel tem Component ou href", () => {
    const ids = SETTINGS_PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SETTINGS_PANELS) {
      expect(SETTINGS_GROUPS.some((g) => g.id === p.group), p.id).toBe(true);
      expect(Boolean(p.Component) !== Boolean(p.href), p.id).toBe(true);
    }
  });

  it("ids reservados não colidem com os registrados", () => {
    for (const id of PLANNED_PANEL_IDS) expect(SETTINGS_PANELS.some((p) => p.id === id)).toBe(false);
  });
});

describe("groupOf / groupSettingsPanels", () => {
  it("deriva o grupo do painel", () => {
    const channels = SETTINGS_PANELS.find((p) => p.id === "channels")!;
    expect(groupOf(channels)).toEqual({ id: "whatsapp", label: "WhatsApp e canais" });
  });

  it("agrupa na ordem dos grupos e omite grupos vazios", () => {
    const groups = groupSettingsPanels(visibleSettingsPanels(MEMBER));
    expect(groups.map((g) => g.id)).toEqual(["conta", "whatsapp", "atendente", "equipe", "dados", "avancado"]);
    expect(groups[0].panels.map((p) => p.id)).toEqual(["general", "appearance", "notifications"]);
    const only = groupSettingsPanels(visibleSettingsPanels(ctx([["settings", "view"]])));
    expect(only.some((g) => g.id === "equipe")).toBe(false);
  });
});

describe("resolveSettingsPanelState", () => {
  it("painel visível não é negado", () => {
    const r = resolveSettingsPanelState("channels", visibleSettingsPanels(ADMIN));
    expect(r).toMatchObject({ denied: false });
    expect(r.panel?.id).toBe("channels");
  });

  it("painel conhecido sem permissão: denied, com substituto do grupo e o pedido", () => {
    const visible = visibleSettingsPanels(MEMBER);
    expect(visible.some((p) => p.id === "ai-models")).toBe(false);
    const r = resolveSettingsPanelState("ai-models", visible);
    expect(r.denied).toBe(true);
    expect(r.requested?.id).toBe("ai-models");
    expect(r.panel?.group).toBe("avancado");
  });

  it("desconhecido ou ausente não é negado", () => {
    const visible = visibleSettingsPanels(MEMBER);
    expect(resolveSettingsPanelState("nao-existe", visible)).toEqual({ panel: null, denied: false, requested: null });
    expect(resolveSettingsPanelState(null, visible).denied).toBe(false);
  });

  it("negado sem nenhum substituto no grupo: panel null", () => {
    const r = resolveSettingsPanelState("ai-models", []);
    expect(r).toMatchObject({ panel: null, denied: true });
  });
});
