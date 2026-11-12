/**
 * Cliente do SSE do onboarding conversacional (`POST /api/onboarding/stream`,
 * contrato em `convex/onboardingHttp.ts` e docs/architecture/onboarding.md).
 * PURO: parser SSE tolerante a pedaços, validação de cada evento, mensagens de
 * erro PT-BR por código e `runOnboardingTurnRequest` (fetch injetado), que o
 * hook `useOnboardingStream` usa.
 *
 * Regras do contrato que este arquivo garante:
 * - `audio` pode chegar DEPOIS de `done` no mesmo stream; a leitura só termina
 *   quando o servidor fecha a conexão (ou o chamador aborta).
 * - Erros antes do stream chegam como JSON (`{error, code?, retryAfterMs?}`)
 *   com 400/401/403/429; dentro do stream, como evento `error`.
 * - Nada aqui reconecta sozinho: um turno que falhou só é repetido por ação da pessoa.
 */

export type OnboardingErrorCode =
  | "invalid_input"
  | "forbidden"
  | "email_unverified"
  | "notice_required"
  | "rate_limited"
  | "budget"
  | "material_failed"
  | "unauthenticated"
  | "network"
  | "error";

export type OnboardingAttachment =
  | { kind: "url"; url: string }
  | { kind: "pdf" | "image" | "audio"; storageId: string };

export interface OnboardingReplyAudio {
  url: string;
  durationSec: number;
  mimeType: string;
}

export type OnboardingStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  /** Bloco cru do servidor: quem renderiza valida o `kind` (ver `blocks/registry.tsx`). */
  | { type: "block"; block: Record<string, unknown> }
  | { type: "chips"; chips: string[] }
  | { type: "draft"; version: number; hash: string }
  | { type: "done"; nextStage: string | null; askForMaterials: boolean }
  | { type: "audio"; url: string; durationSec: number; mimeType: string }
  | { type: "error"; code: OnboardingErrorCode; message: string };

export interface OnboardingTurnError {
  code: OnboardingErrorCode;
  message: string;
  /** Só em `rate_limited`: quanto esperar antes de tentar de novo. */
  retryAfterMs?: number;
}

const KNOWN_CODES: readonly OnboardingErrorCode[] = [
  "invalid_input",
  "forbidden",
  "email_unverified",
  "notice_required",
  "rate_limited",
  "budget",
  "material_failed",
  "unauthenticated",
  "network",
  "error",
];

const FALLBACK_MESSAGE: Record<OnboardingErrorCode, string> = {
  invalid_input: "Não consegui entender essa mensagem. Confira e tente de novo.",
  forbidden: "Só quem administra a organização pode montar a operação por aqui.",
  email_unverified: "Confirme o código enviado ao seu e-mail para liberar o envio de site, arquivos e áudio.",
  notice_required: "Antes do primeiro material, confirme que leu o aviso sobre como ele é lido.",
  rate_limited: "Muitas mensagens em pouco tempo. Espere um pouco e tente de novo.",
  budget: "O limite de uso da configuração por conversa foi atingido. Você pode seguir pelo formulário.",
  material_failed: "Não consegui ler esse material. Tente outro arquivo ou conte por escrito.",
  unauthenticated: "Entre na sua conta para continuar.",
  network: "Sem conexão com o servidor. Confira a internet e tente de novo.",
  error: "Algo deu errado. Tente de novo em instantes.",
};

export function normalizeErrorCode(raw: unknown): OnboardingErrorCode {
  return typeof raw === "string" && (KNOWN_CODES as readonly string[]).includes(raw)
    ? (raw as OnboardingErrorCode)
    : "error";
}

/** "1 minuto", "3 minutos", "40 segundos". */
export function formatRetryWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return seconds === 1 ? "1 segundo" : `${seconds} segundos`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minuto" : `${minutes} minutos`;
}

