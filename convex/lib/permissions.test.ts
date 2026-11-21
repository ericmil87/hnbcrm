import { describe, expect, test } from "vitest";
import {
  CATEGORY_LABELS,
  completeLegacyPermissions,
  DEFAULT_PERMISSIONS,
  getLevelsForCategory,
  hasPermission,
  resolvePermissions,
  type Permissions,
  type Role,
} from "./permissions";

/** Permissões explícitas gravadas ANTES de existirem `campaigns` e `agenda`. */
const LEGACY_EXPLICIT = {
  leads: "view_own",
  contacts: "view",
  inbox: "view_own",
  tasks: "view_own",
  reports: "none",
  team: "none",
  settings: "none",
  auditLogs: "none",
  apiKeys: "none",
} as const;

describe("categoria agenda", () => {
  test("hierarquia, rótulo e defaults por papel", () => {
    expect(getLevelsForCategory("agenda")).toEqual(["none", "view_own", "view_all", "edit", "manage"]);
    expect(CATEGORY_LABELS.agenda).toBe("Agenda");
    expect(DEFAULT_PERMISSIONS.admin.agenda).toBe("manage");
    expect(DEFAULT_PERMISSIONS.manager.agenda).toBe("edit");
    expect(DEFAULT_PERMISSIONS.agent.agenda).toBe("edit");
    expect(DEFAULT_PERMISSIONS.ai.agenda).toBe("edit");
  });

  test("permissões explícitas sem `agenda` derivam do `tasks` EXPLÍCITO do membro; campaigns cai no default", () => {
    const cases: Array<[string, string]> = [["none", "none"], ["view_own", "view_own"], ["view_all", "view_all"], ["edit_own", "edit"], ["edit_all", "edit"], ["full", "edit"]];
    for (const role of ["admin", "manager", "agent", "ai"] as Role[]) {
      for (const [tasks, agenda] of cases) {
        const p = resolvePermissions(role, { ...LEGACY_EXPLICIT, tasks } as unknown as Permissions);
        expect(p.agenda).toBe(agenda);
        expect(p.campaigns).toBe(DEFAULT_PERMISSIONS[role].campaigns);
        expect(p.leads).toBe("view_own");
      }
    }
    // atendente sem Tarefas não ganha Agenda aberta
    expect(hasPermission(resolvePermissions("agent", { ...LEGACY_EXPLICIT, tasks: "none" } as unknown as Permissions), "agenda", "view_own")).toBe(false);
  });

  test("sem `tasks` no explícito: default do papel; sem permissões gravadas: default do papel", () => {
    const { tasks: _t, ...semTasks } = LEGACY_EXPLICIT;
    expect(resolvePermissions("agent", semTasks as unknown as Permissions).agenda).toBe("edit");
    expect(resolvePermissions("admin", semTasks as unknown as Permissions).agenda).toBe("manage");
    expect(resolvePermissions("agent", null).agenda).toBe("edit");
  });

  test("`agenda` explícito vence o default (inclusive none)", () => {
    const none = resolvePermissions("admin", { ...LEGACY_EXPLICIT, agenda: "none" } as unknown as Permissions);
    expect(none.agenda).toBe("none");
    expect(hasPermission(none, "agenda", "view_own")).toBe(false);
    const own = resolvePermissions("agent", { ...LEGACY_EXPLICIT, agenda: "view_own" } as unknown as Permissions);
    expect(hasPermission(own, "agenda", "view_own")).toBe(true);
    expect(hasPermission(own, "agenda", "view_all")).toBe(false);
  });

  test("sem permissões explícitas: níveis do papel respeitam a hierarquia", () => {
    const agent = resolvePermissions("agent", null);
    expect(hasPermission(agent, "agenda", "edit")).toBe(true);
    expect(hasPermission(agent, "agenda", "manage")).toBe(false);
    expect(hasPermission(resolvePermissions("admin", undefined), "agenda", "manage")).toBe(true);
  });
});

