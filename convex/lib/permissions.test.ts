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

  test("membro com permissões explícitas sem `agenda` cai no default do papel", () => {
    for (const role of ["admin", "manager", "agent", "ai"] as Role[]) {
      const p = resolvePermissions(role, LEGACY_EXPLICIT as unknown as Permissions);
      expect(p.agenda).toBe(DEFAULT_PERMISSIONS[role].agenda);
      expect(p.campaigns).toBe(DEFAULT_PERMISSIONS[role].campaigns);
      // O resto vem do que foi gravado, não do papel.
      expect(p.leads).toBe("view_own");
    }
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
