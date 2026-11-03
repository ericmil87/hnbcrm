/**
 * Cartões do Telegram (F1): paridade tipo → template, goldens dos exemplos da
 * §4 do plano, modo discreto, `callback_data` ≤ 64 bytes, nunca e-mail.
 */
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  IGNORED_FOR_TELEGRAM,
  TELEGRAM_TEMPLATES,
  buildAiRelayCard,
  buildHistoryCard,
  buildNotificationCard,
  buildRecordCard,
  callbackData,
  formatWhen,
  parseCallbackData,
  tomorrowAt,
  type CardContext,
  type NotificationInput,
} from "./telegramNotifications";

const TZ = "America/Sao_Paulo";
// 03/11/2026 14:31 em São Paulo (UTC−3).
const NOW = Date.UTC(2026, 10, 3, 17, 31);
const HID = "h0000000000000000000000000000001";
const CID = "c0000000000000000000000000000001";
const LID = "l0000000000000000000000000000001";
const TID = "t0000000000000000000000000000001";
const DID = "m0000000000000000000000000000001";

function ctx(over: Partial<CardContext> = {}): CardContext {
  return {
    orgName: "Acme Corp",
    timezone: TZ,
    currency: "BRL",
    appBaseUrl: "https://app.example.test",
    discreet: false,
    now: NOW,
    lead: {
      id: LID,
      title: "Maria Souza",
      phone: "5511987654321",
      value: 4800,
      stageName: "Proposta enviada",
      boardName: "Vendas",
    },
    conversation: { id: CID, channel: "whatsapp" },
    handoff: {
      id: HID,
      status: "pending",
      reason: "pediu desconto no plano anual e quer falar com uma pessoa.",
      summary: "3ª conversa; recebeu proposta ontem; agora pede 15% de desconto.",
      fromAi: true,
    },
    lastInbound: {
      text: "Oi, vocês conseguem fazer 15% no anual? Senão prefiro falar com alguém da equipe",
      at: NOW - 60_000,
    },
    ...over,
  };
}

const handoffN: NotificationInput = {
  _id: "n1",
  type: "handoff_requested",
  title: "Repasse: Maria Souza",
  createdAt: NOW,
  handoffId: HID,
  conversationId: CID,
};

describe("paridade tipo → template", () => {
  test("todo tipo do schema tem template ou está em IGNORED_FOR_TELEGRAM", () => {
    const union = (schema.tables.notifications.validator as any).fields.type.members.map((m: any) => m.value) as string[];
    expect(union.length).toBeGreaterThan(15);
    const missing = union.filter((t) => !(t in TELEGRAM_TEMPLATES) && !IGNORED_FOR_TELEGRAM.has(t as any));
    expect(missing, "Tipo de notificação novo sem decisão para o Telegram").toEqual([]);
    expect(union).toContain("new_message");
  });
});

