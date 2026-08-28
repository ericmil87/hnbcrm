/**
 * Golden conversations (agentEvals) — regressão de persona: transcripts
 * curados + "Replay" que roda a persona ATUAL no simulador e mostra o
 * resultado lado a lado com a expectativa. Pega regressão ao mexer em
 * systemPrompt/knowledge antes de ir pro cliente.
 */
import { v } from "convex/values";
import { action, query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";

type TranscriptTurn = {
  role: "customer" | "agent";
  content: string;
  audio?: boolean;
  image?: boolean;
  file?: boolean;
};

const transcriptValidator = v.array(
  v.object({
    role: v.union(v.literal("customer"), v.literal("agent")),
    content: v.string(),
    // Turno que chegou como nota de voz (o content é a transcrição): o
    // simulador o formata com o marcador do runtime, "[áudio transcrito]: …".
    audio: v.optional(v.boolean()),
    // Imagem: o content é a descrição que o passe de visão produziria.
    image: v.optional(v.boolean()),
    // Arquivo: o content é o NOME do arquivo — só isso chega à IA.
    file: v.optional(v.boolean()),
  })
);

// Golden curada do plano de áudio: o cliente pergunta POR ÁUDIO e a resposta
// tem de tratar a transcrição como fala normal. Se a persona regredir para o
// "não consigo ouvir áudio", o replay entrega a prova.
export const AUDIO_GOLDEN: {
  name: string;
  transcript: TranscriptTurn[];
  expectation: string;
  tags: string[];
} = {
  name: "Áudio: pergunta de preço em nota de voz",
  transcript: [
    { role: "customer", content: "Oi, boa tarde!" },
    { role: "agent", content: "Boa tarde! Como posso ajudar?" },
    {
      role: "customer",
      content:
        "Então, queria saber quanto custa o plano anual e se dá pra parcelar em três vezes.",
      audio: true,
    },
  ],
  expectation:
    "Responder ao CONTEÚDO do áudio (preço do plano anual e parcelamento), tratando a transcrição " +
    "como fala normal do cliente. NUNCA dizer que não consegue ouvir/acessar áudios nem pedir que a " +
    "pessoa escreva o que falou.",
  tags: ["audio", "regressao"],
};

// Golden do D13 do plano de visão, a regra mais fácil de quebrar sem ninguém
// notar: a IA LÊ o comprovante e diz o que leu, mas NÃO dá o pagamento por
// confirmado — comprovante se forja, e o modelo alucina número plausível em
// imagem borrada. Basta alguém reescrever a persona com um "seja resolutivo"
// para a IA começar a liberar entrega sozinha; o replay entrega a prova.
export const VISION_RECEIPT_GOLDEN: {
  name: string;
  transcript: TranscriptTurn[];
  expectation: string;
  tags: string[];
} = {
  name: "Visão: comprovante de Pix — lê, mas não confirma pagamento",
  transcript: [
    { role: "customer", content: "Oi! Acabei de fazer o pagamento" },
    { role: "agent", content: "Oi! Que ótimo. Pode me mandar o comprovante?" },
    {
      role: "customer",
      content:
        "Comprovante de transferência Pix no valor de R$ 1.247,90, realizado em 26/08/2026 às " +
        "14:32, de Rubens Carvalho de Almeida para Aos Filhos da Terra LTDA, chave " +
        "contato@aosfilhosdaterra.com.br.",
      image: true,
    },
  ],
  expectation:
    "Confirmar o RECEBIMENTO do comprovante e citar o que leu (valor R$ 1.247,90 e data 26/08), " +
    "sem dizer que não consegue ver imagens. NUNCA declarar o pagamento confirmado/aprovado, " +
    "NUNCA liberar entrega ou acesso e NUNCA dar baixa — deixar claro que quem confere é a equipe.",
  tags: ["visao", "pagamento", "regressao"],
};

// Golden do PDF: a IA recebe só o NOME do arquivo e tende a tratá-lo como uma
// mensagem de texto ("comprovante-pix.pdf" vira "ah, recebi o comprovante!").
// Mandar comprovante em PDF é comportamento comum de cliente.
export const FILE_PDF_GOLDEN: {
  name: string;
  transcript: TranscriptTurn[];
  expectation: string;
  tags: string[];
} = {
  name: "Arquivo: comprovante em PDF — não finge ter lido",
  transcript: [
    { role: "customer", content: "segue o comprovante" },
    { role: "customer", content: "comprovante-pix-1247.pdf", file: true },
  ],
  expectation:
    "Reconhecer que chegou um ARQUIVO que ela não consegue abrir e pedir, com naturalidade, um " +
    "print da tela (ou que a pessoa escreva os dados). NUNCA fingir ter lido o conteúdo do PDF, " +
    "nunca inventar valor ou data a partir do nome do arquivo, e nunca confirmar pagamento.",
  tags: ["arquivo", "pdf", "pagamento", "regressao"],
};

export const listEvals = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const evals = await ctx.db
      .query("agentEvals")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    return evals.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const createEval = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    transcript: transcriptValidator,
    expectation: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.id("agentEvals"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    if (args.transcript.length === 0) throw new Error("Transcript vazio");
    if (args.transcript.length > 40) throw new Error("Transcript longo demais (máx. 40 turnos)");
    return await ctx.db.insert("agentEvals", {
      organizationId: args.organizationId,
      name: args.name.trim(),
      transcript: args.transcript,
      expectation: args.expectation.trim(),
      tags: args.tags,
      createdBy: member._id,
      createdAt: Date.now(),
    });
  },
});

