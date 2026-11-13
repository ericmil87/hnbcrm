/// <reference types="vite/client" />
/**
 * O atendente LÊ o PDF recebido (`pdfRead.ts`): texto extraído no recebimento,
 * gravado na mensagem e entregue ao histórico; PDF escaneado vira leitura da
 * imagem embutida (visão) ou resposta honesta; nada disso chama LLM para texto.
 *
 * Timers REAIS: o worker do pdf.js depende de `setTimeout`. O único teste que
 * precisa do relógio falso (claim com debounce) liga-o por conta própria.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { assemblePdf, scannedPdf, stream, textPdf } from "./lib/pdfTestFixtures.test-helper";
import { findFirstEmbeddedJpeg } from "./lib/pdfEmbeddedJpeg";
import { pdfHistoryText, PDF_READ_MAX_BYTES } from "./lib/pdfRead";
import { hasMediaAwaitingEnrichment, historyTextOf } from "./attendant";
import { schedulePdfRead } from "./lib/mediaEnrichment";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.stubEnv("WHISPER_SERVICE_URL", "");
  vi.stubEnv("OPENCODE_GO_API", "key-de-teste");
  vi.stubEnv("OPENROUTER_API_KEY", "");
});
let current: TestConvex<typeof schema> | null = null;
function mk() {
  current = convexTest(schema, modules);
  return current;
}
afterEach(async () => {
  // Jobs agendados pelo ingest (runAfter 0) não podem disparar depois do teste.
  if (current) {
    const t = current;
    current = null;
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    await t.finishInProgressScheduledFunctions();
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function seedOrg(
  t: TestConvex<typeof schema>,
  opts?: { visionEnabled?: boolean; attendantEnabled?: boolean; aiOff?: boolean }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org PDF",
      slug: "org-pdf",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: opts?.aiOff ? false : true,
          autoAssign: false,
          handoffThreshold: 0.8,
          ...(opts?.visionEnabled ? { visionEnabled: true } : {}),
          ...(opts?.attendantEnabled === false ? { attendantEnabled: false } : {}),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@pdf.test" });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Humano", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" }, createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: humanId } } },
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Número", phoneNumberId: "555000333",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511955554444", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente", contactId, boardId, stageId, assignedTo: agentId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active",
      lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { organizationId, leadId, conversationId, configId };
  });
}

async function storeFile(
  t: TestConvex<typeof schema>,
  seed: Seed,
  bytes: Uint8Array,
  opts?: { name?: string; mimeType?: string; sizeOverride?: number }
): Promise<Id<"files">> {
  return await t.run(async (ctx) => {
    const mimeType = opts?.mimeType ?? "application/pdf";
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: mimeType }));
    return await ctx.db.insert("files", {
      organizationId: seed.organizationId,
      storageId,
      name: opts?.name ?? "Comprovante_20261113_145715.pdf",
      mimeType,
      size: opts?.sizeOverride ?? bytes.byteLength,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
  });
}

/** Chega pelo ingest REAL (1:1, sem acordar o atendente). */
async function receivePdf(t: TestConvex<typeof schema>, seed: Seed, fileId: Id<"files">, content?: string) {
  // setTimeout falso só durante o ingest: o job `runAfter(0)` fica registrado
  // (assert de agendamento) mas não dispara sozinho no meio do teste.
  const wasFake = vi.isFakeTimers();
  if (!wasFake) vi.useFakeTimers({ toFake: ["setTimeout"] });
  const id = await t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId: seed.organizationId,
    leadId: seed.leadId,
    channel: "whatsapp",
    channelConfigId: seed.configId,
    content: content ?? "Comprovante_20261113_145715.pdf",
    contentType: "file",
    attachments: [fileId],
    skipAiEnqueue: true,
    metadata: { bridgeType: "document" },
  });
  if (!wasFake) vi.useRealTimers();
  return id as Id<"messages">;
}

const getMsg = (t: TestConvex<typeof schema>, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
const scheduledPdfReads = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.includes("pdfRead:internalReadPdf"))
  );