describe("completeLegacyPermissions (chave de API legada sem agenda)", () => {
  const base = { leads: "none", contacts: "none", inbox: "none", reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none" } as const;
  const expected: Array<[string, string]> = [
    ["none", "none"],
    ["view_own", "view_own"],
    ["view_all", "view_all"],
    ["edit_own", "edit"],
    ["edit_all", "edit"],
    ["full", "edit"],
  ];

  test.each(expected)("tasks %s vira agenda %s", (tasks, agenda) => {
    expect(completeLegacyPermissions({ ...base, tasks } as any).agenda).toBe(agenda);
  });

  test("nunca concede manage e nunca mexe nas outras categorias", () => {
    for (const [tasks] of expected) {
      const out = completeLegacyPermissions({ ...base, tasks } as any);
      expect(out.agenda).not.toBe("manage");
      expect({ ...out, agenda: undefined }).toEqual({ ...base, tasks, agenda: undefined });
    }
  });

  test("quem já tem agenda volta igual (idempotente, inclusive none)", () => {
    const p = { ...base, tasks: "full", agenda: "none" } as any;
    expect(completeLegacyPermissions(p)).toBe(p);
    expect(completeLegacyPermissions(completeLegacyPermissions({ ...base, tasks: "edit_own" } as any)).agenda).toBe("edit");
  });

  test("valor inesperado de tasks fecha (none)", () => {
    expect(completeLegacyPermissions({ ...base, tasks: "xyz" } as any).agenda).toBe("none");
  });
});

describe("agenda derivada para quem configura a organização", () => {
  test("edit derivado + settings manage vira manage; abaixo de edit não promove", async () => {
    const { promoteAgendaForSettingsManager, resolvePermissions, DEFAULT_PERMISSIONS } = await import("./permissions");
    expect(promoteAgendaForSettingsManager("edit", "manage")).toBe("manage");
    expect(promoteAgendaForSettingsManager("edit", "view")).toBe("edit");
    expect(promoteAgendaForSettingsManager("view_all", "manage")).toBe("view_all");
    expect(promoteAgendaForSettingsManager("none", "manage")).toBe("none");
    expect(promoteAgendaForSettingsManager(undefined, "manage")).toBeUndefined();
    const { agenda: _a, campaigns: _c, ...gravadas } = DEFAULT_PERMISSIONS.admin;
    expect(resolvePermissions("admin", gravadas).agenda).toBe("manage");
    expect(resolvePermissions("admin", { ...gravadas, settings: "view" }).agenda).toBe("edit");
    expect(resolvePermissions("admin", { ...gravadas, tasks: "none" }).agenda).toBe("none");
  });
});

describe("A3e: uma derivação só (membro e chave de API legada)", () => {
  const levels = ["none", "view_own", "view_all", "edit_own", "edit_all", "full"] as const;
  const settingsLevels = ["none", "view", "manage"] as const;
  const base = { leads: "none", contacts: "none", inbox: "none", reports: "none", team: "none", auditLogs: "none", apiKeys: "none" } as const;

  test.each(levels.flatMap((tasks) => settingsLevels.map((settings) => [tasks, settings] as const)))(
    "tasks %s + settings %s: chave legada e membro resolvem a MESMA agenda",
    (tasks, settings) => {
      const stored = { ...base, tasks, settings } as any;
      const viaKey = completeLegacyPermissions(stored).agenda;
      const viaMember = resolvePermissions("agent", stored).agenda;
      expect(viaKey).toBe(viaMember);
    }
  );

  test("settings manage + edição em tarefas promove a manage também na chave; sem settings manage continua edit", () => {
    expect(completeLegacyPermissions({ ...base, tasks: "edit_all", settings: "manage" } as any).agenda).toBe("manage");
    expect(completeLegacyPermissions({ ...base, tasks: "full", settings: "view" } as any).agenda).toBe("edit");
    expect(completeLegacyPermissions({ ...base, tasks: "view_all", settings: "manage" } as any).agenda).toBe("view_all");
  });
});
