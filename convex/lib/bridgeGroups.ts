/**
 * Adapter PURO das rotas `/group/*` do wuzapi (whatsmeow) — sem contexto Convex
 * e sem fetch: só monta requisições e interpreta respostas, então dá para testar
 * o contrato inteiro contra as capturas reais do gateway.
 *
 * As pegadinhas abaixo foram MEDIDAS no gateway gerenciado em 16/09/2026 e são
 * o motivo de este arquivo existir em vez de um `JSON.parse` no meio da action:
 *
 *  1. Instância sem grupo devolve `{"Groups": null}` — `null`, não `[]`. Iterar
 *     direto quebra a sincronização inteira.
 *  2. `ParticipantCount` vem **0** em `/group/list` (e correto em `/group/info`).
 *     A contagem confiável é sempre `Participants.length`.
 *  3. JID inexistente responde **HTTP 500 com `success: true` e sem `error`** —
 *     o "sucesso" precisa ser tratado como falha daquele grupo, não da varredura.
 *  4. `Participants[].JID` vem `@lid` quando `AddressingMode: "lid"`; o telefone
 *     já vem resolvido em `PhoneNumber`. Guardamos os DOIS: o LID é a chave
 *     estável (casa com `Info.Sender` das mensagens) e o telefone é o que liga
 *     o membro a um contato da org.
 *  5. `DisplayName` vem vazio para todo mundo — nome de membro só existe via
 *     `PushName` das mensagens.
 */

/** Um participante de grupo, já normalizado (telefone em dígitos). */
export interface ParsedGroupParticipant {
  lid?: string;
  phone?: string; // E.164 sem '+'
  name?: string; // DisplayName do gateway (quase sempre vazio — ver pegadinha 5)
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/** O documento de grupo devolvido por `/group/list` e `/group/info`. */
export interface ParsedGroupInfo {
  jid: string;
  subject: string;
  topic?: string;
  ownerJid?: string;
  createdAtWa?: number;
  isAnnounce: boolean;
  isLocked: boolean;
  isEphemeral: boolean;
  disappearingTimer?: number;
  isCommunityParent: boolean;
  linkedParentJid?: string;
  addressingMode?: "lid" | "pn";
  participants: ParsedGroupParticipant[];
  participantsCount: number;
}

export interface BridgeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function jsonHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", token };
}

/** `true` para um JID de grupo ("…@g.us"). */
export function isGroupJid(jid: string | undefined | null): boolean {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

/**
 * JID → dígitos do telefone. NUNCA aplicar a `@g.us` (o "usuário" de um grupo é
 * um id numérico e viraria um MSISDN falso) nem a `@lid` (é um id de privacidade).
 */
export function jidToPhoneDigits(jid: string | undefined | null): string | undefined {
  if (!jid || typeof jid !== "string") return undefined;
  if (jid.endsWith("@g.us") || jid.endsWith("@lid")) return undefined;
  const at = jid.indexOf("@");
  const user = (at >= 0 ? jid.slice(0, at) : jid).split(":")[0].split(".")[0];
  const digits = user.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits : undefined;
}

/** Chave estável de um participante: o LID quando existe, senão o telefone. */
export function participantKey(p: {
  lid?: string;
  phone?: string;
}): string | undefined {
  return p.lid ?? p.phone;
}

function pick(obj: Record<string, any> | null | undefined, ...keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function strUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** RFC3339 ou unix. Data "zero" do Go ("0001-01-01T…") vira undefined. */
function parseWaTime(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.startsWith("0001-01-01")) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseParticipant(raw: unknown): ParsedGroupParticipant | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const jid = strUndef(pick(r, "JID", "jid"));
  const lidRaw = strUndef(pick(r, "LID", "Lid", "lid")) ?? (jid?.endsWith("@lid") ? jid : undefined);
  const phoneJid = strUndef(pick(r, "PhoneNumber", "phoneNumber", "PN"));
  const phone = jidToPhoneDigits(phoneJid) ?? jidToPhoneDigits(jid);
  if (!lidRaw && !phone) return null;
  return {
    ...(lidRaw ? { lid: lidRaw } : {}),
    ...(phone ? { phone } : {}),
    ...(strUndef(pick(r, "DisplayName", "displayName")) ? { name: strUndef(pick(r, "DisplayName", "displayName")) } : {}),
    isAdmin: pick(r, "IsAdmin", "isAdmin") === true,
    isSuperAdmin: pick(r, "IsSuperAdmin", "isSuperAdmin") === true,
  };
}

/**
 * Normaliza UM documento de grupo (item de `/group/list`, resposta de
 * `/group/info`, ou o `GroupInfo` embutido num evento `JoinedGroup`).
 * Devolve `null` quando nem o JID está presente — nunca lança.
 */
export function parseGroupInfoStruct(raw: unknown): ParsedGroupInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, any>;
  const jid = strUndef(pick(g, "JID", "jid", "GroupJID", "groupJid"));
  if (!jid || !isGroupJid(jid)) return null;

  const participantsRaw = pick(g, "Participants", "participants");
  const participants = Array.isArray(participantsRaw)
    ? participantsRaw
        .map(parseParticipant)
        .filter((p): p is ParsedGroupParticipant => p !== null)
    : [];

  const addressingRaw = strUndef(pick(g, "AddressingMode", "addressingMode"));
  const addressingMode =
    addressingRaw === "lid" ? ("lid" as const) : addressingRaw === "pn" ? ("pn" as const) : undefined;

  const timer = pick(g, "DisappearingTimer", "disappearingTimer");

  return {
    jid,
    // `Name` é o campo real do whatsmeow; `Subject` aparece em variantes antigas.
    subject: strUndef(pick(g, "Name", "name", "Subject", "subject")) ?? jid,
    ...(strUndef(pick(g, "Topic", "topic")) ? { topic: strUndef(pick(g, "Topic", "topic")) } : {}),
    ...(strUndef(pick(g, "OwnerJID", "ownerJid", "OwnerPN"))
      ? { ownerJid: strUndef(pick(g, "OwnerJID", "ownerJid", "OwnerPN")) }
      : {}),
    ...(parseWaTime(pick(g, "GroupCreated", "groupCreated"))
      ? { createdAtWa: parseWaTime(pick(g, "GroupCreated", "groupCreated")) }
      : {}),
    isAnnounce: pick(g, "IsAnnounce", "isAnnounce") === true,
    isLocked: pick(g, "IsLocked", "isLocked") === true,
    isEphemeral: pick(g, "IsEphemeral", "isEphemeral") === true,
    ...(typeof timer === "number" && timer > 0 ? { disappearingTimer: timer } : {}),
    isCommunityParent: pick(g, "IsParent", "isParent") === true,
    ...(strUndef(pick(g, "LinkedParentJID", "linkedParentJid"))
      ? { linkedParentJid: strUndef(pick(g, "LinkedParentJID", "linkedParentJid")) }
      : {}),
    ...(addressingMode ? { addressingMode } : {}),
    participants,
    // PEGADINHA 2: nunca ler `ParticipantCount` — vem 0 na listagem.
    participantsCount: participants.length,
  };
}

