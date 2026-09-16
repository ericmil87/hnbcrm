import { expect, test, describe } from "vitest";
import {
  BRIDGE_HISTORY_DEFAULT_DAYS,
  BRIDGE_HISTORY_DEFAULT_LIMIT,
  buildGetHistoryRequest,
  buildRequestHistorySyncRequest,
  buildSetHistoryRequest,
  normalizeHistoryDays,
  normalizeHistoryLimit,
  parseBridgeHistoryResponse,
  parseHistoryTimestamp,
  phoneToChatJid,
  selectHistoryRows,
} from "./bridgeHistory";

const BASE = "https://wa-gw.example.test/";
const TOKEN = "fake-token";

describe("normalização dos limites", () => {
  test("ausente cai no default conservador", () => {
    expect(normalizeHistoryLimit(undefined)).toBe(BRIDGE_HISTORY_DEFAULT_LIMIT);
    expect(normalizeHistoryDays(undefined)).toBe(BRIDGE_HISTORY_DEFAULT_DAYS);
  });

  test("valor fora da faixa é preso ao teto, nunca rejeitado", () => {
    // O que chega do cliente não pode virar tráfego arbitrário contra o número
    // do cliente no gateway — então limita em vez de confiar.
    expect(normalizeHistoryLimit(100000)).toBe(500);
    expect(normalizeHistoryLimit(1)).toBe(10);
    expect(normalizeHistoryDays(365)).toBe(30);
    expect(normalizeHistoryDays(0)).toBe(1);
  });

  test("lixo não-numérico cai no default em vez de virar NaN", () => {
    expect(normalizeHistoryLimit(NaN)).toBe(BRIDGE_HISTORY_DEFAULT_LIMIT);
    expect(normalizeHistoryDays(Infinity)).toBe(BRIDGE_HISTORY_DEFAULT_DAYS);
  });
});

describe("phoneToChatJid", () => {
  test("dígitos viram JID de chat 1:1", () => {
    expect(phoneToChatJid("5581999998888")).toBe("5581999998888@s.whatsapp.net");
    expect(phoneToChatJid("+55 (81) 99999-8888")).toBe("5581999998888@s.whatsapp.net");
  });

  test("telefone curto demais não vira JID", () => {
    expect(phoneToChatJid("123")).toBeNull();
    expect(phoneToChatJid("")).toBeNull();
  });
});

describe("construção das requisições", () => {
  test("barra final do gateway não duplica no path", () => {
    expect(buildSetHistoryRequest({ baseUrl: BASE, token: TOKEN, history: 100 }).url).toBe(
      "https://wa-gw.example.test/session/history"
    );
  });

  test("POST /session/history manda o teto no corpo", () => {
    const req = buildSetHistoryRequest({ baseUrl: BASE, token: TOKEN, history: 100 });
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body!)).toEqual({ history: 100 });
    expect(req.headers.token).toBe(TOKEN);
  });

  test("GET /session/history pede o sync com chat e count", () => {
    const req = buildRequestHistorySyncRequest({
      baseUrl: BASE,
      token: TOKEN,
      chatJid: "5581999998888@s.whatsapp.net",
      count: 100,
    });
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/session/history?");
    expect(req.url).toContain("chat_jid=5581999998888%40s.whatsapp.net");
    expect(req.url).toContain("count=100");
  });

  test("GET /chat/history lê com limit", () => {
    const req = buildGetHistoryRequest({
      baseUrl: BASE,
      token: TOKEN,
      chatJid: "5581999998888@s.whatsapp.net",
      limit: 50,
    });
    expect(req.url).toContain("/chat/history?");
    expect(req.url).toContain("limit=50");
  });
});