/**
 * Mensagem para a tela. A do servidor (já PT-BR e mais específica, ex.: corte
 * global x orçamento da sessão) vence; sem ela, o texto padrão do código.
 * `rate_limited` com espera conhecida ganha "Tente de novo em N minutos." quando
 * a mensagem ainda não fala de tempo.
 */
export function onboardingErrorMessage(code: OnboardingErrorCode, serverMessage?: string | null, retryAfterMs?: number): string {
  const base = (typeof serverMessage === "string" && serverMessage.trim()) || FALLBACK_MESSAGE[code];
  if (code === "rate_limited" && retryAfterMs && retryAfterMs > 0 && !/\d/.test(base)) {
    return `${base.replace(/\s*$/, "")} Tente de novo em ${formatRetryWait(retryAfterMs)}.`;
  }
  return base;
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** Valida um evento já em JSON; null para o que não casa com o contrato (ignorado). */
export function parseOnboardingEvent(raw: unknown): OnboardingStreamEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  switch (e.type) {
    case "session":
      return isStr(e.sessionId) && e.sessionId ? { type: "session", sessionId: e.sessionId } : null;
    case "status":
      return isStr(e.text) ? { type: "status", text: e.text } : null;
    case "delta":
      return isStr(e.text) ? { type: "delta", text: e.text } : null;
    case "block":
      return e.block && typeof e.block === "object" && !Array.isArray(e.block)
        ? { type: "block", block: e.block as Record<string, unknown> }
        : null;
    case "chips":
      return Array.isArray(e.chips) ? { type: "chips", chips: e.chips.filter(isStr) } : null;
    case "draft":
      return typeof e.version === "number" && isStr(e.hash) ? { type: "draft", version: e.version, hash: e.hash } : null;
    case "done":
      return {
        type: "done",
        nextStage: isStr(e.nextStage) ? e.nextStage : null,
        askForMaterials: e.askForMaterials === true,
      };
    case "audio":
      return isStr(e.url) && e.url
        ? {
            type: "audio",
            url: e.url,
            durationSec: typeof e.durationSec === "number" && Number.isFinite(e.durationSec) ? e.durationSec : 0,
            mimeType: isStr(e.mimeType) ? e.mimeType : "audio/wav",
          }
        : null;
    case "error": {
      const code = normalizeErrorCode(e.code);
      return { type: "error", code, message: onboardingErrorMessage(code, isStr(e.message) ? e.message : null) };
    }
    default:
      return null;
  }
}

/**
 * Parser SSE incremental (WHATWG, o suficiente para este servidor): aceita
 * pedaços de qualquer tamanho, `\n`, `\r\n` ou `\r`, várias linhas `data:`
 * num evento (juntadas com `\n`), comentários (`:`) e campos `event`/`id`
 * (ignorados). Cada evento completo (linha em branco) vira um `onData(texto)`.
 */