describe("goldens (§4)", () => {
  test("4.2 repasse em modo completo", () => {
    const card = buildNotificationCard({ notification: handoffN, context: ctx() });
    expect(card.text).toBe(
      [
        "🔔 Repasse da IA · Acme Corp · 14:31",
        "<b>Maria Souza</b> · WhatsApp · +55 11 98765-4321 · Vendas › Proposta enviada · R$ 4.800",
        "Motivo: pediu desconto no plano anual e quer falar com uma pessoa.",
        "Resumo: 3ª conversa; recebeu proposta ontem; agora pede 15% de desconto.",
        '<blockquote expandable>Maria (14:30): "Oi, vocês conseguem fazer 15% no anual? Senão prefiro falar com alguém da equipe"</blockquote>',
      ].join("\n"),
    );
    expect(card.keyboard).toEqual([
      [
        { text: "✅ Aceitar", callback_data: `ah:${HID}` },
        { text: "🤖 Instruir a IA", callback_data: `ia:${CID}` },
        { text: "🔁 Regenerar", callback_data: `rg:${CID}` },
      ],
      [{ text: "👁 Ver tudo", callback_data: `va:${CID}` }],
      [
        { text: "📱 Abrir no WhatsApp", url: "https://wa.me/5511987654321" },
        { text: "🔗 Abrir no CRM", url: `https://app.example.test/app/repasses?handoff=${HID}` },
      ],
    ]);
    expect(card.focus).toEqual({ conversationId: CID, leadId: LID, handoffId: HID });
  });

  test("4.11 modo discreto: iniciais, sem telefone, 200 chars mascarados, sem WhatsApp nem Ver tudo", () => {
    const long = `Meu CPF é 123.456.789-00 e o telefone 11 98765-4321. ${"x".repeat(300)}`;
    const card = buildNotificationCard({
      notification: handoffN,
      context: ctx({ discreet: true, lastInbound: { text: long, at: NOW - 60_000 } }),
    });
    expect(card.text).toContain("<b>M. S.</b> · WhatsApp · Vendas › Proposta enviada · R$ 4.800");
    expect(card.text).not.toContain("98765");
    expect(card.text).not.toContain("123.456");
    expect(card.text).toContain("•••8900");
    expect(card.text).not.toContain("Resumo:");
    expect(card.text).not.toContain("Maria");
    const quote = card.text.match(/<blockquote expandable>([\s\S]*)<\/blockquote>/)![1]!;
    expect(quote.length).toBeLessThan(230);
    const buttons = card.keyboard.flat();
    expect(buttons.some((b) => "url" in b && b.url.startsWith("https://wa.me"))).toBe(false);
    expect(buttons.some((b) => "callback_data" in b && b.callback_data.startsWith("va:"))).toBe(false);
  });

  test("4.6 tarefa com Concluir, Adiar 1h, Amanhã 9h", () => {
    const card = buildNotificationCard({
      notification: { _id: "n2", type: "task_due_soon", title: "Tarefa vence em 1h", createdAt: NOW, taskId: TID },
      context: ctx({
        handoff: undefined,
        conversation: undefined,
        lastInbound: undefined,
        lead: { id: LID, title: "Rejane Alves", value: 1200 },
        task: { id: TID, title: "Ligar para Dona Rejane sobre a renovação", dueDate: NOW + 3600_000, status: "pending" },
      }),
    });
    expect(card.text).toBe(
      '📌 Tarefa vence em breve · 15:31\n"Ligar para Dona Rejane sobre a renovação" · lead Rejane Alves · R$ 1.200',
    );
    expect(card.keyboard).toEqual([
      [
        { text: "✅ Concluir", callback_data: `ct:${TID}` },
        { text: "⏰ Adiar 1h", callback_data: `sz1:${TID}` },
        { text: "🌅 Amanhã 9h", callback_data: `sz9:${TID}` },
      ],
      [{ text: "🔗 Abrir tarefa", url: `https://app.example.test/app/tarefas?task=${TID}` }],
    ]);
  });

  test("relay da IA → lead", () => {
    const card = buildAiRelayCard(ctx({ handoff: undefined }), {
      text: "Oi Maria! Consigo garantir 10% até sexta. Você prefere boleto ou Pix?",
      at: NOW + 3 * 60_000,
    });
    expect(card.text).toBe(
      "🤖 IA → <b>Maria Souza</b> · 14:34\n<blockquote expandable>Oi Maria! Consigo garantir 10% até sexta. Você prefere boleto ou Pix?</blockquote>",
    );
    expect(card.keyboard[0]).toEqual([
      { text: "🔁 Regenerar", callback_data: `rg:${CID}` },
      { text: "🙋 Assumir eu", callback_data: `ae:${CID}` },
      { text: "👁 Ver tudo", callback_data: `va:${CID}` },
    ]);
  });

  test("new_message: linhas curtas citadas, mídia como linha de texto", () => {
    const card = buildNotificationCard({
      notification: { _id: "n3", type: "new_message", title: "Maria Souza · WhatsApp", createdAt: NOW, conversationId: CID },
      context: ctx({
        handoff: undefined,
        relayLines: [
          { at: NOW + 10 * 60_000, author: "", text: "Pix! Me manda a chave que eu pago hoje ainda 🙏" },
          { at: NOW + 10 * 60_000, author: "", text: "[imagem] comprovante" },
        ],
      }),
    });
    expect(card.text).toBe(
      '💬 <b>Maria Souza</b> · WhatsApp · 14:41\n"Pix! Me manda a chave que eu pago hoje ainda 🙏"\n"[imagem] comprovante"',
    );
    expect(card.keyboard[0]).toEqual([
      { text: "💬 Responder", callback_data: `rp:${CID}` },
      { text: "🤖 Instruir a IA", callback_data: `ia:${CID}` },
    ]);
  });

  test("rascunho da IA: Enviar · Regenerar · Descartar", () => {
    const card = buildNotificationCard({
      notification: { _id: "n4", type: "ai_draft_pending", title: "Rascunho", createdAt: NOW, conversationId: CID },
      context: ctx({ handoff: undefined, draft: { messageId: DID, text: "Maria, segue a chave Pix <x>" } }),
    });
    expect(card.text).toContain("<blockquote expandable>Maria, segue a chave Pix &lt;x&gt;</blockquote>");
    expect(card.keyboard[0]).toEqual([
      { text: "📤 Enviar", callback_data: `sd:${DID}` },
      { text: "🔁 Regenerar", callback_data: `rg:${CID}` },
      { text: "🗑 Descartar", callback_data: `dd:${DID}` },
    ]);
  });

  test("repasse já aceito na entrega: aviso e só Ver tudo/CRM", () => {
    const card = buildNotificationCard({
      notification: handoffN,
      context: ctx({ handoff: { ...ctx().handoff!, status: "accepted", acceptedByName: "Ana" } }),
    });
    expect(card.text).toContain("⚠️ Repasse já aceito por Ana");
    expect(card.keyboard.flat().some((b) => "callback_data" in b && b.callback_data.startsWith("ah:"))).toBe(false);
  });

  test("genérico: título/corpo + Abrir no CRM pelo ponteiro", () => {
    const card = buildNotificationCard({
      notification: { _id: "n5", type: "channel_session_lost", title: "WhatsApp (…1234) caiu", createdAt: NOW },
      context: ctx({ lead: undefined, conversation: undefined, handoff: undefined, lastInbound: undefined }),
    });
    expect(card.text).toBe("🔴 WhatsApp (…1234) caiu");
    expect(card.keyboard).toEqual([
      [{ text: "🔗 Abrir no CRM", url: "https://app.example.test/app/configuracoes?secao=channels" }],
    ]);
  });
});