export type BridgeGroupListResult =
  | { ok: true; groups: ParsedGroupInfo[] }
  | { ok: false; error: string };

/**
 * `GET /group/list`. Devolve lista VAZIA para `Groups: null`/`data: null` —
 * "esta conta não está em nenhum grupo" é um sucesso, não um erro.
 */
export function parseGroupListResponse(
  httpOk: boolean,
  status: number,
  body: unknown
): BridgeGroupListResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  if (!httpOk) {
    const err = strUndef(pick(b, "error", "Error", "message", "Message"));
    return { ok: false, error: err ?? `Gateway recusou a listagem de grupos (HTTP ${status})` };
  }
  if (b.success === false || b.Success === false) {
    return { ok: false, error: strUndef(pick(b, "error", "Error")) ?? "Listagem de grupos falhou" };
  }
  const data = pick(b, "data", "Data");
  if (data === undefined || data === null) return { ok: true, groups: [] };
  const raw = pick(data as Record<string, any>, "Groups", "groups");
  if (raw === undefined || raw === null) return { ok: true, groups: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Resposta de grupos em formato inesperado" };
  return {
    ok: true,
    groups: raw.map(parseGroupInfoStruct).filter((g): g is ParsedGroupInfo => g !== null),
  };
}

export type BridgeGroupInfoResult =
  | { ok: true; group: ParsedGroupInfo }
  | { ok: false; error: string };

/**
 * `GET /group/info` / `POST /group/inviteinfo`.
 *
 * PEGADINHA 3: JID inválido responde HTTP 500 **com `success: true`** e sem
 * `error`. O `httpOk` manda: 500 é falha mesmo que o corpo diga "success".
 */
export function parseGroupInfoResponse(
  httpOk: boolean,
  status: number,
  body: unknown
): BridgeGroupInfoResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  if (!httpOk) {
    const err = strUndef(pick(b, "error", "Error", "message", "Message"));
    return {
      ok: false,
      error: err ?? `Grupo não encontrado ou inacessível (HTTP ${status})`,
    };
  }
  if (b.success === false || b.Success === false) {
    return { ok: false, error: strUndef(pick(b, "error", "Error")) ?? "Consulta de grupo falhou" };
  }
  const data = pick(b, "data", "Data");
  // Alguns endpoints devolvem o grupo direto em `data`, outros dentro de
  // `data.GroupInfo` / `data.Groups[0]`.
  const candidate =
    parseGroupInfoStruct(data) ??
    parseGroupInfoStruct(pick(data as Record<string, any>, "GroupInfo", "groupInfo")) ??
    parseGroupInfoStruct(
      Array.isArray(pick(data as Record<string, any>, "Groups", "groups"))
        ? pick(data as Record<string, any>, "Groups", "groups")[0]
        : undefined
    ) ??
    parseGroupInfoStruct(b);
  if (!candidate) return { ok: false, error: "Resposta de grupo em formato inesperado" };
  return { ok: true, group: candidate };
}

