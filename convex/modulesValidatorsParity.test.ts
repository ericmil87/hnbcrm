// @vitest-environment node
/**
 * Guard: o `convex-test` NÃO valida `returns`, e o runtime do Convex recusa campo a mais num
 * `v.object`. Todo validator de retorno que enumera módulos precisa ter exatamente as chaves da fonte
 * (`GATED_MODULES` / `OrgModuleKey`), senão a query lança para toda org em produção.
 */
import { describe, expect, test } from "vitest";
import { gatedFeaturesValidator, minPlanForValidator } from "./billing";
import { modulesReturn } from "./orgModules";
import { buildMyEntitlements } from "./lib/billingViews";
import { GATED_MODULES } from "./lib/plans";
import { MODULE_LABELS } from "./lib/orgModules";
import { orgModulesValidator } from "./schema";

const keys = (validator: unknown) => Object.keys((validator as { fields: Record<string, unknown> }).fields).sort();

describe("validators de retorno que listam módulos", () => {
  test("billing.ts: features e minPlanFor = GATED_MODULES", () => {
    expect(keys(gatedFeaturesValidator)).toEqual([...GATED_MODULES].sort());
    expect(keys(minPlanForValidator)).toEqual([...GATED_MODULES].sort());
  });

  test("buildMyEntitlements devolve exatamente as chaves dos validators", () => {
    const view = buildMyEntitlements({ settings: { timezone: "UTC", currency: "BRL" } } as never, false);
    expect(Object.keys(view.features).sort()).toEqual(keys(gatedFeaturesValidator));
    expect(Object.keys(view.minPlanFor).sort()).toEqual(keys(minPlanForValidator));
  });

  test("getOrgModules: modulesReturn = módulos de settings.modules + demoMode", () => {
    expect(keys(modulesReturn)).toEqual([...Object.keys(MODULE_LABELS), "demoMode"].sort());
    expect(keys(orgModulesValidator)).toEqual(Object.keys(MODULE_LABELS).sort());
  });
});
