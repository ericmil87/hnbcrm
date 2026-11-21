// @vitest-environment node
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OPENAPI_SPEC } from "./openapiSpec";
import { SCHEDULING_WEBHOOK_EVENTS } from "./openapiScheduling";
import { ROUTE_PERMISSIONS } from "./router";

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

// Agenda v2 (I1): a spec das rotas /api/v1/scheduling/* tem de casar com `ROUTE_PERMISSIONS` e com a porta de webhooks.
describe("openapiSpec: agenda v2", () => {
  const spec = JSON.parse(OPENAPI_SPEC);
  const operations = Object.entries(spec.paths as Record<string, Record<string, any>>)
    .filter(([p]) => p.startsWith("/api/v1/scheduling/"))
    .flatMap(([p, methods]) => Object.entries(methods).map(([method, o]) => ({ key: `${method.toUpperCase()} ${p}`, op: o })));

  test("toda operação /scheduling tem entrada em ROUTE_PERMISSIONS (e vice-versa), citada na descrição", () => {
    const scheduling = Object.keys(ROUTE_PERMISSIONS).filter((k) => k.includes("/api/v1/scheduling/")).sort();
    expect(operations.map((o) => o.key).sort()).toEqual(scheduling);
    for (const { key, op } of operations) {
      const perm = ROUTE_PERMISSIONS[key];
      if (perm === "authenticated") throw new Error(key);
      expect(op.description, key).toContain(`agenda: ${perm.level}`);
      expect(op.operationId, key).toBeTruthy();
    }
  });

  test("operationId único na spec inteira", () => {
    const ids: string[] = [];
    for (const methods of Object.values(spec.paths as Record<string, Record<string, any>>)) {
      for (const o of Object.values(methods)) if (o.operationId) ids.push(o.operationId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("todo $ref aponta para um schema ou resposta que existe", () => {
    const text = OPENAPI_SPEC;
    for (const m of text.matchAll(/"\$ref": "#\/components\/(schemas|responses)\/(\w+)"/g)) {
      expect(spec.components[m[1]][m[2]], m[0]).toBeDefined();
    }
  });

  test("escritas documentam 409 estruturado; marcar documenta a idempotência", () => {
    const book = spec.paths["/api/v1/scheduling/appointments/book"].post;
    expect(book.responses["409"]).toBeDefined();
    expect(book.description).toMatch(/Idempotency-Key/);
    expect(book.parameters[0].name).toBe("Idempotency-Key");
    const err = spec.components.schemas.SchedRulesError.properties;
    expect(Object.keys(err).sort()).toEqual(["alternatives", "code", "error", "violations"]);
    expect(Object.keys(spec.components.schemas.SchedViolation.properties).sort()).toEqual(["code", "message", "severity"]);
    expect(spec.components.schemas.Slot.properties.reasonCodes).toBeDefined();
  });

  test("os eventos de webhook documentados são EXATAMENTE os que a porta emite", () => {
    const portSources = ["lib/schedBookingEffects.ts", "lib/schedBookingOps.ts", "lib/schedExceptionOps.ts"].map((f) => readFileSync(path.join(__dirname, f), "utf8")).join("\n");
    const typeBlock = /export type AppointmentWebhookEvent =([\s\S]*?);\n/.exec(readFileSync(path.join(__dirname, "lib/schedBookingEffects.ts"), "utf8"))![1];
    const emitted = [...typeBlock.matchAll(/"(appointment\.[a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(Object.keys(spec.webhooks).sort()).toEqual(emitted);
    expect(SCHEDULING_WEBHOOK_EVENTS.slice().sort()).toEqual(emitted);
    // nenhum evento `appointment.*` fora da lista tipada é emitido por string solta
    const loose = [...portSources.matchAll(/event: "(appointment\.[a-z_]+)"/g)].map((m) => m[1]);
    for (const e of loose) expect(emitted).toContain(e);
  });
});

// Webhooks de agenda: não há lista fechada de eventos assináveis no backend (`webhooks.events` é texto livre; casa por nome
// exato ou "*"), então o que importa é a lista DOCUMENTADA (tela de desenvolvedores e llms-full) conter os dois grupos.
describe("webhooks assináveis: calendar_event.* e appointment.*", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
  const emitted = [
    ...[...read("lib/calendarCore.ts").matchAll(/event: "(calendar_event\.[a-z_]+)"/g)].map((m) => m[1]),
    ...SCHEDULING_WEBHOOK_EVENTS,
  ];
  test("os eventos emitidos estão na página de desenvolvedores e no llms-full", () => {
    const page = read("../src/pages/DevelopersPage.tsx");
    const llms = read("llmsTxt.ts");
    expect(new Set(emitted).size).toBeGreaterThanOrEqual(16);
    for (const e of new Set(emitted)) {
      expect(page, `DevelopersPage sem ${e}`).toContain(`"${e}"`);
      expect(llms, `llmsTxt sem ${e}`).toContain(`| ${e} |`);
    }
  });
  test("o backend não restringe o nome do evento (qualquer nome ou * é aceito e casa por igualdade)", () => {
    expect(read("webhooks.ts")).toMatch(/events: v\.array\(v\.string\(\)\)/);
    expect(read("lib/webhookDispatch.ts")).toContain('w.events.includes(event) || w.events.includes("*")');
  });
});
