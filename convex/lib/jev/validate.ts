/**
 * Validação PURA do contrato com o Jev — o alpha NÃO valida o que mandamos
 * (medido em 16/11/2026: choice com 1 opção e score com 1 nível voltam 200;
 * campo desconhecido no corpo é ignorado), então a barreira é nossa:
 *
 *  - `validateQuestions`: ids, tipos e faixas ANTES de pagar a chamada;
 *  - `assertRequestBodyShape`: o corpo só tem campos conhecidos e a trava de
 *    privacidade (`data_collection:"deny"`) nunca some. Quem adicionar um campo
 *    ao corpo precisa atualizar `JEV_REQUEST_ALLOWED_KEYS` aqui (e o teste);
 *  - `validateResponse`: toda pergunta respondida, opção válida, probabilidade
 *    em [0,1]. Faltou resposta → LANÇA (nunca vira "sim").
 */
import {
  JEV_MODEL,
  JevValidationError,
  type JevAnswer,
  type JevQuestion,
  type JevQuestions,
} from "./types";

export const QUESTION_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_QUESTIONS = 24;
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_CHOICE_OPTIONS = 2;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
export const MAX_INSTRUCTIONS_CHARS = 2000;
export const MAX_CRITERION_CHARS = 600;
export const MAX_OPTION_KEY_CHARS = 80;

/** Campos de topo permitidos no corpo da requisição. */
export const JEV_REQUEST_ALLOWED_KEYS = ["model", "state", "questions", "provider"] as const;
/** Campos permitidos dentro de `provider` (os mesmos de `OPENROUTER_ZDR_PROVIDER_BODY`). */
export const JEV_PROVIDER_ALLOWED_KEYS = ["data_collection", "require_parameters", "allow_fallbacks"] as const;

const bad = (message: string) => new JevValidationError("invalid_questions", message);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function validateQuestions(input: unknown): JevQuestions {
  if (!isObj(input)) throw bad("questions precisa ser um objeto");
  const ids = Object.keys(input);
  if (ids.length === 0) throw bad("questions vazio");
  if (ids.length > MAX_QUESTIONS) throw bad(`questions: no máximo ${MAX_QUESTIONS} perguntas`);
  const out: JevQuestions = {};
  for (const id of ids) {
    if (!QUESTION_ID_RE.test(id)) throw bad(`id de pergunta inválido: "${id}" (use a-z, 0-9 e _)`);
    const q = input[id];
    if (!isObj(q)) throw bad(`${id}: pergunta precisa ser um objeto`);
    if (typeof q.instructions !== "string" || q.instructions.trim() === "") throw bad(`${id}: instructions obrigatório`);
    if (q.instructions.length > MAX_INSTRUCTIONS_CHARS) throw bad(`${id}: instructions acima de ${MAX_INSTRUCTIONS_CHARS} caracteres`);
    switch (q.type) {
      case "noul": {
        out[id] = { type: "noul", instructions: q.instructions };
        break;
      }
      case "choice": {
        if (!isObj(q.criteria)) throw bad(`${id}: choice exige criteria (opção → descrição)`);
        const keys = Object.keys(q.criteria);
        if (keys.length < MIN_CHOICE_OPTIONS || keys.length > MAX_CHOICE_OPTIONS) {
          throw bad(`${id}: choice precisa de ${MIN_CHOICE_OPTIONS}..${MAX_CHOICE_OPTIONS} opções (veio ${keys.length})`);
        }
        const criteria: Record<string, string> = {};
        for (const k of keys) {
          if (k.trim() === "" || k.length > MAX_OPTION_KEY_CHARS) throw bad(`${id}: opção inválida (vazia ou > ${MAX_OPTION_KEY_CHARS} caracteres)`);
          const d = q.criteria[k];
          if (typeof d !== "string" || d.trim() === "" || d.length > MAX_CRITERION_CHARS) {
            throw bad(`${id}: descrição da opção "${k}" precisa ser texto de 1..${MAX_CRITERION_CHARS} caracteres`);
          }
          criteria[k] = d;
        }
        out[id] = { type: "choice", instructions: q.instructions, criteria };
        break;
      }
      case "score": {
        if (!Array.isArray(q.criteria)) throw bad(`${id}: score exige criteria (lista de níveis)`);
        if (q.criteria.length < MIN_SCORE_LEVELS || q.criteria.length > MAX_SCORE_LEVELS) {
          throw bad(`${id}: score precisa de ${MIN_SCORE_LEVELS}..${MAX_SCORE_LEVELS} níveis (veio ${q.criteria.length})`);
        }
        for (const lvl of q.criteria) {
          if (typeof lvl !== "string" || lvl.trim() === "" || lvl.length > MAX_CRITERION_CHARS) {
            throw bad(`${id}: cada nível de score precisa ser texto de 1..${MAX_CRITERION_CHARS} caracteres`);
          }
        }
        out[id] = { type: "score", instructions: q.instructions, criteria: [...(q.criteria as string[])] };
        break;
      }
      default:
        // `box` e afins existem só em versões novas do modelo (o 1.13 responde 400).
        throw bad(`${id}: tipo de pergunta não suportado`);
    }
  }
  return out;
}