describe("parseHistoryTimestamp", () => {
  test("aceita ISO, segundos e milissegundos", () => {
    expect(parseHistoryTimestamp("2026-09-16T12:00:00Z")).toBe(Date.parse("2026-09-16T12:00:00Z"));
    expect(parseHistoryTimestamp(1789574400)).toBe(1789574400000);
    expect(parseHistoryTimestamp(1789574400000)).toBe(1789574400000);
  });

  test("tolera o relógio monotônico que o Go anexa", () => {
    // O `time.Time` do Go serializa como "… +0000 UTC m=+123.45"; sem limpar o
    // sufixo o Date.parse devolve NaN e a linha inteira seria descartada.
    const raw = "2026-09-16 12:00:00 +0000 UTC m=+1234.567";
    expect(parseHistoryTimestamp(raw)).not.toBeNull();
  });

  test("lixo devolve null em vez de NaN", () => {
    expect(parseHistoryTimestamp("nao é data")).toBeNull();
    expect(parseHistoryTimestamp(null)).toBeNull();
  });
});

describe("parseBridgeHistoryResponse", () => {
  // `data_json` em snake_case é o nome REAL na resposta (verificado contra o
  // gateway em 16/09/2026). O alias `datajson` só existe no SELECT interno do
  // wuzapi — procurar por ele importaria zero mensagem.
  const row = (id: string, ts: string, conv: string, msgTs?: string) => ({
    message_id: id,
    timestamp: ts,
    data_json: JSON.stringify({
      Info: {
        ID: id,
        Chat: "5581999998888@s.whatsapp.net",
        IsFromMe: true,
        ...(msgTs ? { Timestamp: msgTs } : {}),
      },
      Message: { conversation: conv },
    }),
  });

  test("501 é sinalizado como 'desligado', não como erro genérico", () => {
    // Distinguir importa: 501 se conserta com POST /session/history; um erro de
    // rede não. Tratar os dois igual faria a UI mandar o operador para o lugar
    // errado.
    const result = parseBridgeHistoryResponse(false, 501, {
      success: false,
      error: "message history is disabled for this user",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.disabled).toBe(true);
  });

  test("erro de rede não é confundido com histórico desligado", () => {
    const result = parseBridgeHistoryResponse(false, 500, { error: "boom" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.disabled).toBe(false);
      expect(result.error).toBe("boom");
    }
  });

  test("desembrulha o array direto", () => {
    const result = parseBridgeHistoryResponse(true, 200, [
      row("A1", "2026-09-16T12:00:00Z", "oi"),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].messageId).toBe("A1");
      expect((result.rows[0].event as any).Message.conversation).toBe("oi");
    }
  });

  test("desembrulha `data` que veio como string JSON", () => {
    // O handler do wuzapi faz Marshal e devolve como texto — o mesmo endpoint
    // responde nas duas formas dependendo do caminho.
    const result = parseBridgeHistoryResponse(true, 200, {
      success: true,
      data: JSON.stringify([row("A2", "2026-09-16T12:00:00Z", "olá")]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].messageId).toBe("A2");
  });

  test("conversa sem histórico (`data: null`) é lista vazia, não erro", () => {
    // Forma real do gateway para um chat sem nada no store. É o caso COMUM numa
    // varredura; tratar como erro fazia a rodada inteira reportar falha.
    const result = parseBridgeHistoryResponse(true, 200, { code: 200, data: null, success: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([]);
  });

  test("a hora vem do EVENTO, não da coluna da linha", () => {
    // A coluna `timestamp` é o instante em que o gateway GRAVOU a linha. Numa
    // importação de HistorySync todas as linhas vêm com o mesmo carimbo (o do
    // sync), mesmo sendo mensagens de meses atrás — filtrar por ela faria uma
    // conversa antiga inteira passar pela janela de 7 dias como se fosse de hoje.
    const result = parseBridgeHistoryResponse(true, 200, [
      row("A9", "2026-09-16T16:27:24.963978Z", "antiga", "2025-12-09T17:12:57-03:00"),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].timestamp).toBe(Date.parse("2025-12-09T17:12:57-03:00"));
    }
  });

  test("sem Info.Timestamp, cai na coluna da linha", () => {
    const result = parseBridgeHistoryResponse(true, 200, [
      row("A10", "2026-09-16T12:00:00Z", "sem carimbo no evento"),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].timestamp).toBe(Date.parse("2026-09-16T12:00:00Z"));
    }
  });

  test("forma real do gateway (fixture capturada em 16/09/2026)", () => {
    // Recorte fiel de uma linha devolvida pelo gateway de produção: envelope
    // `{code,data,success}` com `data` já como array, `data_json` em snake_case
    // e o `Info` completo do whatsmeow.
    const result = parseBridgeHistoryResponse(true, 200, {
      code: 200,
      success: true,
      data: [
        {
          id: 1,
          user_id: "f99ee5a2b67fae60edf792e6cc8e1400",
          chat_jid: "558181392929@s.whatsapp.net",
          sender_jid: "558181392929@s.whatsapp.net",
          message_id: "3EB0EC212D6632A92E8998",
          timestamp: "2026-09-16T16:27:24.963978Z",
          message_type: "text",
          text_content: "plano",
          media_link: "",
          data_json: JSON.stringify({
            Info: {
              Chat: "558181392929@s.whatsapp.net",
              Sender: "558181392929@s.whatsapp.net",
              IsFromMe: false,
              IsGroup: false,
              AddressingMode: "",
              SenderAlt: "",
              RecipientAlt: "",
              ID: "3EB0EC212D6632A92E8998",
              Type: "text",
              PushName: "Eric Milfont",
              Timestamp: "2025-12-09T17:12:57-03:00",
            },
            Message: { conversation: "plano" },
            RawMessage: { conversation: "plano" },
          }),
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].messageId).toBe("3EB0EC212D6632A92E8998");
    expect(result.rows[0].timestamp).toBe(Date.parse("2025-12-09T17:12:57-03:00"));
    expect((result.rows[0].event as any).Message.conversation).toBe("plano");
  });

  test("linha sem datajson utilizável é descartada em silêncio", () => {
    // Dá para reconstruir o texto das colunas soltas, mas aí a mesma mensagem
    // teria dois parsers diferentes (webhook vs retroativo) — é assim que se
    // cria bug que só aparece na recuperação.
    const result = parseBridgeHistoryResponse(true, 200, [
      { message_id: "A3", timestamp: "2026-09-16T12:00:00Z", data_json: "" },
      { message_id: "A4", timestamp: "2026-09-16T12:00:00Z", data_json: "{quebrado" },
      { message_id: "", timestamp: "2026-09-16T12:00:00Z", data_json: "{}" },
      row("A5", "2026-09-16T12:00:00Z", "válida"),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.map((r) => r.messageId)).toEqual(["A5"]);
    }
  });

  test("corpo em formato inesperado não estoura", () => {
    const result = parseBridgeHistoryResponse(true, 200, { success: true, data: "não é json" });
    expect(result.ok).toBe(false);
  });
});

describe("selectHistoryRows", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const mk = (id: string, offsetDays: number) => ({
    messageId: id,
    timestamp: now - offsetDays * day,
    event: {},
  });

  test("corta o que está fora da janela de dias", () => {
    const rows = selectHistoryRows([mk("recente", 1), mk("antiga", 30)], {
      now,
      days: 7,
      limit: 100,
    });
    expect(rows.map((r) => r.messageId)).toEqual(["recente"]);
  });

  test("o teto preserva o RECENTE, não o primeiro que veio", () => {
    // Se o corte fosse pela ordem de chegada, um gateway que devolve o mais
    // antigo primeiro entregaria justamente o que ninguém quer ver no inbox.
    const rows = selectHistoryRows([mk("velha", 5), mk("nova", 1), mk("média", 3)], {
      now,
      days: 7,
      limit: 2,
    });
    expect(rows.map((r) => r.messageId)).toEqual(["nova", "média"]);
  });

  test("mensagem com carimbo no futuro não entra", () => {
    const rows = selectHistoryRows([{ messageId: "futuro", timestamp: now + day, event: {} }], {
      now,
      days: 7,
      limit: 100,
    });
    expect(rows).toHaveLength(0);
  });
});