const COMPROVANTE = [
  "Comprovante de transferencia Pix",
  "Valor: R$ 1.247,90",
  "Data: 13/11/2026 14:57",
  "Pagador: Carlos Henrique da Silva",
];

// ── JPEG sintético (marcadores válidos; só a estrutura importa) ─────────────
function fakeJpeg(opts?: { components?: number; size?: number }): Buffer {
  const comps = opts?.components ?? 3;
  const head = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 8 + comps * 3, 0x08, 0x01, 0x90, 0x01, 0x90, comps,
    ...Array.from({ length: comps * 3 }, (_, i) => (i % 3 === 0 ? i / 3 + 1 : 0x11)),
  ]);
  const pad = Buffer.alloc(opts?.size ?? 12 * 1024, 0x55);
  return Buffer.concat([head, pad, Buffer.from([0xff, 0xd9])]);
}

function jpegPdf(jpeg: Buffer, dictExtra = ""): Buffer {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    stream("", Buffer.from("q 500 0 0 700 50 70 cm /Im1 Do Q", "latin1")),
    stream(`/Type /XObject /Subtype /Image /Width 400 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ${dictExtra}`, jpeg),
  ]);
}

function visionResponse() {
  const json = JSON.stringify({
    imagem_recebida: true,
    descricao: "Comprovante de Pix de R$ 1.247,90 realizado em 13/11/2026.",
    tipo: "comprovante",
    campos: { valor: "R$ 1.247,90" },
  });
  return new Response(
    JSON.stringify({
      id: "x",
      choices: [{ index: 0, message: { role: "assistant", content: json }, finish_reason: "stop" }],
      usage: { prompt_tokens: 495, completion_tokens: 200 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("extração no recebimento", () => {
  test("PDF de texto: agenda no ingest, grava o texto e o estado, e o histórico mostra o texto", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const fileId = await storeFile(t, seed, textPdf([COMPROVANTE]));
    const messageId = await receivePdf(t, seed, fileId);

    expect((await getMsg(t, messageId))!.metadata!.docRead.status).toBe("pending");
    expect(await scheduledPdfReads(t)).toHaveLength(1);

    const out = await t.action(internal.pdfRead.internalReadPdf, { messageId });
    expect(out.status).toBe("done");

    const m = (await getMsg(t, messageId))!;
    expect(m.metadata!.docRead).toMatchObject({ status: "done", kind: "pdf", pages: 1, fileName: "Comprovante_20261113_145715.pdf" });
    expect(m.imageDescription).toContain("Valor: R$ 1.247,90");
    // pesquisável pelo mesmo campo dobrado da busca (sem índice novo)
    expect(m.searchNorm).toContain("1.247,90");
    const text = historyTextOf(m as any, { visionEnabled: false });
    expect(text.startsWith('[arquivo PDF "Comprovante_20261113_145715.pdf" — texto extraído]: ')).toBe(true);
    expect(text).toContain("Pagador: Carlos Henrique da Silva");
    expect(text).not.toContain("não consigo abrir");
  });

  test("legenda do cliente é preservada", () => {
    const text = historyTextOf(
      {
        direction: "inbound",
        contentType: "file",
        content: "segue o comprovante",
        imageDescription: "Valor R$ 10,00",
        metadata: { docRead: { status: "done", at: 1, fileName: "c.pdf" } },
      },
      {}
    );
    expect(text).toBe('[arquivo PDF "c.pdf" — texto extraído]: Valor R$ 10,00 — legenda do cliente: "segue o comprovante"');
  });

  test("idempotente: segunda execução não relê (claim)", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    expect((await t.action(internal.pdfRead.internalReadPdf, { messageId })).status).toBe("done");
    const at = (await getMsg(t, messageId))!.metadata!.docRead.at;
    expect((await t.action(internal.pdfRead.internalReadPdf, { messageId })).status).toBe("claimed_elsewhere");
    expect((await getMsg(t, messageId))!.metadata!.docRead.at).toBe(at);
  });

  test("texto longo é cortado em 6.000 caracteres", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const lines = Array.from({ length: 120 }, (_, i) => `Linha ${i} do contrato com texto bastante longo para encher a pagina inteira`);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([lines.slice(0, 55), lines.slice(55)])));
    await t.action(internal.pdfRead.internalReadPdf, { messageId });
    const m = (await getMsg(t, messageId))!;
    expect(m.imageDescription!.length).toBeLessThanOrEqual(6000);
    expect(m.metadata!.docRead.truncated).toBe(true);
  });

  test("arquivo .pdf que não é PDF: recusado, nada é lido, histórico segue o marcador antigo", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const fake = new TextEncoder().encode("MZ isto nao e um pdf, e sim um executavel disfarcado");
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, fake, { name: "fatura.pdf" }), "fatura.pdf");
    const out = await t.action(internal.pdfRead.internalReadPdf, { messageId });
    expect(out.status).toBe("skipped");
    const m = (await getMsg(t, messageId))!;
    expect(m.metadata!.docRead).toMatchObject({ status: "skipped", error: "NOT_PDF" });
    expect(m.imageDescription).toBeUndefined();
    expect(historyTextOf(m as any, {})).toBe("[arquivo recebido: fatura.pdf — não consigo abrir arquivos]");
  });

  test("arquivo acima do teto: falha direto no ingest, sem action, com motivo no histórico", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const fileId = await storeFile(t, seed, textPdf([COMPROVANTE]), { sizeOverride: PDF_READ_MAX_BYTES + 1 });
    const messageId = await receivePdf(t, seed, fileId);
    expect(await scheduledPdfReads(t)).toHaveLength(0);
    const m = (await getMsg(t, messageId))!;
    expect(m.metadata!.docRead).toMatchObject({ status: "failed", error: "TOO_LARGE" });
    expect(historyTextOf(m as any, {})).toContain("não consegui ler (grande demais)");
  });

  test("PDF criptografado: falha fechada com motivo", async () => {
    const { encryptedPdf } = await import("./lib/pdfTestFixtures.test-helper");
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, encryptedPdf()));
    expect((await t.action(internal.pdfRead.internalReadPdf, { messageId })).status).toBe("failed");
    const m = (await getMsg(t, messageId))!;
    expect(m.metadata!.docRead.error).toBe("ENCRYPTED");
    expect(historyTextOf(m as any, {})).toContain("protegido por senha");
  });

  test("org sem atendente ativo (IA desligada ou atendente off): não agenda nada", async () => {
    for (const opts of [{ aiOff: true }, { attendantEnabled: false }]) {
      const t = mk();
      const seed = await seedOrg(t, opts);
      const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
      expect(await scheduledPdfReads(t)).toHaveLength(0);
      const m = (await getMsg(t, messageId))!;
      expect(m.metadata!.docRead).toBeUndefined();
      expect(historyTextOf(m as any, {})).toContain("não consigo abrir arquivos");
    }
  });

  test("não depende da visão ligada: org com visão desligada também lê o texto", async () => {
    const t = mk();
    const seed = await seedOrg(t, { visionEnabled: false });
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    expect((await t.action(internal.pdfRead.internalReadPdf, { messageId })).status).toBe("done");
  });

  test("planilha/docx/vídeo não agendam", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const fileId = await storeFile(t, seed, new Uint8Array([1, 2, 3]), {
      name: "tabela.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const messageId = await receivePdf(t, seed, fileId, "tabela.xlsx");
    expect(await scheduledPdfReads(t)).toHaveLength(0);
    expect((await getMsg(t, messageId))!.metadata!.docRead).toBeUndefined();
  });

  test("grupo: mídia adiada (política) não agenda; só depois de baixada (anexo sem mediaDeferred)", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const fileId = await storeFile(t, seed, textPdf([COMPROVANTE]));
    const messageId = await receivePdf(t, seed, fileId);
    // zera o estado do ingest e simula a mensagem de grupo ainda adiada
    await t.run(async (ctx) => {
      const m = (await ctx.db.get(messageId))!;
      const { docRead: _d, ...rest } = m.metadata!;
      await ctx.db.patch(messageId, { metadata: { ...rest, mediaDeferred: { kind: "document" } } });
    });
    expect(await t.run((ctx) => schedulePdfRead(ctx, { messageId, contentType: "file", attachments: [fileId], metadata: { mediaDeferred: {} } }))).toBe(false);
    // concluída a política (metadata sem mediaDeferred): agenda como o 1:1
    await t.run(async (ctx) => {
      const m = (await ctx.db.get(messageId))!;
      const { mediaDeferred: _x, ...rest } = m.metadata!;
      await ctx.db.patch(messageId, { metadata: rest });
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    expect(await t.run((ctx) => schedulePdfRead(ctx, { messageId, contentType: "file", attachments: [fileId], metadata: {} }))).toBe(true);
    vi.useRealTimers();
  });

  test("PDF enviado pela equipe: extrai sem acordar a IA e o histórico diz o que foi enviado", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const fileId = await storeFile(t, seed, textPdf([["Tabela de precos 2026", "Corte de cabelo R$ 80,00", "Barba R$ 50,00"]]), {
      name: "tabela.pdf",
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const messageId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        organizationId: seed.organizationId, conversationId: seed.conversationId, leadId: seed.leadId,
        direction: "outbound", senderType: "human", content: "tabela.pdf", contentType: "file", isInternal: false,
        attachments: [fileId], createdAt: Date.now(),
      });
      await schedulePdfRead(ctx, { messageId: id, contentType: "file", attachments: [fileId], isInternal: false });
      return id;
    });
    vi.useRealTimers();
    await t.action(internal.pdfRead.internalReadPdf, { messageId });
    const m = (await getMsg(t, messageId))!;
    expect(historyTextOf(m as any, {})).toContain('[arquivo PDF enviado "tabela.pdf" — texto extraído]: Tabela de precos 2026');
    expect(await t.run((ctx) => ctx.db.query("aiReplyQueue").collect())).toHaveLength(0);
  });
});

