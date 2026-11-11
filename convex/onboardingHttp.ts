/**
 * SSE do onboarding conversacional v2 (P2.3): `POST /api/onboarding/stream`.
 *
 * Rota PRÓPRIA (e não `purpose:"onboarding"` no `/api/copilot/stream`): o
 * Copiloto é um loop com tools de escrita (`createBoard`, `createFieldDefinition`,
 * `createQuickReply`, configurações do atendente) que exige `orgAiActive`; o
 * onboarding precisa do oposto — nenhuma tool, rodar ANTES do aceite de IA,
 * orçamento próprio (`onboardingBudget`), rate limit por IP e saída
 * estruturada com blocos. Compartilhar o endpoint obrigaria a desligar tools
 * e gates por flag dentro do loop do Copiloto (risco de regressão nos dois).
 *
 * Este arquivo é só o ADAPTADOR: auth + gate de rota + rate limit por IP; o
 * loop vive em `lib/onboardingTurn.ts` (o mesmo da action `onboardingChat.sendTurn`).
 *
 * Corpo: `{organizationId, sessionId?, text?, attachment?}` (ver `turnInputValidator`).
 * Eventos SSE (linhas `data: {...}`):
 *   {type:"session", sessionId}           — sessão resolvida (criada se preciso)
 *   {type:"status", text}                 — progresso ("Lendo o site…")
 *   {type:"delta", text}                  — trecho da resposta (já saneada pelo guard)
 *   {type:"block", block}                 — bloco rico montado pelo servidor (`OnboardingBlock`)
 *   {type:"chips", chips}                 — respostas sugeridas (2–6)
 *   {type:"draft", version, hash}         — rascunho gravado neste turno
 *   {type:"done", nextStage, askForMaterials}
 *   {type:"error", code, message}         — PT-BR, pronta para a tela
 */
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { Permissions } from "./lib/permissions";
import { runOnboardingTurn, type TurnAttachment, type TurnInput } from "./lib/onboardingTurn";

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function sseEncode(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export function onboardingStreamPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}

// Formato de id do Convex (e o do convex-test, com `;`); a validação real é o `v.id` das internas.
const ID_RE = /^[A-Za-z0-9;_-]{1,100}$/;

/** Corpo validado à mão (o JSON é `unknown`): 400 para o que não casar. */
export function parseTurnBody(raw: unknown): TurnInput | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.organizationId !== "string" || !ID_RE.test(b.organizationId)) return null;
  if (b.sessionId !== undefined && (typeof b.sessionId !== "string" || !ID_RE.test(b.sessionId))) return null;
  if (b.text !== undefined && typeof b.text !== "string") return null;
  let attachment: TurnAttachment | undefined;
  if (b.attachment !== undefined) {
    const a = b.attachment as Record<string, unknown> | null;
    if (!a || typeof a !== "object") return null;
    if (a.kind === "url" && typeof a.url === "string" && a.url.length <= 2000) attachment = { kind: "url", url: a.url };
    else if (
      (a.kind === "pdf" || a.kind === "image" || a.kind === "audio") &&
      typeof a.storageId === "string" &&
      ID_RE.test(a.storageId)
    ) {
      attachment = { kind: a.kind, storageId: a.storageId as Id<"_storage"> };
    } else return null;
  }
  return {
    organizationId: b.organizationId as Id<"organizations">,
    ...(b.sessionId ? { sessionId: b.sessionId as Id<"onboardingSessions"> } : {}),
    ...(typeof b.text === "string" ? { text: b.text } : {}),
    ...(attachment ? { attachment } : {}),
  };
}

/**
 * Handler da rota. `routeGate` é o `requireRoutePermission` do `router.ts`
 * (mapa `ROUTE_PERMISSIONS`, fail-closed) aplicado às permissões do membro.
 */
export async function handleOnboardingStream(
  ctx: ActionCtx,
  request: Request,
  routeGate: (permissions: Permissions) => Response | null,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { error: "JSON inválido" });
  }
  const input = parseTurnBody(raw);
  if (!input) return json(400, { error: "Corpo inválido: organizationId e text ou attachment" });

  // Rate limit por IP antes de qualquer outra coisa (entrada mais à direita do x-forwarded-for).
  const ipKey = request.headers.get("x-forwarded-for") ?? request.headers.get("cf-connecting-ip") ?? undefined;
  if (ipKey) {
    const rate = await ctx.runMutation(internal.onboardingBudget.internalCheckOnboardingRateLimit, { ipKey });
    if (!rate.ok) return json(429, { error: rate.message, code: "rate_limited", retryAfterMs: rate.retryAfterMs });
  }

  // Auth do usuário (JWT do Convex auth no Authorization, propagado ao runQuery).
  let actor: { userId: Id<"users">; memberId: Id<"teamMembers">; permissions: Permissions } | null;
  try {
    actor = await ctx.runQuery(internal.onboardingChat.internalResolveTurnActor, { organizationId: input.organizationId });
  } catch {
    return json(400, { error: "organizationId inválido" });
  }
  if (!actor) return json(401, { error: "Entre na sua conta para continuar." });
  const denied = routeGate(actor.permissions);
  if (denied) {
    return new Response(denied.body, { status: denied.status, headers: { "Content-Type": "application/json", ...CORS } });
  }

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const send = (payload: Record<string, unknown>) => controller.enqueue(sseEncode(payload));
      try {
        const result = await runOnboardingTurn(ctx, input, {
          onSession: (sessionId) => send({ type: "session", sessionId }),
          onStatus: (text) => send({ type: "status", text }),
          onDelta: (text) => send({ type: "delta", text }),
          onBlock: (block) => send({ type: "block", block }),
          onChips: (chips) => send({ type: "chips", chips }),
          onDraft: (d) => send({ type: "draft", version: d.version, hash: d.hash }),
        });
        if (result.ok) send({ type: "done", nextStage: result.nextStage, askForMaterials: result.askForMaterials });
        else send({ type: "error", code: result.code, message: result.message });
      } catch {
        send({ type: "error", code: "error", message: "Algo deu errado. Tente de novo em instantes." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...CORS },
  });
}
