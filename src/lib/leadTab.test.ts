import { describe, expect, it } from "vitest";
import { LEAD_TAB_PARAM, isLeadTabInUrl, resolveLeadTab } from "./leadTab";

describe("leadTab", () => {
  it("codec lê só abas válidas e escreve o valor", () => {
    expect(LEAD_TAB_PARAM.parse("tasks")).toBe("tasks");
    expect(LEAD_TAB_PARAM.parse("campaigns")).toBe("campaigns");
    expect(LEAD_TAB_PARAM.parse("outra")).toBeNull();
    expect(LEAD_TAB_PARAM.parse(null)).toBeNull();
    expect(LEAD_TAB_PARAM.serialize("conversation")).toBe("conversation");
    expect(LEAD_TAB_PARAM.serialize(null)).toBeNull();
  });

  it("a aba só vai para a URL quando ?lead= é este lead", () => {
    expect(isLeadTabInUrl("l1", "l1")).toBe(true);
    expect(isLeadTabInUrl(null, "l1")).toBe(false);
    expect(isLeadTabInUrl("l2", "l1")).toBe(false);
  });

  it("resolve: URL válida vence; sem ela vale initialTab; fora da URL vale a local", () => {
    expect(resolveLeadTab({ inUrl: true, urlTab: "tasks", localTab: "details" })).toBe("tasks");
    expect(resolveLeadTab({ inUrl: true, urlTab: null, localTab: "details", initialTab: "details" })).toBe("details");
    expect(resolveLeadTab({ inUrl: true, urlTab: null, localTab: "conversation" })).toBe("conversation");
    expect(resolveLeadTab({ inUrl: false, urlTab: "tasks", localTab: "activity" })).toBe("activity");
  });
});