describe("PDF escaneado", () => {
  test("sem visão e sem JPEG: estado scanned e texto honesto (a IA pede um print)", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, scannedPdf()));
    expect((await t.action(internal.pdfRead.internalReadPdf, { messageId })).status).toBe("scanned");
    const m = (await getMsg(t, messageId))!;
    expect(m.metadata!.docRead).toMatchObject({ status: "scanned" });
    expect(m.imageDescription).toBeUndefined();
    expect(historyTextOf(m as any, {})).toBe(
      '[arquivo PDF "Comprovante_20261113_145715.pdf" — veio como imagem escaneada e não consegui ler o conteúdo]'
    );
  });

  test("com visão: o JPEG embutido passa pelo MESMO passe de visão e o histórico traz a leitura", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init: { body?: unknown }) => {
        bodies.push(String(init?.body));
        return visionResponse();
      })
    );
    const t = mk();
    const seed = await seedOrg(t, { visionEnabled: true });
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, jpegPdf(fakeJpeg())));
    const storageBefore = await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);

    expect((await t.action(internal.pdfRead.internalReadPdf, { messageId })).status).toBe("scanned");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("data:image/jpeg;base64,");

    const m = (await getMsg(t, messageId))!;
    expect(m.metadata!.docRead).toMatchObject({ status: "scanned", viaVision: true });
    expect(m.metadata!.vision.status).toBe("done");
    expect(m.imageDescription).toContain("R$ 1.247,90");
    expect(historyTextOf(m as any, { visionEnabled: true })).toContain("— escaneado, lido como imagem]: Comprovante de Pix");
    // blob temporário apagado
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(storageBefore);
    // visão desligada depois: descrição antiga não vaza, volta a resposta honesta
    expect(historyTextOf(m as any, { visionEnabled: false })).toContain("não consegui ler o conteúdo");
  });

  test("visão falha: scanned sem viaVision (honesto)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: '{"imagem_recebida":true,"descricao":""}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 495, completion_tokens: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const t = mk();
    const seed = await seedOrg(t, { visionEnabled: true });
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, jpegPdf(fakeJpeg())));
    await t.action(internal.pdfRead.internalReadPdf, { messageId });
    const m = (await getMsg(t, messageId))!;
    expect(m.metadata!.docRead).toMatchObject({ status: "scanned", viaVision: false });
    expect(historyTextOf(m as any, { visionEnabled: true })).toContain("não consegui ler o conteúdo");
  });
});

