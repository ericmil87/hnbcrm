/**
 * Adapter PURO dos endpoints de histórico do wuzapi — a rede de recuperação do
 * bridge. Sem contexto Convex e sem fetch: só monta requisição e interpreta
 * resposta, igual a `bridgeSend.ts`/`bridgeSession.ts`. A action é quem busca.
 *
 * Por que existe: o webhook é a fonte primária, mas é efêmero. Se o deployment
 * estava fora do ar, se a assinatura de eventos estava degradada, ou se a
 * mensagem foi digitada no app do celular antes de o ingest aceitar `fromMe`,
 * aquela mensagem não existe no CRM e não volta sozinha. O gateway, por outro
 * lado, mantém uma tabela `message_history` própria quando o instance tem
 * `history > 0` — e cada linha carrega o evento whatsmeow ORIGINAL em
 * `data_json`, exatamente no formato que `parseBridgeEvent` já consome.
 *
 * Três endpoints, nesta ordem (confirmados na fonte do wuzapi):
 *   POST /session/history  {history:N}                  liga/ajusta o store
 *   GET  /session/history  ?chat_jid=&count=            pede um HistorySync ao
 *                                                       WhatsApp (ASSÍNCRONO —
 *                                                       o resultado cai no store
 *                                                       alguns segundos depois)
 *   GET  /chat/history     ?chat_jid=&limit=            lê o store de volta
 *
 * ⚠️ `GET /chat/history` responde 501 "message history is disabled for this
 * user" enquanto `history == 0` — por isso o POST vem sempre antes.
 */

/** Teto de mensagens por conversa. Default conservador: uma conversa, não um arquivo. */
export const BRIDGE_HISTORY_DEFAULT_LIMIT = 100;
export const BRIDGE_HISTORY_MIN_LIMIT = 10;
export const BRIDGE_HISTORY_MAX_LIMIT = 500;

/** Janela de importação em dias. Mais velho que isso não entra. */
export const BRIDGE_HISTORY_DEFAULT_DAYS = 7;
export const BRIDGE_HISTORY_MIN_DAYS = 1;
export const BRIDGE_HISTORY_MAX_DAYS = 30;

/**
 * Teto de conversas varridas numa sincronização. Cada conversa custa 2 chamadas
 * ao gateway (pedido + leitura); sem teto, uma org grande viraria uma rajada de
 * centenas de requisições contra o mesmo número — exatamente o padrão que o
 * WhatsApp lê como automação.
 */
export const BRIDGE_HISTORY_MAX_CHATS = 50;

export interface BridgeHttpRequestLike {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Limita um número ao intervalo aceito, com fallback para o default. */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeHistoryLimit(value: number | undefined): number {
  return clamp(value, BRIDGE_HISTORY_MIN_LIMIT, BRIDGE_HISTORY_MAX_LIMIT, BRIDGE_HISTORY_DEFAULT_LIMIT);
}

export function normalizeHistoryDays(value: number | undefined): number {
  return clamp(value, BRIDGE_HISTORY_MIN_DAYS, BRIDGE_HISTORY_MAX_DAYS, BRIDGE_HISTORY_DEFAULT_DAYS);
}

/** Telefone em dígitos (E.164 sem '+') → JID de chat 1:1 do whatsmeow. */
export function phoneToChatJid(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  return `${digits}@s.whatsapp.net`;
}

/**
 * `POST /session/history` — liga (ou reajusta) o store de mensagens do instance.
 * `history` é o teto POR CONVERSA que o gateway mantém; 0 desliga.
 */
export function buildSetHistoryRequest(params: {
  baseUrl: string;
  token: string;
  history: number;
}): BridgeHttpRequestLike {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/session/history`,
    headers: { "Content-Type": "application/json", token: params.token },
    body: JSON.stringify({ history: params.history }),
  };
}

/**
 * `GET /session/history` — pede ao WhatsApp um HistorySync sob demanda para uma
 * conversa. É um pedido, não uma leitura: a resposta 200 só diz que o pedido
 * saiu. As mensagens chegam depois, pelo socket, e o gateway as grava no store.
 */
export function buildRequestHistorySyncRequest(params: {
  baseUrl: string;
  token: string;
  chatJid: string;
  count: number;
}): BridgeHttpRequestLike {
  const qs = new URLSearchParams({ chat_jid: params.chatJid, count: String(params.count) });
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/session/history?${qs.toString()}`,
    headers: { token: params.token },
  };
}

