import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Helper: generate a timestamp N hours ago from a reference point
function hoursAgo(now: number, hours: number): number {
  return now - hours * 60 * 60 * 1000;
}

/**
 * Generates realistic PT-BR sample data during the onboarding wizard.
 *
 * Called as an internal mutation (no auth required).
 * Discovers existing board/stages/sources by index queries — works
 * regardless of custom pipeline names chosen during onboarding.
 */
export const generateSampleData = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    industry: v.string(),
  },
  returns: v.object({
    contacts: v.number(),
    leads: v.number(),
    conversations: v.number(),
    teamMembers: v.number(),
  }),
  handler: async (ctx, args) => {
    const { organizationId } = args;
    const now = Date.now();

    // ─── DISCOVER EXISTING BOARD & STAGES ────────────────────────────
    const board = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .first();

    if (!board) {
      throw new Error("Nenhum board encontrado. Execute setupPipelineFromWizard antes.");
    }

    const allStages = await ctx.db
      .query("stages")
      .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
      .collect();

    // Sort by order to get predictable stage indices
    allStages.sort((a, b) => a.order - b.order);

    if (allStages.length < 2) {
      throw new Error("Pipeline precisa ter pelo menos 2 estagios.");
    }

    // Find closed-won stage, or fall back to last stage
    const closedWonStage = allStages.find((s) => s.isClosedWon) ?? allStages[allStages.length - 1];

    // Build a list of "open" stages (not closed-won, not closed-lost)
    const openStages = allStages.filter((s) => !s.isClosedWon && !s.isClosedLost);
    if (openStages.length === 0) {
      throw new Error("Pipeline precisa ter pelo menos 1 estagio aberto.");
    }

    // ─── DISCOVER LEAD SOURCES ───────────────────────────────────────
    const allSources = await ctx.db
      .query("leadSources")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect();

    // Pick first active source as default; fall back to any source
    const defaultSource = allSources.find((s) => s.isActive) ?? allSources[0];

    // Try to find diverse sources by type
    function findSourceByType(type: string): Id<"leadSources"> | undefined {
      return allSources.find((s) => s.type === type)?._id;
    }

    const sourceWebsite = findSourceByType("website") ?? defaultSource?._id;
    const sourceSocial = findSourceByType("social") ?? defaultSource?._id;
    const sourceEmail = findSourceByType("email") ?? defaultSource?._id;
    const sourceReferral = findSourceByType("referral") ?? defaultSource?._id;
    const sourcePhone = findSourceByType("phone") ?? defaultSource?._id;

    // ─── 1. TEAM MEMBERS (3 — admin already exists) ──────────────────
    const teamMemberData = [
      {
        name: "Maria Santos",
        email: "maria@demo.com",
        role: "manager" as const,
        type: "human" as const,
        status: "active" as const,
      },
      {
        name: "Pedro Costa",
        email: "pedro@demo.com",
        role: "agent" as const,
        type: "human" as const,
        status: "active" as const,
      },
      {
        name: "Claw IA",
        email: undefined,
        role: "ai" as const,
        type: "ai" as const,
        status: "active" as const,
        capabilities: [
          "auto-reply",
          "qualification",
          "sentiment-analysis",
          "summarization",
          "handoff-detection",
        ],
      },
    ];

    const teamMemberIds: Id<"teamMembers">[] = [];
    for (const m of teamMemberData) {
      const id = await ctx.db.insert("teamMembers", {
        organizationId,
        name: m.name,
        email: m.email,
        role: m.role,
        type: m.type,
        status: m.status,
        capabilities: m.capabilities,
        createdAt: hoursAgo(now, 168), // ~7 days ago
        updatedAt: hoursAgo(now, 168),
      });
      teamMemberIds.push(id);
    }

    const [maria, pedro, clawIA] = teamMemberIds;

    // ─── 2. CONTACTS (8 Brazilian) ───────────────────────────────────
    const contactDefs = [
      {
        firstName: "Ana",
        lastName: "Silva",
        email: "ana.silva@techbr.com.br",
        phone: "(11) 98765-4321",
        company: "TechBR Solutions",
        title: "CEO",
        whatsappNumber: "+5511987654321",
        city: "Sao Paulo",
        state: "SP",
        country: "Brasil",
        industry: "Tecnologia",
        companySize: "51-200",
        companyWebsite: "https://techbr.com.br",
        linkedinUrl: "https://linkedin.com/in/anasilva",
        instagramUrl: "https://instagram.com/anasilva.tech",
        tags: ["VIP", "B2B", "potencial"],
        linkedinConnections: 1200,
        socialInfluenceScore: 72,
        preferredContactTime: "morning" as const,
        deviceType: "iphone" as const,
        acquisitionChannel: "google-ads",
      },
      {
        firstName: "Carlos",
        lastName: "Oliveira",
        email: "carlos@inovacom.com.br",
        phone: "(21) 97654-3210",
        company: "InovaCom Digital",
        title: "Diretor Comercial",
        city: "Rio de Janeiro",
        state: "RJ",
        country: "Brasil",
        industry: "Marketing Digital",
        companySize: "11-50",
        linkedinUrl: "https://linkedin.com/in/carlosoliveira",
        tags: ["ativo", "B2B", "parceiro"],
        linkedinConnections: 850,
        preferredContactTime: "afternoon" as const,
        deviceType: "android" as const,
      },
      {
        firstName: "Juliana",
        lastName: "Mendes",
        email: "juliana@startupflow.io",
        phone: "(31) 96543-2109",
        company: "StartupFlow",
        title: "COO",
        whatsappNumber: "+5531965432109",
        city: "Belo Horizonte",
        state: "MG",
        country: "Brasil",
        industry: "SaaS",
        companySize: "11-50",
        companyWebsite: "https://startupflow.io",
        instagramUrl: "https://instagram.com/startupflow",
        tags: ["potencial", "B2B", "novo"],
        instagramFollowers: 5200,
        socialInfluenceScore: 58,
        deviceType: "desktop" as const,
      },
      {
        firstName: "Rafael",
        lastName: "Costa",
        email: "rafael@logimais.com.br",
        phone: "(41) 95432-1098",
        company: "LogiMais Transportes",
        title: "Gerente de Compras",
        city: "Curitiba",
        state: "PR",
        country: "Brasil",
        industry: "Logistica",
        companySize: "201-1000",
        cnpj: "12.345.678/0001-90",
        tags: ["B2B", "ativo"],
        preferredContactTime: "morning" as const,
      },
      {
        firstName: "Fernanda",
        lastName: "Lima",
        email: "fernanda@edutech.com.br",
        phone: "(51) 94321-0987",
        company: "EduTech Brasil",
        title: "Coordenadora",
        whatsappNumber: "+5551943210987",
        city: "Porto Alegre",
        state: "RS",
        country: "Brasil",
        industry: "Educacao",
        companySize: "51-200",
        linkedinUrl: "https://linkedin.com/in/fernandalima",
        tags: ["novo", "B2C", "potencial"],
        linkedinConnections: 430,
      },
      {
        firstName: "Marcos",
        lastName: "Pereira",
        email: "marcos@construtora-mp.com.br",
        phone: "(61) 93210-9876",
        company: "Construtora MP",
        title: "Engenheiro Civil",
        city: "Brasilia",
        state: "DF",
        country: "Brasil",
        industry: "Construcao Civil",
        companySize: "201-1000",
        cnpj: "98.765.432/0001-10",
        tags: ["B2B", "VIP"],
        deviceType: "android" as const,
      },
      {
        firstName: "Patricia",
        lastName: "Rodrigues",
        email: "patricia@bellamode.com.br",
        phone: "(71) 92109-8765",
        company: "Bella Mode",
        title: "Gerente de Marketing",
        city: "Salvador",
        state: "BA",
        country: "Brasil",
        industry: "Moda e Varejo",
        companySize: "11-50",
        instagramUrl: "https://instagram.com/bellamode",
        tags: ["B2C", "ativo", "parceiro"],
        instagramFollowers: 28000,
        socialInfluenceScore: 85,
        preferredContactTime: "afternoon" as const,
      },
      {
        firstName: "Thiago",
        lastName: "Santos",
        email: "thiago@financeplus.com.br",
        phone: "(85) 91098-7654",
        company: "FinancePlus",
        title: "Analista Financeiro",
        city: "Fortaleza",
        state: "CE",
        country: "Brasil",
        industry: "Financas",
        companySize: "51-200",
        linkedinUrl: "https://linkedin.com/in/thiagosantos",
        tags: ["B2B", "novo"],
        linkedinConnections: 620,
        preferredContactTime: "evening" as const,
      },
    ];

    const contactIds: Id<"contacts">[] = [];
    for (let i = 0; i < contactDefs.length; i++) {
      const c = contactDefs[i];
      const searchText = [
        c.firstName,
        c.lastName,
        c.email,
        c.company,
        c.city,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const id = await ctx.db.insert("contacts", {
        organizationId,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        company: c.company,
        title: c.title,
        whatsappNumber: c.whatsappNumber,
        tags: c.tags,
        searchText,
        linkedinUrl: c.linkedinUrl,
        instagramUrl: c.instagramUrl,
        city: c.city,
        state: c.state,
        country: c.country,
        industry: c.industry,
        companySize: c.companySize,
        companyWebsite: c.companyWebsite,
        cnpj: c.cnpj,
        preferredContactTime: c.preferredContactTime,
        deviceType: c.deviceType,
        acquisitionChannel: c.acquisitionChannel,
        linkedinConnections: c.linkedinConnections,
        instagramFollowers: c.instagramFollowers,
        socialInfluenceScore: c.socialInfluenceScore,
        createdAt: hoursAgo(now, 168 - i * 2), // spread out over time
        updatedAt: hoursAgo(now, 72 - i * 3),
      });
      contactIds.push(id);
    }

    // ─── 3. LEADS (6 across stages) ──────────────────────────────────
    // Distribute leads across available stages:
    //   - 2 in first open stage (stage 0)
    //   - 1 in second open stage (or stage 0 if only 1 open stage)
    //   - 1 in third open stage (or last open stage)
    //   - 1 in last open stage
    //   - 1 in closed-won stage
    const stage0 = openStages[0];
    const stage1 = openStages.length > 1 ? openStages[1] : openStages[0];
    const stage2 = openStages.length > 2 ? openStages[2] : openStages[openStages.length - 1];
    const stage3 = openStages.length > 3 ? openStages[3] : openStages[openStages.length - 1];

    const leadDefs: Array<{
      title: string;
      contactIdx: number;
      stageId: Id<"stages">;
      assignedTo: Id<"teamMembers">;
      value: number;
      priority: "low" | "medium" | "high" | "urgent";
      temperature: "cold" | "warm" | "hot";
      sourceId?: Id<"leadSources">;
      tags: string[];
      qualification?: {
        budget?: boolean;
        authority?: boolean;
        need?: boolean;
        timeline?: boolean;
        score?: number;
      };
      conversationStatus: "new" | "active" | "waiting" | "closed";
      closedAt?: number;
      closedType?: "won" | "lost";
      hoursCreatedAgo: number;
    }> = [
      // Stage 0 — Lead 1 (contact: Ana Silva / TechBR)
      {
        title: `Contato Inicial — ${contactDefs[0].company}`,
        contactIdx: 0,
        stageId: stage0._id,
        assignedTo: pedro,
        value: 12000,
        priority: "medium",
        temperature: "cold",
        sourceId: sourceWebsite,
        tags: ["inbound", "tecnologia"],
        qualification: { budget: false, authority: true, need: true, timeline: false, score: 35 },
        conversationStatus: "new",
        hoursCreatedAgo: 8,
      },
      // Stage 0 — Lead 2 (contact: Patricia Rodrigues / Bella Mode)
      {
        title: `Contato Inicial — ${contactDefs[6].company}`,
        contactIdx: 6,
        stageId: stage0._id,
        assignedTo: clawIA,
        value: 7500,
        priority: "low",
        temperature: "cold",
        sourceId: sourceSocial,
        tags: ["inbound", "varejo"],
        qualification: { budget: false, authority: false, need: true, timeline: false, score: 20 },
        conversationStatus: "new",
        hoursCreatedAgo: 4,
      },
      // Stage 1 — Lead 3 (contact: Carlos Oliveira / InovaCom)
      {
        title: `Proposta — ${contactDefs[1].company}`,
        contactIdx: 1,
        stageId: stage1._id,
        assignedTo: maria,
        value: 35000,
        priority: "high",
        temperature: "warm",
        sourceId: sourceEmail,
        tags: ["qualificado", "marketing"],
        qualification: { budget: true, authority: true, need: true, timeline: false, score: 70 },
        conversationStatus: "active",
        hoursCreatedAgo: 72,
      },
      // Stage 2 — Lead 4 (contact: Rafael Costa / LogiMais)
      {
        title: `Negociacao — ${contactDefs[3].company}`,
        contactIdx: 3,
        stageId: stage2._id,
        assignedTo: maria,
        value: 58000,
        priority: "high",
        temperature: "hot",
        sourceId: sourceReferral,
        tags: ["enterprise", "logistica"],
        qualification: { budget: true, authority: true, need: true, timeline: true, score: 85 },
        conversationStatus: "active",
        hoursCreatedAgo: 120,
      },
      // Stage 3 — Lead 5 (contact: Marcos Pereira / Construtora MP)
      {
        title: `Fechamento — ${contactDefs[5].company}`,
        contactIdx: 5,
        stageId: stage3._id,
        assignedTo: pedro,
        value: 45000,
        priority: "urgent",
        temperature: "hot",
        sourceId: sourcePhone,
        tags: ["enterprise", "construcao"],
        qualification: { budget: true, authority: true, need: true, timeline: true, score: 92 },
        conversationStatus: "active",
        hoursCreatedAgo: 144,
      },
      // Closed Won — Lead 6 (contact: Thiago Santos / FinancePlus)
      {
        title: `Concluido — ${contactDefs[7].company}`,
        contactIdx: 7,
        stageId: closedWonStage._id,
        assignedTo: maria,
        value: 60000,
        priority: "medium",
        temperature: "hot",
        sourceId: sourceReferral,
        tags: ["enterprise", "financas"],
        qualification: { budget: true, authority: true, need: true, timeline: true, score: 100 },
        conversationStatus: "closed",
        closedAt: hoursAgo(now, 24),
        closedType: "won",
        hoursCreatedAgo: 168,
      },
    ];

    const leadIds: Id<"leads">[] = [];
    for (const l of leadDefs) {
      const createdAt = hoursAgo(now, l.hoursCreatedAgo);
      const id = await ctx.db.insert("leads", {
        organizationId,
        title: l.title,
        contactId: contactIds[l.contactIdx],
        boardId: board._id,
        stageId: l.stageId,
        assignedTo: l.assignedTo,
        value: l.value,
        currency: "BRL",
        priority: l.priority,
        temperature: l.temperature,
        sourceId: l.sourceId,
        tags: l.tags,
        customFields: {},
        qualification: l.qualification,
        conversationStatus: l.conversationStatus,
        closedAt: l.closedAt,
        closedType: l.closedType,
        lastActivityAt: createdAt + 3 * 60 * 60 * 1000,
        createdAt,
        updatedAt: createdAt + 2 * 60 * 60 * 1000,
      });
      leadIds.push(id);
    }

    // ─── 4. CONVERSATIONS & MESSAGES ─────────────────────────────────
    let totalConversations = 0;

    // Helper to create a conversation + its messages
    async function createConvo(
      leadIdx: number,
      channel: "whatsapp" | "email" | "webchat",
      msgs: Array<{
        direction: "inbound" | "outbound";
        senderType: "contact" | "human" | "ai";
        senderId?: Id<"teamMembers">;
        content: string;
        minutesOffset: number; // minutes after conversation start
      }>
    ): Promise<Id<"conversations">> {
      const convoCreatedAt = hoursAgo(now, leadDefs[leadIdx].hoursCreatedAgo - 1);
      const lastMsgAt = convoCreatedAt + msgs[msgs.length - 1].minutesOffset * 60 * 1000;

      const convoId = await ctx.db.insert("conversations", {
        organizationId,
        leadId: leadIds[leadIdx],
        channel,
        status: "active",
        lastMessageAt: lastMsgAt,
        messageCount: msgs.length,
        createdAt: convoCreatedAt,
        updatedAt: lastMsgAt,
      });

      for (const m of msgs) {
        await ctx.db.insert("messages", {
          organizationId,
          conversationId: convoId,
          leadId: leadIds[leadIdx],
          direction: m.direction,
          senderId: m.senderId,
          senderType: m.senderType,
          content: m.content,
          contentType: "text",
          deliveryStatus: m.direction === "outbound" ? "delivered" : undefined,
          isInternal: false,
          createdAt: convoCreatedAt + m.minutesOffset * 60 * 1000,
        });
      }

      totalConversations++;
      return convoId;
    }

    // Conversation 1: WhatsApp — Ana Silva / TechBR (Lead 0, 3 messages)
    await createConvo(0, "whatsapp", [
      {
        direction: "inbound",
        senderType: "contact",
        content: "Ola, vi o anuncio de voces e gostaria de saber mais sobre a solucao de CRM. Temos uma equipe de 30 pessoas e precisamos organizar nosso pipeline de vendas.",
        minutesOffset: 0,
      },
      {
        direction: "outbound",
        senderType: "human",
        senderId: pedro,
        content: "Ola Ana! Obrigado pelo interesse. Nossa plataforma atende perfeitamente equipes desse tamanho. Posso te enviar uma apresentacao com os planos disponiveis?",
        minutesOffset: 12,
      },
      {
        direction: "inbound",
        senderType: "contact",
        content: "Sim, por favor! Pode mandar por aqui mesmo. Tambem gostaria de agendar uma demonstracao para a proxima semana, se possivel.",
        minutesOffset: 25,
      },
    ]);

    // Conversation 2: Email — Carlos Oliveira / InovaCom (Lead 2, 2 messages)
    await createConvo(2, "email", [
      {
        direction: "inbound",
        senderType: "contact",
        content: "Bom dia, estamos avaliando plataformas de CRM para nossa agencia de marketing digital. Precisamos de integracao com WhatsApp e automacao de follow-up. Qual o investimento para 15 usuarios?",
        minutesOffset: 0,
      },
      {
        direction: "outbound",
        senderType: "human",
        senderId: maria,
        content: "Ola Carlos! Obrigada pelo contato. Temos o plano profissional que inclui integracao WhatsApp nativa e automacoes avancadas. Para 15 usuarios, o investimento fica em torno de R$ 2.900/mes. Posso preparar uma proposta detalhada?",
        minutesOffset: 45,
      },
    ]);

    // Conversation 3: Webchat — Rafael Costa / LogiMais (Lead 3, 4 messages including AI)
    await createConvo(3, "webchat", [
      {
        direction: "inbound",
        senderType: "contact",
        content: "Boa tarde. Somos uma transportadora com mais de 200 motoristas e precisamos de um sistema para gerenciar leads e propostas comerciais. Voces atendem o setor de logistica?",
        minutesOffset: 0,
      },
      {
        direction: "outbound",
        senderType: "ai",
        senderId: clawIA,
        content: "Ola Rafael! Sim, atendemos diversas empresas do setor de logistica. Baseado no perfil da LogiMais, recomendo agendar uma demonstracao personalizada para mostrar como gerenciamos pipelines de alta volumetria. Vou encaminhar para nossa gerente comercial, Maria Santos.",
        minutesOffset: 1,
      },
      {
        direction: "outbound",
        senderType: "human",
        senderId: maria,
        content: "Oi Rafael! Maria aqui. Ja atendemos 3 transportadoras com perfil similar ao de voces. O sistema suporta integracao com TMS e acompanhamento de propostas em tempo real. Podemos marcar uma call para quinta?",
        minutesOffset: 18,
      },
      {
        direction: "inbound",
        senderType: "contact",
        content: "Perfeito, quinta as 14h funciona. Vou chamar nosso diretor comercial tambem. Podem enviar o link da reuniao?",
        minutesOffset: 35,
      },
    ]);

    // ─── 5. HANDOFF (1 pending) ──────────────────────────────────────
    // AI handoff on the Construtora MP lead (Lead 4)
    const handoffCreatedAt = hoursAgo(now, 6);
    await ctx.db.insert("handoffs", {
      organizationId,
      leadId: leadIds[4],
      fromMemberId: clawIA,
      reason: "Cliente solicitou atendimento humano para negociacao de preco",
      summary:
        "Lead com alto potencial, demonstrou interesse no plano enterprise. Solicita desconto para contrato anual.",
      suggestedActions: [
        "Oferecer desconto de 15% para contrato anual",
        "Agendar reuniao com gerente comercial",
        "Enviar case de sucesso do setor",
      ],
      status: "pending",
      createdAt: handoffCreatedAt,
    });

    // Update lead's handoffState to match
    await ctx.db.patch(leadIds[4], {
      handoffState: {
        status: "pending",
        fromMemberId: clawIA,
        reason: "Cliente solicitou atendimento humano para negociacao de preco",
        summary:
          "Lead com alto potencial, demonstrou interesse no plano enterprise. Solicita desconto para contrato anual.",
        suggestedActions: [
          "Oferecer desconto de 15% para contrato anual",
          "Agendar reuniao com gerente comercial",
          "Enviar case de sucesso do setor",
        ],
        requestedAt: handoffCreatedAt,
      },
    });

    // ─── 6. ACTIVITIES ───────────────────────────────────────────────
    const activityDefs: Array<{
      leadIdx: number;
      type:
        | "created"
        | "stage_change"
        | "assignment"
        | "message_sent"
        | "handoff"
        | "qualification_update"
        | "note";
      actorId?: Id<"teamMembers">;
      actorType: "human" | "ai" | "system";
      content?: string;
      metadata?: Record<string, any>;
      hoursAgoVal: number;
    }> = [
      // ── Lead 0 (Ana Silva / TechBR — stage 0)
      {
        leadIdx: 0,
        type: "created",
        actorType: "system",
        content: "Lead criado via website",
        hoursAgoVal: 8,
      },
      {
        leadIdx: 0,
        type: "assignment",
        actorType: "system",
        actorId: pedro,
        content: "Atribuido a Pedro Costa",
        metadata: { assignedTo: "Pedro Costa" },
        hoursAgoVal: 7.5,
      },
      {
        leadIdx: 0,
        type: "message_sent",
        actorType: "human",
        actorId: pedro,
        content: "Resposta enviada via WhatsApp",
        hoursAgoVal: 7,
      },

      // ── Lead 1 (Patricia Rodrigues / Bella Mode — stage 0)
      {
        leadIdx: 1,
        type: "created",
        actorType: "system",
        content: "Lead criado via redes sociais",
        hoursAgoVal: 4,
      },
      {
        leadIdx: 1,
        type: "assignment",
        actorType: "ai",
        actorId: clawIA,
        content: "Auto-atribuido a Claw IA para triagem inicial",
        metadata: { assignedTo: "Claw IA" },
        hoursAgoVal: 3.8,
      },

      // ── Lead 2 (Carlos Oliveira / InovaCom — stage 1)
      {
        leadIdx: 2,
        type: "created",
        actorType: "system",
        content: "Lead criado via campanha de email",
        hoursAgoVal: 72,
      },
      {
        leadIdx: 2,
        type: "assignment",
        actorType: "human",
        actorId: maria,
        content: "Atribuido a Maria Santos",
        metadata: { assignedTo: "Maria Santos" },
        hoursAgoVal: 70,
      },
      {
        leadIdx: 2,
        type: "stage_change",
        actorType: "human",
        actorId: maria,
        content: `Movido para ${stage1.name}`,
        metadata: { from: stage0.name, to: stage1.name },
        hoursAgoVal: 48,
      },
      {
        leadIdx: 2,
        type: "message_sent",
        actorType: "human",
        actorId: maria,
        content: "Proposta comercial enviada por email",
        hoursAgoVal: 46,
      },

      // ── Lead 3 (Rafael Costa / LogiMais — stage 2)
      {
        leadIdx: 3,
        type: "created",
        actorType: "system",
        content: "Lead criado via indicacao",
        hoursAgoVal: 120,
      },
      {
        leadIdx: 3,
        type: "assignment",
        actorType: "human",
        actorId: maria,
        content: "Atribuido a Maria Santos — conta enterprise",
        metadata: { assignedTo: "Maria Santos" },
        hoursAgoVal: 118,
      },
      {
        leadIdx: 3,
        type: "stage_change",
        actorType: "human",
        actorId: maria,
        content: `Movido para ${stage2.name}`,
        metadata: { from: stage1.name, to: stage2.name },
        hoursAgoVal: 72,
      },
      {
        leadIdx: 3,
        type: "qualification_update",
        actorType: "human",
        actorId: maria,
        content: "BANT atualizado: orcamento confirmado, autoridade confirmada",
        metadata: { score: 85 },
        hoursAgoVal: 68,
      },
      {
        leadIdx: 3,
        type: "message_sent",
        actorType: "ai",
        actorId: clawIA,
        content: "Resposta inicial via webchat pela IA",
        hoursAgoVal: 119,
      },

      // ── Lead 4 (Marcos Pereira / Construtora MP — stage 3)
      {
        leadIdx: 4,
        type: "created",
        actorType: "system",
        content: "Lead criado via telefone",
        hoursAgoVal: 144,
      },
      {
        leadIdx: 4,
        type: "assignment",
        actorType: "human",
        actorId: pedro,
        content: "Atribuido a Pedro Costa",
        metadata: { assignedTo: "Pedro Costa" },
        hoursAgoVal: 142,
      },
      {
        leadIdx: 4,
        type: "stage_change",
        actorType: "human",
        actorId: pedro,
        content: `Movido para ${stage3.name}`,
        metadata: { from: stage2.name, to: stage3.name },
        hoursAgoVal: 48,
      },
      {
        leadIdx: 4,
        type: "handoff",
        actorType: "ai",
        actorId: clawIA,
        content: "IA solicitou handoff para negociacao de preco",
        hoursAgoVal: 6,
      },

      // ── Lead 5 (Thiago Santos / FinancePlus — closed won)
      {
        leadIdx: 5,
        type: "created",
        actorType: "system",
        content: "Lead criado via indicacao",
        hoursAgoVal: 168,
      },
      {
        leadIdx: 5,
        type: "assignment",
        actorType: "human",
        actorId: maria,
        content: "Atribuido a Maria Santos",
        metadata: { assignedTo: "Maria Santos" },
        hoursAgoVal: 166,
      },
      {
        leadIdx: 5,
        type: "stage_change",
        actorType: "human",
        actorId: maria,
        content: `Movido para ${closedWonStage.name} — contrato assinado!`,
        metadata: { to: closedWonStage.name },
        hoursAgoVal: 24,
      },
      {
        leadIdx: 5,
        type: "note",
        actorType: "human",
        actorId: maria,
        content:
          "Cliente fechou contrato anual de R$ 60.000. Otimo potencial para upsell no proximo trimestre. Agendar reuniao de kick-off.",
        hoursAgoVal: 22,
      },
    ];

    for (const a of activityDefs) {
      await ctx.db.insert("activities", {
        organizationId,
        leadId: leadIds[a.leadIdx],
        type: a.type,
        actorId: a.actorId,
        actorType: a.actorType,
        content: a.content,
        metadata: a.metadata,
        createdAt: hoursAgo(now, a.hoursAgoVal),
      });
    }

    // ─── RETURN COUNTS ───────────────────────────────────────────────
    return {
      contacts: contactIds.length,
      leads: leadIds.length,
      conversations: totalConversations,
      teamMembers: teamMemberIds.length,
    };
  },
});