export function createSseParser(onData: (data: string) => void) {
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) onData(dataLines.join("\n"));
    dataLines = [];
  };

  const processLine = (line: string) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      // Um `\r` no fim pode ser metade de um `\r\n`: espera o próximo pedaço.
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        processLine(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
    /** Fim do stream: processa o resto e despacha um evento sem linha em branco final. */
    end() {
      if (buffer) processLine(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
  };
}

/** Converte o texto de um `data:` em evento validado (JSON quebrado = ignorado). */
export function decodeSseData(data: string): OnboardingStreamEvent | null {
  try {
    return parseOnboardingEvent(JSON.parse(data));
  } catch {
    return null;
  }
}

export interface OnboardingTurnBody {
  organizationId: string;
  sessionId?: string;
  text?: string;
  attachment?: OnboardingAttachment;
}

export type OnboardingTurnOutcome =
  | { ok: true; done: { nextStage: string | null; askForMaterials: boolean } }
  | { ok: false; error: OnboardingTurnError }
  | { ok: false; aborted: true };

export interface RunOnboardingTurnOptions {
  fetchImpl: typeof fetch;
  /** Base `https://<deployment>.convex.site` (sem barra final). */
  siteUrl: string;
  token: string;
  body: OnboardingTurnBody;
  signal?: AbortSignal;
  onEvent: (event: OnboardingStreamEvent) => void;
  /** Chamado ao receber `done` (a entrada destrava), antes de um `audio` que ainda pode vir. */
  onDone?: (done: { nextStage: string | null; askForMaterials: boolean }) => void;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/** Lê o erro JSON de uma resposta não-OK (antes do stream). */
export async function readHttpError(res: Response): Promise<OnboardingTurnError> {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // corpo não-JSON: fica o padrão do status
  }
  const code: OnboardingErrorCode =
    data.code !== undefined
      ? normalizeErrorCode(data.code)
      : res.status === 401
        ? "unauthenticated"
        : res.status === 403
          ? "forbidden"
          : res.status === 429
            ? "rate_limited"
            : res.status === 400
              ? "invalid_input"
              : "error";
  const retryAfterMs =
    typeof data.retryAfterMs === "number" && Number.isFinite(data.retryAfterMs) && data.retryAfterMs > 0
      ? data.retryAfterMs
      : undefined;
  // 400 do adaptador traz texto técnico ("Corpo inválido: …"): usa o padrão.
  const serverMessage = code === "invalid_input" ? null : typeof data.error === "string" ? data.error : null;
  return {
    code,
    message: onboardingErrorMessage(code, serverMessage, retryAfterMs),
    ...(retryAfterMs ? { retryAfterMs } : {}),
  };
}

/**
 * Um turno inteiro: POST, leitura do stream até o servidor fechar, eventos em
 * ordem para `onEvent`. Resultado: `done` recebido (ok), erro (HTTP, evento
 * `error`, stream fechado sem `done`, rede) ou abortado.
 */
export async function runOnboardingTurnRequest(opts: RunOnboardingTurnOptions): Promise<OnboardingTurnOutcome> {
  const { fetchImpl, siteUrl, token, body, signal, onEvent, onDone } = opts;
  let res: Response;
  try {
    res = await fetchImpl(`${siteUrl}/api/onboarding/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbort(err, signal)) return { ok: false, aborted: true };
    return { ok: false, error: { code: "network", message: FALLBACK_MESSAGE.network } };
  }
  if (!res.ok || !res.body) {
    if (signal?.aborted) return { ok: false, aborted: true };
    return { ok: false, error: await readHttpError(res) };
  }

  // Objeto (e não `let`): o TS não acompanha atribuições feitas dentro do callback.
  const state: { done: { nextStage: string | null; askForMaterials: boolean } | null; error: OnboardingTurnError | null } = {
    done: null,
    error: null,
  };
  const parser = createSseParser((data) => {
    const event = decodeSseData(data);
    if (!event) return;
    if (event.type === "error") state.error = { code: event.code, message: event.message };
    onEvent(event);
    if (event.type === "done") {
      state.done = { nextStage: event.nextStage, askForMaterials: event.askForMaterials };
      onDone?.(state.done);
    }
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (err) {
    if (isAbort(err, signal)) return { ok: false, aborted: true };
    // Conexão caiu depois do `done` (ex.: esperando o áudio): o turno valeu.
    if (state.done) return { ok: true, done: state.done };
    return { ok: false, error: { code: "network", message: FALLBACK_MESSAGE.network } };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // leitor já liberado
    }
  }
  if (state.error) return { ok: false, error: state.error };
  if (state.done) return { ok: true, done: state.done };
  return { ok: false, error: { code: "error", message: FALLBACK_MESSAGE.error } };
}

/** URL `.convex.site` a partir da `.convex.cloud` (mesmo cálculo do Copiloto). */
export function convexSiteUrl(cloudUrl: string | undefined): string {
  return (cloudUrl ?? "").replace(".convex.cloud", ".convex.site").replace(/\/+$/, "");
}