export type BridgeUserLidResult = { ok: true; lid: string } | { ok: false; error: string };

/** `GET /user/lid/{phone}` → `{data:{jid, lid}}` (medido). */
export function parseUserLidResponse(
  httpOk: boolean,
  status: number,
  body: unknown
): BridgeUserLidResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  if (!httpOk || b.success === false || b.Success === false) {
    const err = strUndef(pick(b, "error", "Error", "message", "Message"));
    return { ok: false, error: err ?? `Gateway não resolveu o LID (HTTP ${status})` };
  }
  const data = (pick(b, "data", "Data") ?? {}) as Record<string, any>;
  const lid = strUndef(pick(data, "lid", "LID", "Lid")) ?? strUndef(pick(b, "lid", "LID"));
  if (!lid) return { ok: false, error: "Gateway não devolveu o LID" };
  return { ok: true, lid };
}

export type BridgeGroupAckResult = { ok: true } | { ok: false; error: string };

/** Resposta de operação sem retorno útil (`leave`, `join`). */
export function parseGroupAckResponse(
  httpOk: boolean,
  status: number,
  body: unknown
): BridgeGroupAckResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  if (!httpOk || b.success === false || b.Success === false) {
    const err = strUndef(pick(b, "error", "Error", "message", "Message"));
    return { ok: false, error: err ?? `Operação de grupo falhou (HTTP ${status})` };
  }
  return { ok: true };
}

/**
 * Código de convite a partir de um link do WhatsApp
 * (`https://chat.whatsapp.com/ABCdef123`). Aceita o código puro também, para
 * quem cola só o final. Devolve `null` quando não dá para extrair nada.
 */
export function inviteCodeFromLink(input: string): string | null {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{6,})/i);
  if (match) return match[1];
  // Código solto: só letras/números/-/_ e nada de espaço ou barra.
  if (/^[A-Za-z0-9_-]{6,}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Somos administradores deste grupo? Compara o NOSSO LID (resolvido por
 * `/user/lid`) e, como reserva, o nosso telefone — em gateway self-hosted o LID
 * pode não ser conhecido.
 */
export function weAreAdminOf(
  group: Pick<ParsedGroupInfo, "participants">,
  ourLid: string | undefined,
  ourPhone: string | undefined
): { weAreAdmin: boolean; weAreSuperAdmin: boolean } {
  const me = findSelfParticipant(group.participants, ourLid, ourPhone);
  return {
    weAreAdmin: me?.isAdmin === true || me?.isSuperAdmin === true,
    weAreSuperAdmin: me?.isSuperAdmin === true,
  };
}

/**
 * NÓS dentro da lista de participantes. O LID VENCE o telefone: ele é a chave
 * que o próprio WhatsApp usa nos eventos, e num canal reprovisionado o
 * `bridgePhone` gravado pode estar defasado — casar pelo telefone errado diria
 * que somos admin de um grupo onde não somos (ou o contrário).
 */
export function findSelfParticipant<T extends { lid?: string; phone?: string }>(
  participants: readonly T[],
  ourLid: string | undefined,
  ourPhone: string | undefined
): T | undefined {
  if (ourLid) {
    const byLid = participants.find((p) => p.lid === ourLid);
    if (byLid) return byLid;
  }
  if (ourPhone) return participants.find((p) => p.phone === ourPhone);
  return undefined;
}

// ── Request builders ──

export function buildGroupListRequest(params: {
  baseUrl: string;
  token: string;
}): BridgeHttpRequest {
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/group/list`,
    headers: { token: params.token },
  };
}

export function buildGroupInfoRequest(params: {
  baseUrl: string;
  token: string;
  groupJid: string;
}): BridgeHttpRequest {
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/group/info?groupJID=${encodeURIComponent(params.groupJid)}`,
    headers: { token: params.token },
  };
}

export function buildGroupLeaveRequest(params: {
  baseUrl: string;
  token: string;
  groupJid: string;
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/group/leave`,
    headers: jsonHeaders(params.token),
    body: JSON.stringify({ GroupJID: params.groupJid }),
  };
}

export function buildGroupInviteInfoRequest(params: {
  baseUrl: string;
  token: string;
  code: string;
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/group/inviteinfo`,
    headers: jsonHeaders(params.token),
    body: JSON.stringify({ Code: params.code }),
  };
}

export function buildGroupJoinRequest(params: {
  baseUrl: string;
  token: string;
  code: string;
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/group/join`,
    headers: jsonHeaders(params.token),
    body: JSON.stringify({ Code: params.code }),
  };
}

export function buildUserLidRequest(params: {
  baseUrl: string;
  token: string;
  phone: string;
}): BridgeHttpRequest {
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/user/lid/${encodeURIComponent(params.phone)}`,
    headers: { token: params.token },
  };
}