describe("segurança do texto", () => {
  test("nunca e-mail, em nenhum modo; HTML do cliente escapado", () => {
    for (const discreet of [false, true]) {
      const card = buildNotificationCard({
        notification: { ...handoffN, title: "x" },
        context: ctx({
          discreet,
          lead: { id: LID, title: "Maria maria@cliente.com" },
          lastInbound: { text: "me escreve em maria@cliente.com <script>", at: NOW },
        }),
      });
      expect(card.text).not.toMatch(/@cliente\.com/);
      expect(card.text).not.toContain("<script>");
    }
  });

  test("Ver tudo: histórico com Resumir primeiro e sem o próprio Ver tudo", () => {
    const base = buildNotificationCard({ notification: handoffN, context: ctx() });
    const hist = buildHistoryCard(
      ctx(),
      [
        { at: NOW - 86_400_000, author: "IA", text: "Segue a proposta." },
        { at: NOW - 60_000, author: "Maria", text: "Oi <b>" },
      ],
      base.keyboard,
    );
    expect(hist.text).toBe(
      "🗂 <b>Maria Souza</b> · últimas 2 mensagens\n<b>IA</b> (ontem 14:31): Segue a proposta.\n<b>Maria</b> (14:30): Oi &lt;b&gt;",
    );
    expect(hist.keyboard[0]).toEqual([{ text: "📝 Resumir", callback_data: `rs:${CID}` }]);
    expect(hist.keyboard.flat().some((b) => "callback_data" in b && b.callback_data.startsWith("va:"))).toBe(false);
  });

  test("registro de corrida: só CRM, sem botões de ação", () => {
    const rec = buildRecordCard(ctx(), "⚠️ Repasse já aceito por Ana · 14:32", ["viewAll", "crm"]);
    expect(rec.keyboard).toEqual([
      [{ text: "👁 Ver tudo", callback_data: `va:${CID}` }],
      [{ text: "🔗 Abrir no CRM", url: `https://app.example.test/app/entrada?conversation=${CID}` }],
    ]);
  });
});

