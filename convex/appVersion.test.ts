import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const original = process.env.MIN_CLIENT_BUILD;

afterEach(() => {
  if (original === undefined) delete process.env.MIN_CLIENT_BUILD;
  else process.env.MIN_CLIENT_BUILD = original;
});

describe("appVersion.getMinClientBuild", () => {
  test("returns null when the env is unset or blank (no auth needed)", async () => {
    const t = convexTest(schema, modules);
    delete process.env.MIN_CLIENT_BUILD;
    expect(await t.query(api.appVersion.getMinClientBuild, {})).toBeNull();
    process.env.MIN_CLIENT_BUILD = "   ";
    expect(await t.query(api.appVersion.getMinClientBuild, {})).toBeNull();
  });

  test("returns the trimmed env value", async () => {
    const t = convexTest(schema, modules);
    process.env.MIN_CLIENT_BUILD = " 0.80.0 ";
    expect(await t.query(api.appVersion.getMinClientBuild, {})).toBe("0.80.0");
  });
});
