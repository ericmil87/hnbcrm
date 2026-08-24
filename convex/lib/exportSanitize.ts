/**
 * Denylist central de segredos do export (plano de export/import, seções 7 e 8).
 *
 * Puro (sem deps Convex, sem deps npm) para ser testável isoladamente. Todo
 * documento que sai da organização — hoje o backup completo JSON — passa por
 * `sanitizeDocument()` antes de ser serializado, e o teste de build
 * `convex/exportSecurity.test.ts` re-escaneia o resultado com
 * `findSecretPaths()`: se um campo proibido escapar, o build quebra (mesmo
 * espírito do `convex/secretScan.test.ts`).
 *
 * Duas camadas:
 *  1. **Padrão de nome** — qualquer chave que contenha `secret`, `token`,
 *     `keyHash`, `apiKey`, `password`, `credential`, `privateKey` ou
 *     `encrypted` (sem caixa/pontuação) é removida, em qualquer profundidade.
 *  2. **Caminho explícito** — `<tabela>.<campo>[.<campo>…]` da DENY_PATHS, para
 *     o que não casa por nome (ex.: `teamMembers.userId`, que liga o backup à
 *     tabela de auth).
 */

/** Tabelas que NUNCA entram no backup completo (seção 7 do plano). */
export const EXCLUDED_BACKUP_TABLES: readonly string[] = [
  "apiKeys",
  "orgSecrets",
  "channelConfigs",
  "aiReplyQueue",
  "aiPacing",
  "channelPacing",
  "agentRuns",
  "agentEvals",
  "copilotThreads",
  "copilotMessages",
  "pendingActions",
  "notifications",
  "notificationPreferences",
  "onboardingProgress",
  "scheduledMessages",
  "forms",
  "formSubmissions",
  "formPartials",
  "formExperiments",
  "formExperimentVariants",
  "files",
  "leadDocuments",
  "auditLogs",
  "exportJobs",
  "importJobs",
  "importJobBatches",
  "users",
  "authAccounts",
  "authSessions",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
];

/**
 * Padrões de nome de campo proibidos (aplicados ao nome normalizado — minúsculo
 * e sem pontuação, de modo que `access_token`, `accessToken` e `Access-Token`
 * caem todos no mesmo teste).
 */
export const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /secret/,
  /token/,
  /keyhash/,
  /apikey/,
  /password/,
  /passwd/,
  /credential/,
  /privatekey/,
  /encrypted/,
];

/**
 * Caminhos removidos independentemente do nome do campo.
 * Um caminho cobre a si mesmo e tudo abaixo dele.
 */
export const DENY_PATHS: readonly string[] = [
  // Segredo de assinatura do webhook (redundante com o padrão `secret`, mantido
  // explícito porque é o caso citado no plano).
  "webhooks.secret",
  // Vínculo com a tabela de auth — o backup não expõe contas de usuário.
  "teamMembers.userId",
  // Rota BYO de LLM: aponta para a chave cifrada em `orgSecrets`.
  "organizations.settings.aiConfig.providerConfig.byo",
];

const MAX_DEPTH = 24;

/** minúsculas, só letras e dígitos (`access_token` → `accesstoken`). */
export function normalizeFieldName(key: string): string {
  return String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `true` se o nome do campo casa com a denylist de padrões. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (normalized === "") return false;
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** `true` se o caminho (ou um ancestral dele) está na DENY_PATHS. */
export function isDeniedPath(path: string): boolean {
  if (!path) return false;
  return DENY_PATHS.some((denied) => path === denied || path.startsWith(`${denied}.`));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copia `value` removendo recursivamente tudo que casa com a denylist.
 * `path` é o caminho do valor (itens de array herdam o caminho do array, de modo
 * que `webhooks.secret` vale tanto para o doc solto quanto para a lista).
 */
export function sanitizeValue(value: unknown, path = "", depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, path, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const childPath = path ? `${path}.${key}` : key;
      if (isSecretKey(key) || isDeniedPath(childPath)) continue;
      out[key] = sanitizeValue(child, childPath, depth + 1);
    }
    return out;
  }
  return value;
}

/** Sanitiza um documento de `table` (o nome da tabela ancora os DENY_PATHS). */
export function sanitizeDocument(
  table: string,
  doc: Record<string, unknown>
): Record<string, unknown> {
  return sanitizeValue(doc, table) as Record<string, unknown>;
}

/** Sanitiza o mapa `{ tabela: [docs] }` inteiro de uma vez. */
export function sanitizeEntities(
  entities: Record<string, Array<Record<string, unknown>>>
): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [table, docs] of Object.entries(entities ?? {})) {
    out[table] = (docs ?? []).map((doc) => sanitizeDocument(table, doc));
  }
  return out;
}

/**
 * Varredura de verificação: devolve os caminhos que AINDA violam a denylist.
 * Um backup sanitizado tem que devolver `[]` — é o que o teste de build cobra.
 */
export function findSecretPaths(value: unknown, path = "", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const hits: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) hits.push(...findSecretPaths(item, path, depth + 1));
    return hits;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isSecretKey(key) || isDeniedPath(childPath)) {
        hits.push(childPath);
        continue;
      }
      hits.push(...findSecretPaths(child, childPath, depth + 1));
    }
  }
  return hits;
}