/** `GET /chat/history` — lê o store do gateway para uma conversa. */
export function buildGetHistoryRequest(params: {
  baseUrl: string;
  token: string;
  chatJid: string;
  limit: number;
}): BridgeHttpRequestLike {
  const qs = new URLSearchParams({ chat_jid: params.chatJid, limit: String(params.limit) });
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/chat/history?${qs.toString()}`,
    headers: { token: params.token },
  };
}

/** Uma linha de `message_history`, já com o evento whatsmeow desembrulhado. */
export interface BridgeHistoryRow {
  messageId: string;
  /**
   * Quando a mensagem foi ENVIADA (ms epoch), lido de `Info.Timestamp` dentro do
   * evento — NÃO da coluna `timestamp` da linha.
   *
   * CONFIRMADO contra o gateway real (16/09/2026): a coluna é o instante em que
   * o gateway GRAVOU a linha, não o da mensagem. Numa importação de HistorySync
   * as 50 linhas vieram todas com o mesmo carimbo (o do momento do sync), embora
   * as mensagens fossem de dezembro/2025. Filtrar a janela de dias por aquela
   * coluna deixaria passar conversa de dez meses atrás como se fosse de hoje —
   * exatamente o que o teto de dias existe para impedir.
   */
  timestamp: number;
  /** O evento whatsmeow original (campo `data_json`), pronto para parseBridgeEvent. */
  event: Record<string, unknown>;
}

export type BridgeHistoryResult =
  | { ok: true; rows: BridgeHistoryRow[] }
  | { ok: false; error: string; disabled: boolean };

function pick(obj: Record<string, any> | null | undefined, ...keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * Timestamps do wuzapi chegam como string (o Go serializa `time.Time`) ou como
 * número em segundos/milissegundos. Devolve ms epoch, ou null se não der.
 */
export function parseHistoryTimestamp(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Segundos (10 dígitos) vs milissegundos (13).
    return raw > 1e11 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.length > 0) {
    // O Go pode anexar o relógio monotônico ("… m=+12.34"), que o Date rejeita.
    const cleaned = raw.split(" m=")[0].trim();
    const parsed = Date.parse(cleaned);
    if (Number.isFinite(parsed)) return parsed;
    const asNumber = Number(cleaned);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber > 1e11 ? asNumber : asNumber * 1000;
  }
  return null;
}

/**
 * Interpreta a resposta de `GET /chat/history`.
 *
 * O corpo é um array de linhas; o que interessa em cada uma é o `data_json`, uma
 * STRING com o evento whatsmeow serializado. Linha sem `data_json` utilizável é
 * descartada em silêncio: dá para reconstruir o texto a partir das colunas
 * soltas, mas o resultado não passaria pelo mesmo parser do webhook, e duas
 * rotas de parse divergentes para a mesma mensagem é como se criam bugs que só
 * aparecem no retroativo.
 */
export function parseBridgeHistoryResponse(
  httpOk: boolean,
  status: number,
  body: unknown
): BridgeHistoryResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;

  if (!httpOk || b.success === false) {
    const error =
      (typeof b.error === "string" && b.error) ||
      (typeof b.message === "string" && b.message) ||
      `Falha ao ler o histórico (HTTP ${status})`;
    // 501 = `history` ainda é 0 nesse instance. É recuperável (basta o POST
    // /session/history), então o chamador precisa distinguir isso de um erro real.
    const disabled = status === 501 || /history is disabled/i.test(error);
    return { ok: false, error, disabled };
  }

  // Conversa SEM nenhuma mensagem no store devolve `{"code":200,"data":null}`.
  // É o caso comum numa varredura (a maioria das conversas não tem histórico
  // guardado ainda) e NÃO é erro — tratar como erro fazia a rodada inteira
  // reportar falha e não importar nada. CONFIRMADO contra o gateway real.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const hasDataKey = "data" in b || "Data" in b;
    if (hasDataKey && (b.data ?? b.Data) == null) return { ok: true, rows: [] };
  }

  // O envelope do wuzapi é `{code, data, success}`, mas `data` chega ora como
  // array, ora como string JSON (o handler faz Marshal e devolve como texto).
  let data: unknown = pick(b, "data", "Data") ?? body;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, error: "Histórico em formato inesperado", disabled: false };
    }
  }
  if (!Array.isArray(data)) {
    return { ok: false, error: "Histórico em formato inesperado", disabled: false };
  }

  const rows: BridgeHistoryRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, any>;

    const messageId = pick(row, "message_id", "messageId", "MessageID");
    if (typeof messageId !== "string" || messageId.length === 0) continue;

    // `data_json` (snake_case) é o nome real na resposta — o alias `datajson` só
    // existe no SELECT interno do gateway. As outras grafias ficam por
    // tolerância a versões.
    const rawEvent = pick(row, "data_json", "datajson", "dataJson", "DataJSON");
    let event: unknown = rawEvent;
    if (typeof rawEvent === "string") {
      if (rawEvent.length === 0) continue;
      try {
        event = JSON.parse(rawEvent);
      } catch {
        continue;
      }
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;

    // Hora real da mensagem: de dentro do evento. A coluna da linha é o instante
    // da gravação no gateway e só serve de último recurso.
    const eventRecord = event as Record<string, any>;
    const info = pick(eventRecord, "Info", "info");
    const timestamp =
      parseHistoryTimestamp(pick(info, "Timestamp", "timestamp")) ??
      parseHistoryTimestamp(pick(row, "timestamp", "Timestamp"));
    if (timestamp === null) continue;

    rows.push({ messageId, timestamp, event: eventRecord });
  }

  return { ok: true, rows };
}

/**
 * Filtra as linhas que devem entrar: dentro da janela de dias e dentro do teto.
 * Ordena da mais nova para a mais antiga antes de cortar, porque o teto tem de
 * preservar o recente — é o que o operador espera ver no inbox.
 */
export function selectHistoryRows(
  rows: BridgeHistoryRow[],
  params: { now: number; days: number; limit: number }
): BridgeHistoryRow[] {
  const cutoff = params.now - params.days * 24 * 60 * 60 * 1000;
  return rows
    .filter((r) => r.timestamp >= cutoff && r.timestamp <= params.now)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, params.limit);
}