describe("callback_data e datas", () => {
  test("≤ 64 bytes, verbo conhecido, id válido", () => {
    const longestId = "j".repeat(32);
    expect(callbackData("sz9", longestId).length).toBeLessThanOrEqual(64);
    expect(parseCallbackData(`ah:${HID}`)).toEqual({ verb: "ah", id: HID });
    expect(parseCallbackData("zz:abc")).toBeNull();
    expect(parseCallbackData(`ah:${"x".repeat(70)}`)).toBeNull();
    expect(parseCallbackData("ah:../../x")).toBeNull();
    expect(() => callbackData("ah", "x".repeat(70))).toThrow(/64 bytes/);
  });

  test("Amanhã 9h no fuso da org e 'ontem'", () => {
    const at = tomorrowAt(NOW, TZ, 9);
    expect(at).toBe(Date.UTC(2026, 10, 4, 12, 0));
    expect(formatWhen(NOW - 86_400_000, NOW, TZ)).toBe("ontem 14:31");
    expect(formatWhen(NOW - 3 * 86_400_000, NOW, TZ)).toBe("31/10 14:31");
    // Manaus (UTC−4)
    expect(tomorrowAt(NOW, "America/Manaus", 9)).toBe(Date.UTC(2026, 10, 4, 13, 0));
  });
});

describe("modo discreto: nome do cliente nunca por extenso (revisão F1 #4)", () => {
  const discreet = (over: Partial<CardContext> = {}) =>
    ctx({ discreet: true, handoff: undefined, lastInbound: undefined, ...over });

  test("conversation_transferred: corpo = iniciais", () => {
    const card = buildNotificationCard({
      notification: {
        _id: "t1", type: "conversation_transferred", title: "Ana transferiu Maria Souza para você",
        body: "Maria Souza", createdAt: NOW, conversationId: CID,
      },
      context: discreet(),
    });
    expect(card.text).not.toMatch(/Maria|Souza/);
    expect(card.text).toBe("➡️ Ana transferiu M. S. para você\nM. S.\n<b>M. S.</b> · WhatsApp · Vendas › Proposta enviada · R$ 4.800");
  });

  test("handoff_resolved: corpo (título do lead) vira iniciais", () => {
    const card = buildNotificationCard({
      notification: { _id: "t2", type: "handoff_resolved", title: "Repasse aceito por Ana", body: "Maria Souza", createdAt: NOW, handoffId: HID },
      context: discreet(),
    });
    expect(card.text).toBe("✅ Repasse aceito por Ana\nM. S.");
  });

  test("tarefa: nome no título vira iniciais; sem lead conhecido o título some", () => {
    const withLead = buildNotificationCard({
      notification: { _id: "t3", type: "task_assigned", title: "Nova tarefa", createdAt: NOW, taskId: TID },
      context: discreet({
        conversation: undefined,
        task: { id: TID, title: "Ligar para a maria souza amanhã", status: "pending" },
      }),
    });
    expect(withLead.text).toBe('📌 Nova tarefa para você\n"Ligar para a M. S. amanhã" · lead M. S. · R$ 4.800');
    const noLead = buildNotificationCard({
      notification: { _id: "t4", type: "task_assigned", title: "Nova tarefa", createdAt: NOW, taskId: TID },
      context: discreet({ lead: undefined, conversation: undefined, task: { id: TID, title: "Ligar para Maria", status: "pending" } }),
    });
    expect(noLead.text).toBe('📌 Nova tarefa para você\n"Tarefa"');
  });

  test("follow-up: título e corpo com o nome redigidos", () => {
    const card = buildNotificationCard({
      notification: {
        _id: "t5", type: "ai_followup_needs_human", title: "Follow-up de Maria precisa de você",
        body: "Maria Souza não respondeu", createdAt: NOW, conversationId: CID,
      },
      context: discreet(),
    });
    expect(card.text).not.toMatch(/Maria|Souza/);
    expect(card.text).toContain("⚠️ Follow-up de M. S. precisa de você\nM. S. não respondeu");
  });
});