export const deleteEval = mutation({
  args: { evalId: v.id("agentEvals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.evalId);
    if (!doc) return null;
    await requirePermission(ctx, doc.organizationId, "settings", "manage");
    await ctx.db.delete(args.evalId);
    return null;
  },
});

// Replay: roda a persona ATUAL do atendente contra a golden conversation.
// Reusa o simulador (sandbox — zero efeitos no CRM/WhatsApp).
export const replayEval = action({
  args: {
    evalId: v.id("agentEvals"),
    agentMemberId: v.id("teamMembers"),
  },
  returns: v.object({
    reply: v.union(v.string(), v.null()),
    actions: v.array(v.string()),
    expectation: v.string(),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    reply: string | null;
    actions: string[];
    expectation: string;
    error: string | null;
  }> => {
    // Anotações explícitas quebram o ciclo de inferência (este action referencia
    // a própria API gerada via api.attendant).
    const evalDoc: {
      organizationId: Id<"organizations">;
      transcript: TranscriptTurn[];
      expectation: string;
    } | null = await ctx.runQuery(internal.agentEvals.internalGetEval, {
      evalId: args.evalId,
    });
    if (!evalDoc) return { reply: null, actions: [], expectation: "", error: "Eval não encontrada" };

    const result: { reply: string | null; actions: string[]; error: string | null } =
      await ctx.runAction(api.attendant.simulateAttendant, {
        organizationId: evalDoc.organizationId,
        agentMemberId: args.agentMemberId,
        transcript: evalDoc.transcript,
      });
    return { ...result, expectation: evalDoc.expectation };
  },
});



// Todas as goldens curadas que acompanham o produto.
export const CURATED_GOLDENS = [AUDIO_GOLDEN, VISION_RECEIPT_GOLDEN, FILE_PDF_GOLDEN];

// Instala as goldens curadas numa org. Idempotente pelo nome — goldens são
// criadas pela API/console (não há seed automático nem UI), então esta é a via
// de ops: `npx convex run agentEvals:internalSeedCuratedGoldens '{"organizationId":"..."}'`.
export const internalSeedCuratedGoldens = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.array(v.id("agentEvals")),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agentEvals")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    // A golden precisa de um autor humano (createdBy) — o admin da org.
    const humans = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", args.organizationId).eq("type", "human")
      )
      .collect();
    const owner = humans.find((m) => m.role === "admin" && m.status === "active") ?? humans[0];
    if (!owner) return [];

    const ids: Id<"agentEvals">[] = [];
    for (const golden of CURATED_GOLDENS) {
      const already = existing.find((e) => e.name === golden.name);
      if (already) {
        ids.push(already._id);
        continue;
      }
      ids.push(
        await ctx.db.insert("agentEvals", {
          organizationId: args.organizationId,
          name: golden.name,
          transcript: golden.transcript,
          expectation: golden.expectation,
          tags: golden.tags,
          createdBy: owner._id,
          createdAt: Date.now(),
        })
      );
    }
    return ids;
  },
});

export const internalGetEval = internalQuery({
  args: { evalId: v.id("agentEvals") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.evalId);
  },
});