describe("espera pelo enriquecimento", () => {
  test("PDF pendente segura a resposta; concluído libera", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    const awaiting = () =>
      t.run((ctx) => hasMediaAwaitingEnrichment(ctx as any, seed.conversationId, 0, { visionEnabled: false }));
    expect(await awaiting()).toBe(true);
    await t.action(internal.pdfRead.internalReadPdf, { messageId });
    expect(await awaiting()).toBe(false);
  });

  test("claim do atendente re-enfileira enquanto o PDF está pendente (sem consumir tentativa)", async () => {
    vi.useFakeTimers();
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
    vi.setSystemTime(Date.now() + 10_000);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: item._id, runId: "r1" });
    expect(claim).toEqual({ kind: "requeued", reason: "aguardando_transcricao" });
    expect((await t.run((ctx) => ctx.db.get(item._id)))!.attempts).toBe(0);
  });

  test("PDF lido: o claim entrega o texto extraído no histórico (nunca 'não consigo abrir')", async () => {
    vi.useFakeTimers();
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    await t.mutation(internal.pdfReadState.internalSetPdfReadResult, {
      messageId,
      status: "done",
      text: "Valor: R$ 1.247,90",
    });
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
    vi.setSystemTime(Date.now() + 10_000);
    const claim: any = await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: item._id, runId: "r2" });
    expect(claim.kind).toBe("run");
    const texts = (claim.context.history as Array<{ texto: string }>).map((h) => h.texto);
    expect(texts).toEqual(['[arquivo PDF "Comprovante_20261113_145715.pdf" — texto extraído]: Valor: R$ 1.247,90']);
  });
});

