import { describe, expect, test } from "vitest";
import { OPENAPI_SPEC } from "./openapiSpec";

// A spec é servida como TEXTO em GET /api/v1/openapi.json. Uma aspa escapada (`\"`) dentro do
// template literal vira aspa crua no JSON e quebra TODO cliente OpenAPI (aconteceu na v0.65:
// a descrição do reject de handoff ficou inválida até a v0.69 sem ninguém notar).
describe("openapiSpec", () => {
  test("OPENAPI_SPEC é JSON válido com paths", () => {
    const spec = JSON.parse(OPENAPI_SPEC);
    expect(spec.openapi ?? spec.swagger).toBeTruthy();
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(10);
  });
});
