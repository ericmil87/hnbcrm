// @vitest-environment node
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ROUTE_PERMISSIONS,
  PUBLIC_API_ROUTES,
  PERMISSION_DENIED_MESSAGE,
  requireRoutePermission,
  routeKey,
} from "./router";
import {
  DEFAULT_PERMISSIONS,
  getLevelsForCategory,
  type PermissionCategory,
  type Permissions,
} from "./lib/permissions";

/**
 * Guard de build do enforcement de permissão da API REST (v0.47): toda rota
 * `/api/v1/*` autenticada por `X-API-Key` precisa declarar a permissão exigida
 * em `ROUTE_PERMISSIONS` E chamar `requireRoutePermission` no handler. Rota
 * nova sem entrada no mapa (ou sem o gate) quebra a suíte — precedente de teste
 * que lê o fonte: `convex/secretScan.test.ts`.
 */

const ROUTER_PATH = path.join(__dirname, "router.ts");
const ROUTER_SOURCE = readFileSync(ROUTER_PATH, "utf8");

interface RegisteredRoute {
  method: string;
  path: string;
  key: string;
  /** Corpo da chamada `http.route({...})` — usado para inspecionar o handler. */
  block: string;
}

/** Extrai do fonte de `router.ts` todas as rotas registradas em `http.route`. */
function parseRegisteredRoutes(source: string): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  const marker = "http.route({";
  const starts: number[] = [];
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    starts.push(i);
  }
  for (let i = 0; i < starts.length; i++) {
    const block = source.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : source.length);
    const header = /http\.route\(\{\s*path:\s*"([^"]+)",\s*method:\s*"([^"]+)"/.exec(block);
    if (!header) continue;
    const [, routePath, method] = header;
    routes.push({ method, path: routePath, key: routeKey(method, routePath), block });
  }
  return routes;
}

const REGISTERED = parseRegisteredRoutes(ROUTER_SOURCE);
/** Rotas de negócio: `/api/v1/*` fora do preflight CORS. */
const V1_ROUTES = REGISTERED.filter((r) => r.path.startsWith("/api/v1") && r.method !== "OPTIONS");
const PUBLIC_SET = new Set(PUBLIC_API_ROUTES);
const AUTHENTICATED = V1_ROUTES.filter((r) => !PUBLIC_SET.has(r.key));

/** Permissões de uma chave sem NENHUM acesso (todos os níveis em "none"). */
const NO_PERMISSIONS: Permissions = {
  leads: "none",
  contacts: "none",
  inbox: "none",
  tasks: "none",
  reports: "none",
  team: "none",
  settings: "none",
  auditLogs: "none",
  apiKeys: "none",
};

