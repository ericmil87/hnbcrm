/**
 * Helper de teste REUTILIZÁVEL (Agenda v2, A3a; use nos próximos PRs de `scheduling*`).
 *
 * O `convex-test` NÃO valida `returns`, mas o runtime recusa campo a mais num `v.object` e campo
 * obrigatório ausente. Este helper reproduz essas recusas (e confere primitivos, ids, literais,
 * arrays, records com as chaves, e uniões; id: confere a tabela quando o formato do convex-test permite) lendo o `returns` REAL da função registrada (`exportReturns()`), então o
 * teste falha antes do deploy se o validator e o que a função devolve divergirem.
 *
 *   import * as scheduling from "./scheduling";
 *   const out = await asAdmin.query(api.scheduling.listAgendaDay, args);
 *   assertMatchesReturns(out, scheduling.listAgendaDay);
 *
 * Também serve para um validator solto: `assertMatchesValidator(value, someValidator)`.
 * `undefined` conta como ausente (o Convex descarta chave `undefined` ao serializar).
 * Função sem `returns` falha (toda função de `scheduling*` precisa declarar).
 */
import type { Validator } from "convex/values";

type Json = { type: string; [k: string]: any };

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Lista de problemas (vazia = confere) do `value` contra o JSON de um validator. */
export function jsonProblems(value: unknown, j: Json, path = "$"): string[] {
  switch (j.type) {
    case "any":
      return [];
    case "string":
    case "number":
    case "boolean":
      return typeof value === j.type ? [] : [`${path}: esperava ${j.type}, veio ${kind(value)}`];
    case "null":
      return value === null ? [] : [`${path}: esperava null, veio ${kind(value)}`];
    case "bigint":
      return typeof value === "bigint" ? [] : [`${path}: esperava bigint, veio ${kind(value)}`];
    case "bytes":
      return value instanceof ArrayBuffer ? [] : [`${path}: esperava bytes, veio ${kind(value)}`];
    case "id": {
      if (typeof value !== "string") return [`${path}: esperava id de ${j.tableName}, veio ${kind(value)}`];
      // No convex-test o id é "<n>;<tabela>": confere a tabela quando o formato é esse (no runtime real é opaco).
      const sep = value.indexOf(";");
      if (sep > 0 && value.slice(sep + 1) !== j.tableName) {
        return [`${path}: id da tabela "${value.slice(sep + 1)}", esperava "${j.tableName}"`];
      }
      return [];
    }
    case "literal":
      return value === j.value ? [] : [`${path}: esperava literal ${JSON.stringify(j.value)}, veio ${JSON.stringify(value)}`];
    case "array": {
      if (!Array.isArray(value)) return [`${path}: esperava array, veio ${kind(value)}`];
      return value.flatMap((item, i) => jsonProblems(item, j.value, `${path}[${i}]`));
    }
    case "record": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path}: esperava record, veio ${kind(value)}`];
      return Object.entries(value as Record<string, unknown>).flatMap(([k, item]) =>
        item === undefined
          ? []
          : [...jsonProblems(k, j.keys, `${path}.<chave ${k}>`), ...jsonProblems(item, j.values.fieldType, `${path}.${k}`)]
      );
    }
    case "union": {
      const attempts = (j.value as Json[]).map((m) => jsonProblems(value, m, path));
      if (attempts.some((a) => a.length === 0)) return [];
      return [`${path}: nenhum membro da união confere`, ...attempts.flatMap((a, i) => a.map((p) => `  [membro ${i}] ${p}`))];
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path}: esperava objeto, veio ${kind(value)}`];
      const obj = value as Record<string, unknown>;
      const fields = j.value as Record<string, { fieldType: Json; optional: boolean }>;
      const problems: string[] = [];
      for (const key of Object.keys(obj)) {
        if (obj[key] !== undefined && !(key in fields)) problems.push(`${path}.${key}: campo a mais (o runtime recusa)`);
      }
      for (const [key, f] of Object.entries(fields)) {
        if (obj[key] === undefined) {
          if (!f.optional) problems.push(`${path}.${key}: campo obrigatório ausente`);
          continue;
        }
        problems.push(...jsonProblems(obj[key], f.fieldType, `${path}.${key}`));
      }
      return problems;
    }
    default:
      return [`${path}: tipo de validator desconhecido (${j.type})`];
  }
}

function fail(label: string, problems: string[]): never {
  throw new Error(`${label} não confere com o validator de returns:\n${problems.join("\n")}`);
}

export function assertMatchesValidator(value: unknown, validator: Validator<any, any, any>, label = "retorno"): void {
  const problems = jsonProblems(value, (validator as any).json as Json);
  if (problems.length > 0) fail(label, problems);
}

/** `fn` é a função registrada (`export const x = query({...})`). */
export function assertMatchesReturns(value: unknown, fn: unknown, label = "retorno"): void {
  const exp = (fn as { exportReturns?: () => string }).exportReturns;
  if (typeof exp !== "function") throw new Error(`${label}: não é uma função registrada do Convex.`);
  const parsed = JSON.parse(exp.call(fn)) as Json | null;
  if (parsed === null) throw new Error(`${label}: a função não declara \`returns\`.`);
  const problems = jsonProblems(value, parsed);
  if (problems.length > 0) fail(label, problems);
}