/** Barreira do corpo: campo novo sem atualizar as listas aqui → lança. */
export function assertRequestBodyShape(body: unknown): void {
  const err = (m: string) => new JevValidationError("invalid_request", m);
  if (!isObj(body)) throw err("corpo precisa ser um objeto");
  for (const k of Object.keys(body)) {
    if (!(JEV_REQUEST_ALLOWED_KEYS as readonly string[]).includes(k)) throw err(`campo não permitido no corpo: ${k}`);
  }
  if (body.model !== JEV_MODEL) throw err("model precisa ser o JEV_MODEL pinado");
  if (!isObj(body.state)) throw err("state ausente");
  if (!isObj(body.questions)) throw err("questions ausente");
  const provider = body.provider;
  if (!isObj(provider)) throw err("provider ausente: a trava de privacidade é obrigatória");
  for (const k of Object.keys(provider)) {
    if (!(JEV_PROVIDER_ALLOWED_KEYS as readonly string[]).includes(k)) throw err(`campo não permitido em provider: ${k}`);
  }
  if (provider.data_collection !== "deny") throw err('provider.data_collection precisa ser "deny"');
}

// ── Resposta ────────────────────────────────────────────────────────────────

export interface ParsedJevResponse {
  model: string;
  requestId?: string;
  provider?: string;
  answers: Record<string, JevAnswer>;
  usage: { promptTokens: number; completionTokens: number; costUsd?: number; isByok: boolean };
}

const badResp = (message: string) => new JevValidationError("invalid_response", message);
const num01 = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= -1e-9 && x <= 1 + 1e-9;
const EPS = 1e-6;

function parseProbabilities(id: string, raw: unknown, allowed: string[]): Record<string, number> {
  if (!isObj(raw)) throw badResp(`${id}: probabilities ausente`);
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [k, p] of Object.entries(raw)) {
    if (!allowed.includes(k)) throw badResp(`${id}: probabilidade para opção desconhecida`);
    if (!num01(p)) throw badResp(`${id}: probabilidade fora de [0,1]`);
    out[k] = Math.min(1, Math.max(0, p));
    sum += p;
  }
  if (Object.keys(out).length === 0) throw badResp(`${id}: probabilities vazio`);
  if (Math.abs(sum - 1) > 0.05) throw badResp(`${id}: probabilidades não somam ~1`);
  return out;
}

export function validateResponse(questions: JevQuestions, raw: unknown): ParsedJevResponse {
  if (!isObj(raw)) throw badResp("resposta não é um objeto");
  if (typeof raw.model !== "string" || raw.model === "") throw badResp("model ausente na resposta");
  if (!isObj(raw.answers)) throw badResp("answers ausente");
  const answers: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(questions) as [string, JevQuestion][]) {
    const a = raw.answers[id];
    if (!isObj(a)) throw badResp(`${id}: sem resposta`);
    if (a.type !== q.type) throw badResp(`${id}: tipo de resposta diferente da pergunta`);
    const conf = a.confidence;
    if (conf !== undefined && !num01(conf)) throw badResp(`${id}: confidence fora de [0,1]`);
    if (q.type === "noul") {
      if (!num01(a.noul)) throw badResp(`${id}: noul fora de [0,1]`);
      answers[id] = { type: "noul", noul: Math.min(1, Math.max(0, a.noul)) };
    } else if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      if (typeof a.choice !== "string" || !options.includes(a.choice)) throw badResp(`${id}: choice fora das opções`);
      answers[id] = {
        type: "choice",
        choice: a.choice,
        ...(conf !== undefined ? { confidence: conf as number } : {}),
        probabilities: parseProbabilities(id, a.probabilities, options),
      };
    } else {
      const levels = q.criteria.map((_, i) => String(i));
      if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < -EPS || a.score > q.criteria.length - 1 + EPS) {
        throw badResp(`${id}: score fora dos níveis`);
      }
      answers[id] = {
        type: "score",
        score: a.score,
        ...(conf !== undefined ? { confidence: conf as number } : {}),
        probabilities: parseProbabilities(id, a.probabilities, levels),
      };
    }
  }
  const u = raw.usage;
  if (!isObj(u) || typeof u.input_tokens !== "number" || !Number.isFinite(u.input_tokens) || u.input_tokens < 0) {
    throw badResp("usage.input_tokens ausente");
  }
  const outTok = typeof u.output_tokens === "number" && Number.isFinite(u.output_tokens) && u.output_tokens >= 0 ? u.output_tokens : 0;
  const isByok = u.is_byok === true;
  // Custo utilizável: número finito ≥ 0; 0 com tokens consumidos é suspeito (nunca "grátis" por engano);
  // BYOK traz só a taxa do OpenRouter (não é o custo real).
  const cost = u.cost;
  const usable =
    typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && !isByok && (cost > 0 || u.input_tokens === 0);
  return {
    model: raw.model,
    requestId: typeof raw.id === "string" ? raw.id : undefined,
    provider: typeof raw.provider === "string" ? raw.provider : undefined,
    answers,
    usage: { promptTokens: u.input_tokens, completionTokens: outTok, ...(usable ? { costUsd: cost as number } : {}), isByok },
  };
}