describe("completude do mapa rota → permissão", () => {
  test("o fonte do router foi parseado (sanidade do extrator)", () => {
    expect(REGISTERED.length).toBeGreaterThan(100);
    expect(V1_ROUTES.length).toBeGreaterThan(70);
    expect(AUTHENTICATED.length).toBeGreaterThan(60);
  });

  test("toda rota /api/v1 autenticada tem entrada em ROUTE_PERMISSIONS", () => {
    const semEntrada = AUTHENTICATED.filter((r) => !ROUTE_PERMISSIONS[r.key]).map((r) => r.key);
    expect(semEntrada).toEqual([]);
  });

  test("toda entrada de ROUTE_PERMISSIONS corresponde a uma rota registrada", () => {
    const registradas = new Set(V1_ROUTES.map((r) => r.key));
    const orfas = Object.keys(ROUTE_PERMISSIONS).filter((key) => !registradas.has(key));
    expect(orfas).toEqual([]);
  });

  test("toda rota autenticada chama requireRoutePermission com a própria chave", () => {
    const semGate = AUTHENTICATED.filter(
      (r) => !r.block.includes(`requireRoutePermission(`) ||
        !r.block.includes(`, "${r.method}", "${r.path}")`)
    ).map((r) => r.key);
    expect(semGate).toEqual([]);
  });

  test("as rotas públicas declaradas existem e não pedem chave de API", () => {
    const registradas = new Set(V1_ROUTES.map((r) => r.key));
    for (const key of PUBLIC_API_ROUTES) {
      expect(registradas.has(key), `rota pública inexistente: ${key}`).toBe(true);
    }
    const publicasComChave = V1_ROUTES.filter(
      (r) => PUBLIC_SET.has(r.key) && r.block.includes("authenticateApiKey(")
    ).map((r) => r.key);
    expect(publicasComChave).toEqual([]);
  });

  test("nenhuma rota ficou com o gate antigo denyDataOps", () => {
    const chamadas = ROUTER_SOURCE.match(/denyDataOps\s*\(/g) ?? [];
    expect(chamadas).toEqual([]);
  });
});

describe("validade dos pares categoria:nível", () => {
  const CATEGORIES: PermissionCategory[] = [
    "leads",
    "contacts",
    "inbox",
    "tasks",
    "reports",
    "team",
    "settings",
    "auditLogs",
    "apiKeys",
  ];

  test("toda categoria usada existe em lib/permissions", () => {
    for (const [key, required] of Object.entries(ROUTE_PERMISSIONS)) {
      if (required === "authenticated") continue;
      expect(CATEGORIES, `categoria inválida em ${key}`).toContain(required.category);
    }
  });

  test("todo nível usado pertence à hierarquia da sua categoria e não é \"none\"", () => {
    for (const [key, required] of Object.entries(ROUTE_PERMISSIONS)) {
      if (required === "authenticated") continue;
      const niveis = getLevelsForCategory(required.category);
      expect(niveis, `nível inválido em ${key}`).toContain(required.level);
      expect(required.level, `nível "none" não protege nada em ${key}`).not.toBe("none");
    }
  });

  test('"authenticated" (key válida basta) é restrito às rotas onde o app usa requireAuth puro', () => {
    const sentinela = Object.keys(ROUTE_PERMISSIONS)
      .filter((key) => ROUTE_PERMISSIONS[key] === "authenticated")
      .sort();
    expect(sentinela).toEqual([
      "GET /api/v1/notifications/preferences",
      "GET /api/v1/team-members",
      "PUT /api/v1/notifications/preferences",
    ]);
  });
});

describe("sanidade dos mapeamentos-chave", () => {
  test("export e import exigem settings:manage (regra do plano v0.46)", () => {
    const dataOps = Object.keys(ROUTE_PERMISSIONS).filter((key) =>
      / \/api\/v1\/(exports|imports)/.test(key)
    );
    expect(dataOps).toHaveLength(12);
    for (const key of dataOps) {
      expect(ROUTE_PERMISSIONS[key], key).toEqual({ category: "settings", level: "manage" });
    }
  });

  test("a captura universal de lead exige o nível de criação do app (leads.createLead)", () => {
    expect(ROUTE_PERMISSIONS["POST /api/v1/inbound/lead"]).toEqual({
      category: "leads",
      level: "edit_own",
    });
  });

  test("apagar lead exige leads:full, como leads.deleteLead", () => {
    expect(ROUTE_PERMISSIONS["POST /api/v1/leads/delete"]).toEqual({
      category: "leads",
      level: "full",
    });
  });

  test("aceitar/rejeitar repasse exige inbox:reply, como handoffs.acceptHandoff", () => {
    expect(ROUTE_PERMISSIONS["POST /api/v1/handoffs/accept"]).toEqual({
      category: "inbox",
      level: "reply",
    });
    expect(ROUTE_PERMISSIONS["POST /api/v1/handoffs/reject"]).toEqual({
      category: "inbox",
      level: "reply",
    });
  });

  test("gravar arquivo exige leads:edit_own, como files.saveFile", () => {
    expect(ROUTE_PERMISSIONS["POST /api/v1/files"]).toEqual({
      category: "leads",
      level: "edit_own",
    });
  });

  test("auditoria exige auditLogs:view e o painel exige reports:view", () => {
    expect(ROUTE_PERMISSIONS["GET /api/v1/audit-logs"]).toEqual({
      category: "auditLogs",
      level: "view",
    });
    expect(ROUTE_PERMISSIONS["GET /api/v1/dashboard"]).toEqual({
      category: "reports",
      level: "view",
    });
  });
});

describe("comportamento do gate requireRoutePermission", () => {
  test("admin passa em todas as rotas mapeadas", () => {
    const negadas = Object.keys(ROUTE_PERMISSIONS).filter((key) => {
      const [method, routePath] = key.split(" ");
      return (
        requireRoutePermission({ permissions: DEFAULT_PERMISSIONS.admin }, method, routePath) !==
        null
      );
    });
    expect(negadas).toEqual([]);
  });

  test("chave sem permissão alguma recebe 403 com a mensagem padrão", async () => {
    const denied = requireRoutePermission(
      { permissions: NO_PERMISSIONS },
      "GET",
      "/api/v1/leads"
    );
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
    expect(await denied!.json()).toEqual({ error: PERMISSION_DENIED_MESSAGE, code: 403 });
  });

  test('toda rota mapeada nega uma chave sem permissão alguma (exceto as "authenticated")', () => {
    const liberadas = Object.keys(ROUTE_PERMISSIONS)
      .filter((key) => {
        const [method, routePath] = key.split(" ");
        return requireRoutePermission({ permissions: NO_PERMISSIONS }, method, routePath) === null;
      })
      .sort();
    // Só as self-scoped/requireAuth-puro passam com key válida sem níveis.
    expect(liberadas).toEqual([
      "GET /api/v1/notifications/preferences",
      "GET /api/v1/team-members",
      "PUT /api/v1/notifications/preferences",
    ]);
  });

  test("rota fora do mapa é negada (fail-closed)", () => {
    const denied = requireRoutePermission(
      { permissions: DEFAULT_PERMISSIONS.admin },
      "POST",
      "/api/v1/rota-que-nao-existe"
    );
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });
});