describe("reprocesso (ops)", () => {
  test("dryRun padrão não agenda; execução real relê UMA mensagem por id com force", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    await t.action(internal.pdfRead.internalReadPdf, { messageId });
    const before = (await scheduledPdfReads(t)).length;

    const dry = await t.mutation(internal.pdfReadState.internalReprocessPdfs, { messageId });
    expect(dry).toMatchObject({ dryRun: true, eligible: 1, scheduled: 0 });
    expect(dry.items[0].id.startsWith("…")).toBe(true);
    expect((await scheduledPdfReads(t)).length).toBe(before);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const real = await t.mutation(internal.pdfReadState.internalReprocessPdfs, { messageId, dryRun: false });
    vi.useRealTimers();
    expect(real.scheduled).toBe(1);
    expect((await scheduledPdfReads(t)).length).toBe(before + 1);
    expect((await t.action(internal.pdfRead.internalReadPdf, { messageId, force: true })).status).toBe("done");
  });

  test("por org: PDFs recebidos nas últimas horas, teto pequeno", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    for (let i = 0; i < 3; i++) {
      await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])), `c${i}.pdf`);
    }
    const r = await t.mutation(internal.pdfReadState.internalReprocessPdfs, {
      organizationId: seed.organizationId,
      hours: 6,
      limit: 2,
    });
    expect(r.eligible).toBe(2);
    expect(r.scheduled).toBe(0);
    const bad = await t.mutation(internal.pdfReadState.internalReprocessPdfs, {});
    expect(bad.note).toBeDefined();
  });
});

describe("JPEG embutido (puro)", () => {
  test("acha o stream /DCTDecode cru e devolve o JPEG idêntico", () => {
    const jpeg = fakeJpeg();
    const found = findFirstEmbeddedJpeg(new Uint8Array(jpegPdf(jpeg)), PDF_READ_MAX_BYTES);
    expect(found).not.toBeNull();
    expect(Buffer.from(found!.bytes).equals(jpeg)).toBe(true);
    expect(found).toMatchObject({ width: 400, height: 400 });
  });

  test("recusa CMYK, imagem Flate, máscara, logotipo pequeno e teto de bytes", () => {
    expect(findFirstEmbeddedJpeg(new Uint8Array(jpegPdf(fakeJpeg({ components: 4 }))), PDF_READ_MAX_BYTES)).toBeNull();
    expect(findFirstEmbeddedJpeg(new Uint8Array(scannedPdf()), PDF_READ_MAX_BYTES)).toBeNull();
    expect(findFirstEmbeddedJpeg(new Uint8Array(jpegPdf(fakeJpeg(), "/ImageMask true")), PDF_READ_MAX_BYTES)).toBeNull();
    expect(findFirstEmbeddedJpeg(new Uint8Array(jpegPdf(fakeJpeg({ size: 100 }))), PDF_READ_MAX_BYTES)).toBeNull();
    expect(findFirstEmbeddedJpeg(new Uint8Array(jpegPdf(fakeJpeg())), 1024)).toBeNull();
  });

  test("texto de histórico sem leitura (estado ausente/pendente) cai no marcador antigo", () => {
    const base = { direction: "inbound" as const, content: "a.pdf" };
    expect(pdfHistoryText({ ...base }, {})).toBeNull();
    expect(pdfHistoryText({ ...base, metadata: { docRead: { status: "pending", at: 1 } } }, {})).toBeNull();
  });
});

describe("modo leitura do plano e pending órfão", () => {
  test("org read_only/canceled/teste vencido: não agenda leitura nem grava pending", async () => {
    const billings = [
      { plan: "profissional", status: "read_only" },
      { plan: "profissional", status: "canceled" },
      { plan: "profissional", status: "trial", trialEndsAt: 1 },
    ];
    for (const billing of billings) {
      const t = mk();
      const seed = await seedOrg(t);
      await t.run((ctx) => ctx.db.patch(seed.organizationId, { billing: { ...billing, updatedAt: Date.now() } as any }));
      const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
      expect(await scheduledPdfReads(t)).toHaveLength(0);
      expect((await getMsg(t, messageId))!.metadata!.docRead).toBeUndefined();
    }
  });

  const makeStale = (t: TestConvex<typeof schema>, messageId: Id<"messages">) =>
    t.run(async (ctx) => {
      const m = (await ctx.db.get(messageId))!;
      const docRead = { ...(m.metadata!.docRead as object), at: Date.now() - 11 * 60_000 };
      await ctx.db.patch(messageId, { metadata: { ...m.metadata, docRead } });
    });

  test("pending com mais de 10 min vira failed/STALE ao ser encontrado pelo atendente e libera a fila", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    const awaiting = () =>
      t.run((ctx) => hasMediaAwaitingEnrichment(ctx as any, seed.conversationId, 0, { visionEnabled: false }));
    expect(await awaiting()).toBe(true);
    await makeStale(t, messageId);
    expect(await awaiting()).toBe(false);
    expect((await getMsg(t, messageId))!.metadata!.docRead).toMatchObject({ status: "failed", error: "STALE" });
  });

  test("o claim de um pending órfão (sem force) fecha como STALE e não relê", async () => {
    const t = mk();
    const seed = await seedOrg(t);
    const messageId = await receivePdf(t, seed, await storeFile(t, seed, textPdf([COMPROVANTE])));
    await makeStale(t, messageId);
    expect(await t.mutation(internal.pdfReadState.internalClaimPdfRead, { messageId })).toBe(false);
    expect((await getMsg(t, messageId))!.metadata!.docRead).toMatchObject({ status: "failed", error: "STALE" });
    // reprocesso (force) continua reabrindo
    expect(await t.mutation(internal.pdfReadState.internalClaimPdfRead, { messageId, force: true })).toBe(true);
  });
});
