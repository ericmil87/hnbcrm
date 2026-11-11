/**
 * Portas únicas de CONFIGURAÇÃO do atendente IA (perfil, toggles dos produtos de
 * IA, transcrição por canal). A UI de Configurações, o wizard e as tools do
 * Copiloto chamam estes cores. Exceções conhecidas: ops `internal*`
 * (`internalSetBotGuard`, `internalSetFollowUpMode`, agenda externa,
 * `opsAgentProfile`), `activateOneFlow` e `demoSim`. Quem chama faz auth/permissão e carrega os docs; o
 * core valida, grava e audita. `via` vai para `auditLogs.metadata.via`.
 */
import { v, Infer, ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import {
  readAgentTexts,
  stripAgentTexts,
  writeAgentTexts,
  type AgentProfile,
} from "./agentProfileTexts";
import { auditTextSnapshot } from "./auditText";
import { validateBotGuardTag } from "./botGuard";
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  MAX_CHAIN_LIMIT,
  MAX_DAILY_CAP,
} from "./followUpSettings";
import { buildAuditDescription } from "./auditDescription";
import { VOICE_NOTICE_MAX_CHARS, isTtsVoice, voiceDataKinds } from "./tts";

// `onboarding` = aplicação do Rascunho de Operação pelo clique do usuário
// (`onboardingSessions.applyOnboardingDraft`, ver `lib/onboardingApply.ts`).
export type ConfigVia = "settings" | "copilot" | "wizard" | "telegram" | "onboarding";

export const agentProfilePatchValidator = v.object({
  mode: v.optional(v.union(v.literal("suggest"), v.literal("autopilot"))),
  systemPrompt: v.optional(v.string()),
  knowledge: v.optional(v.string()),
  language: v.optional(v.string()),
  channelConfigIds: v.optional(v.array(v.id("channelConfigs"))),
  boardIds: v.optional(v.array(v.id("boards"))),
  schedule: v.optional(
    v.union(
      v.null(),
      v.object({
        timezone: v.string(),
        startHour: v.number(),
        endHour: v.number(),
        days: v.optional(v.array(v.number())),
      })
    )
  ),
  // Opt-OUT: ausente = ligado, só `false` desliga (ver o schema).
  includeCurrentDateTime: v.optional(v.boolean()),
  // Guardrail anti-bot (v0.65). Opt-OUT como o de cima; `v.null()` volta ao
  // default (remove o campo = ligado com a etiqueta "bot-suspeito").
  botGuard: v.optional(
    v.union(
      v.null(),
      v.object({
        enabled: v.optional(v.boolean()),
        tag: v.optional(v.string()),
      })
    )
  ),
  // Follow-ups que a IA executa sozinha (v0.60). `v.null()` volta ao default
  // do produto ("Preparar rascunho"), como o pipelineConfig.
  followUps: v.optional(
    v.union(
      v.null(),
      v.object({
        mode: v.union(v.literal("off"), v.literal("draft"), v.literal("send")),
        maxChain: v.optional(v.number()),
        quietStartHour: v.optional(v.number()),
        quietEndHour: v.optional(v.number()),
        dailyCap: v.optional(v.number()),
        // v0.64: chave do custom field (lead, tipo data) com a data do evento alvo.
        eventDateField: v.optional(v.string()),
      })
    )
  ),
  handoffKeywords: v.optional(v.array(v.string())),
  maxRepliesPerConversation: v.optional(v.number()),
  maxRepliesPerHour: v.optional(v.number()),
  messageDebounceSeconds: v.optional(v.number()),
  model: v.optional(v.string()),
  temperature: v.optional(v.number()),
  disclosure: v.optional(v.string()),
  disclosureMode: v.optional(v.union(v.literal("first_reply"), v.literal("on_demand"))),
  // P4: regras de pipeline. v.null() limpa a config inteira (volta ao default).
  pipelineConfig: v.optional(
    v.union(
      v.null(),
      v.object({
        boardId: v.optional(v.id("boards")),
        initialStageId: v.optional(v.id("stages")),
        advanceRules: v.optional(v.string()),
        qualifiedStageId: v.optional(v.id("stages")),
        qualifyThreshold: v.optional(v.number()),
        allowMoveStages: v.optional(v.boolean()),
        captureFields: v.optional(v.array(v.string())),
      })
    )
  ),
});

/**
 * MERGE do `botGuard` (UI e ops usam o mesmo): campo ausente no patch fica como
 * está; `tag:""` remove a etiqueta (volta à padrão "bot-suspeito"); etiqueta
 * não vazia é validada (lança com mensagem PT-BR). Objeto que fica vazio vira
 * `undefined` (= padrão: ligado).
 */
export function mergeBotGuard(
  current: { enabled?: boolean; tag?: string } | undefined,
  patch: { enabled?: boolean; tag?: string }
): { enabled?: boolean; tag?: string } | undefined {
  const next: { enabled?: boolean; tag?: string } = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.tag !== undefined) {
    if (patch.tag.trim() === "") {
      delete next.tag;
    } else {
      const checked = validateBotGuardTag(patch.tag);
      if (!checked.ok) throw new Error(`Etiqueta de robô: ${checked.error}`);
      next.tag = checked.tag;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export async function computeAcceptanceMetrics(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  agentMemberId?: Id<"teamMembers">
) {
  const runs = await ctx.db
    .query("agentRuns")
    .withIndex("by_organization_and_kind_and_started", (q) =>
      q.eq("organizationId", organizationId).eq("kind", "attendant")
    )
    .order("desc")
    .take(300);
  const relevant = agentMemberId ? runs.filter((r) => r.memberId === agentMemberId) : runs;

  let pending = 0;
  let sent = 0;
  let sentEdited = 0;
  let discarded = 0;
  let revised = 0;
  let coached = 0;
  let proactive = 0;
  for (const run of relevant) {
    if (!run.resultMessageId) continue;
    // Runs iniciadas por humano (requestAiDraft/returnToAi) medem o COACHING,
    // não a autonomia da IA — fora do gate do autopilot, contadas à parte.
    if (run.humanInitiated) {
      coached++;
      continue;
    }
    // Runs PROATIVAS (follow-up, v0.60) também ficam fora: descartar um
    // rascunho de follow-up quer dizer "não era para mandar nada", não "a IA
    // respondeu mal ao cliente" — contá-lo como rejeição derrubaria a taxa e
    // travaria o gate do autopilot de quem nem estava avaliando isso.
    if (run.proactive) {
      proactive++;
      continue;
    }
    const message = await ctx.db.get(run.resultMessageId);
    const draft = message?.metadata?.aiDraft as { status?: string } | undefined;
    if (!draft) continue;
    if (draft.status === "pending") pending++;
    else if (draft.status === "sent") sent++;
    else if (draft.status === "sent_edited") sentEdited++;
    else if (draft.status === "discarded") discarded++;
    // "revised" = substituído por instrução humana (loop de coaching). Fica
    // FORA de `reviewed` de propósito: instruir a IA não é rejeição — contar
    // como descarte derrubaria a taxa e travaria o gate do autopilot.
    else if (draft.status === "revised") revised++;
  }
  const reviewed = sent + sentEdited + discarded;
  return {
    pending,
    sent,
    sentEdited,
    discarded,
    revised,
    coached,
    proactive,
    reviewed,
    acceptanceRate: reviewed > 0 ? (sent + sentEdited) / reviewed : 0,
  };
}

export type AgentProfilePatch = Infer<typeof agentProfilePatchValidator>;

/**
 * Atualiza o perfil de um atendente IA. Gate de autopilot, tetos, follow-ups,
 * botGuard e pipelineConfig validados AQUI (servidor). `rename` troca também
 * `teamMembers.name` (audita antes/depois).
 */
export async function updateAgentProfileCore(
  ctx: MutationCtx,
  params: {
    agent: Doc<"teamMembers">;
    member: Doc<"teamMembers">;
    patch: AgentProfilePatch;
    autopilotRiskAck?: boolean;
    via?: ConfigVia;
    rename?: string;
  }
): Promise<null> {
  const { agent, member, patch, autopilotRiskAck } = params;
  if (!agent.agentProfile || agent.type !== "ai") {
    throw new Error("Agente IA não encontrado");
  }
  if (agent.organizationId !== member.organizationId) {
    throw new Error("Agente IA não encontrado");
  }
  const newName = params.rename?.trim();
  if (params.rename !== undefined && !newName) {
    throw new Error("O nome do atendente não pode ficar vazio");
  }
  if (newName !== undefined && (newName.length > 60 || /[\r\n]/.test(newName))) {
    throw new Error("O nome do atendente deve ter até 60 caracteres e uma só linha");
  }
  const renamed = newName !== undefined && newName !== agent.name;

  let autopilotEarly = false;
  if (patch.mode === "autopilot" && agent.agentProfile.mode !== "autopilot") {
    const metrics = await computeAcceptanceMetrics(ctx, agent.organizationId, agent._id);
    const enough = metrics.reviewed >= 10 && metrics.acceptanceRate >= 0.6;
    if (!enough && autopilotRiskAck === true) {
      autopilotEarly = true;
    } else if (!enough) {
      throw new Error(
        `Autopilot exige pelo menos 10 sugestões revisadas com 60% de aceitação ` +
          `(hoje: ${metrics.reviewed} revisadas, ${Math.round(metrics.acceptanceRate * 100)}% aceitas). ` +
          `Para ativar antes disso, confirme o aceite de risco.`
      );
    }
  }

  // Tetos de resposta: inteiro >= 0, com 0 = sem limite (ver a condição 9 de
  // evaluateEligibility). Fracionário/negativo viraria um teto silencioso.
  for (const [label, value] of [
    ["Máx. respostas por conversa", patch.maxRepliesPerConversation],
    ["Máx. respostas por hora", patch.maxRepliesPerHour],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label}: use um número inteiro maior ou igual a zero (0 = sem limite)`);
    }
  }

  // Agrupamento de mensagens: 1s a 120s. Zero não faz sentido (responderia no
  // meio da digitação) e o teto evita conversa que nunca recebe resposta.
  const debounce = patch.messageDebounceSeconds;
  if (debounce !== undefined && (!Number.isInteger(debounce) || debounce < 1 || debounce > 120)) {
    throw new Error("Agrupar mensagens por: use um número inteiro de segundos entre 1 e 120");
  }

  // Follow-ups: faixas validadas no SERVIDOR — a UI é só a primeira barreira,
  // e um `quietStartHour` maior que o fim viraria "nunca manda" (ou, pior,
  // "manda a qualquer hora") sem ninguém entender por quê.
  let followUps = patch.followUps;
  if (followUps !== undefined && followUps !== null) {
    // Chave do campo da data do evento: trim, vazio limpa, formato de chave.
    const rawKey = followUps.eventDateField?.trim();
    if (rawKey !== undefined && rawKey !== "") {
      if (rawKey.length > 64 || !/^[a-z0-9_]+$/.test(rawKey)) {
        throw new Error(
          "Campo da data do evento: use a chave do campo (letras minúsculas, números e _, até 64 caracteres)"
        );
      }
    }
    followUps = { ...followUps, eventDateField: rawKey || undefined };
    const { maxChain, quietStartHour, quietEndHour, dailyCap } = followUps;
    if (
      maxChain !== undefined &&
      (!Number.isInteger(maxChain) || maxChain < 1 || maxChain > MAX_CHAIN_LIMIT)
    ) {
      throw new Error(
        `Follow-ups seguidos sem resposta: use um número inteiro entre 1 e ${MAX_CHAIN_LIMIT}`
      );
    }
    for (const [label, hour] of [
      ["Início da janela de envio", quietStartHour],
      ["Fim da janela de envio", quietEndHour],
    ] as const) {
      if (hour === undefined) continue;
      if (!Number.isInteger(hour) || hour < 0 || hour > 24) {
        throw new Error(`${label}: use uma hora inteira entre 0 e 24`);
      }
    }
    const start = quietStartHour ?? DEFAULT_QUIET_START_HOUR;
    const end = quietEndHour ?? DEFAULT_QUIET_END_HOUR;
    if (start >= end) {
      throw new Error("A janela de envio precisa começar antes de terminar");
    }
    if (
      dailyCap !== undefined &&
      (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > MAX_DAILY_CAP)
    ) {
      throw new Error(
        `Teto diário de follow-ups: use um número inteiro entre 0 e ${MAX_DAILY_CAP} (0 = sem teto)`
      );
    }
  }

  // Guardrail anti-bot: MERGE com o que já está gravado (um patch só com
  // `enabled` não apaga a etiqueta custom); etiqueta validada no servidor
  // (trim, 1–40, sem vírgula — a UI separa tags por vírgula); `tag:""`
  // remove a etiqueta (volta à padrão); `null` remove o objeto inteiro.
  const botGuard =
    patch.botGuard === undefined
      ? undefined
      : patch.botGuard === null
        ? null
        : mergeBotGuard(agent.agentProfile.botGuard, patch.botGuard);

  // P4: integridade do pipelineConfig — board da org; estágios do board certo.
  const pipelineConfig = patch.pipelineConfig;
  if (pipelineConfig !== undefined && pipelineConfig !== null) {
    if (pipelineConfig.boardId) {
      const board = await ctx.db.get(pipelineConfig.boardId);
      if (!board || board.organizationId !== agent.organizationId) {
        throw new Error("Funil não encontrado nesta organização");
      }
    }
    for (const [field, stageId] of [
      ["estágio inicial", pipelineConfig.initialStageId],
      ["estágio pós-qualificação", pipelineConfig.qualifiedStageId],
    ] as const) {
      if (!stageId) continue;
      const stage = await ctx.db.get(stageId);
      if (!stage || stage.organizationId !== agent.organizationId) {
        throw new Error(`Estágio (${field}) não encontrado nesta organização`);
      }
      // O estágio inicial precisa pertencer ao board configurado; o de
      // qualificação é validado de novo em runtime contra o board ATUAL do lead.
      if (
        field === "estágio inicial" &&
        pipelineConfig.boardId &&
        stage.boardId !== pipelineConfig.boardId
      ) {
        throw new Error("O estágio inicial não pertence ao funil escolhido");
      }
    }
    if (
      pipelineConfig.qualifyThreshold !== undefined &&
      (pipelineConfig.qualifyThreshold < 1 || pipelineConfig.qualifyThreshold > 4)
    ) {
      throw new Error("O limiar de qualificação deve ficar entre 1 e 4 (BANT)");
    }
  }

  const {
    schedule,
    pipelineConfig: _pc,
    followUps: _fu,
    botGuard: _bg,
    systemPrompt: patchSystemPrompt,
    knowledge: patchKnowledge,
    ...rest
  } = patch;
  const clean = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined)
  );
  const now = Date.now();
  const writesTexts = patchSystemPrompt !== undefined || patchKnowledge !== undefined;
  // Texto do audit: só o campo que o patch trouxe E mudou (antes o audit
  // copiava o perfil INTEIRO com os 35 KB nos dois lados a cada salvar).
  const textsBefore = writesTexts ? await readAgentTexts(ctx, agent) : null;
  const next: AgentProfile = {
    ...agent.agentProfile,
    ...clean,
    ...(schedule !== undefined ? { schedule: schedule ?? undefined } : {}),
    ...(pipelineConfig !== undefined
      ? { pipelineConfig: pipelineConfig ?? undefined }
      : {}),
    ...(followUps !== undefined ? { followUps: followUps ?? undefined } : {}),
    ...(botGuard !== undefined ? { botGuard: botGuard ?? undefined } : {}),
    ...(autopilotEarly ? { autopilotEarlyAck: { acceptedAt: now, acceptedBy: member._id } } : {}),
  };
  // Texto vai para `agentProfileTexts` (e migra o membro legado na mesma
  // transação); metadado só regrava o doc, que num membro migrado já não
  // tem os textos — o spread de `agent.agentProfile` não os reintroduz.
  const saved = writesTexts
    ? await writeAgentTexts(
        ctx,
        agent,
        { systemPrompt: patchSystemPrompt, knowledge: patchKnowledge },
        { profile: next, now }
      )
    : next;
  if (!writesTexts) await ctx.db.patch(agent._id, { agentProfile: saved, updatedAt: now });
  if (renamed) await ctx.db.patch(agent._id, { name: newName, updatedAt: now });
  const textChanges: { before: Record<string, unknown>; after: Record<string, unknown> } = {
    before: {},
    after: {},
  };
  if (textsBefore) {
    for (const [field, value] of [
      ["systemPrompt", patchSystemPrompt],
      ["knowledge", patchKnowledge],
    ] as const) {
      const previous = textsBefore[field] ?? "";
      if (value === undefined || value === previous) continue;
      textChanges.before[field] = await auditTextSnapshot(previous);
      textChanges.after[field] = await auditTextSnapshot(value);
    }
  }
  // Legado: o doc ainda carrega os ~35 KB; o audit leva só metadado (o texto,
  // quando muda, vai em `textChanges`).
  const beforeMeta = stripAgentTexts(agent.agentProfile);

  await ctx.db.insert("auditLogs", {
    organizationId: agent.organizationId,
    entityType: "teamMember",
    entityId: agent._id,
    action: "update",
    actorId: member._id,
    actorType: "human",
    changes: {
      before: {
        agentProfile: beforeMeta as unknown as Record<string, unknown>,
        ...(renamed ? { name: agent.name } : {}),
        ...textChanges.before,
      },
      after: {
        agentProfile: stripAgentTexts(saved) as unknown as Record<string, unknown>,
        ...(renamed ? { name: newName } : {}),
        ...textChanges.after,
      },
    },
    metadata: {
        name: agent.name,
        agentConfig: true,
        ...(autopilotEarly ? { autopilotEarly: true } : {}),
        ...(renamed ? { renamedTo: newName } : {}),
        ...(params.via ? { via: params.via } : {}),
      },
    description: autopilotEarly
      ? `Ativou o AUTOPILOT ANTECIPADO do atendente '${agent.name}' — pulou o gate de métricas com aceite de risco`
      : patch.mode === "autopilot"
        ? `Ativou o AUTOPILOT do atendente '${agent.name}'`
        : `Atualizou o perfil do agente IA '${agent.name}'`,
    severity: patch.mode === "autopilot" ? "high" : "medium",
    createdAt: now,
  });
  return null;
}


export type FeatureTogglesPatch = {
  copilotEnabled?: boolean;
  attendantEnabled?: boolean;
  visionEnabled?: boolean;
  groupAgentEnabled?: boolean;
  /** Resposta em áudio (seção 5 do plano, porta `lib/tts.ts`). Ausente = desligada. */
  voiceReplyEnabled?: boolean;
  /** Voz de catálogo (`TTS_VOICES`); outra coisa é recusada. */
  voiceReplyVoice?: string;
  /** Aviso de voz sintética no 1º áudio da conversa; `""` remove (sem aviso). */
  voiceReplyNotice?: string;
};

/** Liga/desliga os produtos de IA da org (sob o mestre `aiConfig.enabled`). */
export async function setFeatureTogglesCore(
  ctx: MutationCtx,
  params: { org: Doc<"organizations">; member: Doc<"teamMembers">; toggles: FeatureTogglesPatch; via?: ConfigVia }
): Promise<null> {
  const { org, member, toggles } = params;
  if (member.organizationId !== org._id) throw new Error("Organização não encontrada");
  if (!org.settings.aiConfig) throw new Error("Ative a IA primeiro");
  const current = org.settings.aiConfig;
  if (toggles.voiceReplyVoice !== undefined && !isTtsVoice(toggles.voiceReplyVoice)) {
    throw new ConvexError("Voz desconhecida: escolha uma das vozes da lista.");
  }
  let notice: string | null | undefined;
  if (toggles.voiceReplyNotice !== undefined) {
    const trimmed = toggles.voiceReplyNotice.replace(/\s+/g, " ").trim();
    if (trimmed.length > VOICE_NOTICE_MAX_CHARS) {
      throw new ConvexError(`O aviso de voz pode ter até ${VOICE_NOTICE_MAX_CHARS} caracteres.`);
    }
    // O aviso é FALADO: nada de número, link, e-mail, valor, endereço ou código
    // (as mesmas regras que mandam esses dados para o texto na resposta).
    if (trimmed.length > 0 && voiceDataKinds(trimmed).length > 0) {
      throw new ConvexError(
        "O aviso de voz não pode ter números, links, e-mails, valores, endereços ou códigos: ele é falado no áudio."
      );
    }
    notice = trimmed.length > 0 ? trimmed : null; // null = remover
  }
  // `""` remove o aviso: sai do objeto (patch de campo aninhado não aceita undefined).
  const { voiceReplyNotice: _previousNotice, ...currentWithoutNotice } = current;
  const base = notice === null ? currentWithoutNotice : current;

  const now = Date.now();
  await ctx.db.patch(org._id, {
    settings: {
      ...org.settings,
      aiConfig: {
        ...base,
        ...(toggles.copilotEnabled !== undefined ? { copilotEnabled: toggles.copilotEnabled } : {}),
        ...(toggles.attendantEnabled !== undefined
          ? { attendantEnabled: toggles.attendantEnabled }
          : {}),
        ...(toggles.visionEnabled !== undefined ? { visionEnabled: toggles.visionEnabled } : {}),
        ...(toggles.groupAgentEnabled !== undefined
          ? { groupAgentEnabled: toggles.groupAgentEnabled }
          : {}),
        ...(toggles.voiceReplyEnabled !== undefined
          ? { voiceReplyEnabled: toggles.voiceReplyEnabled }
          : {}),
        ...(toggles.voiceReplyVoice !== undefined
          ? { voiceReplyVoice: toggles.voiceReplyVoice }
          : {}),
        ...(typeof notice === "string" ? { voiceReplyNotice: notice } : {}),
      },
    },
    updatedAt: now,
  });

  await ctx.db.insert("auditLogs", {
    organizationId: org._id,
    entityType: "organization",
    entityId: org._id,
    action: "update",
    actorId: member._id,
    actorType: "human",
    changes: {
      before: {
        copilotEnabled: current.copilotEnabled !== false,
        attendantEnabled: current.attendantEnabled !== false,
        visionEnabled: current.visionEnabled === true,
        groupAgentEnabled: current.groupAgentEnabled === true,
        ...(toggles.voiceReplyEnabled !== undefined
          ? { voiceReplyEnabled: current.voiceReplyEnabled === true }
          : {}),
        ...(toggles.voiceReplyVoice !== undefined ? { voiceReplyVoice: current.voiceReplyVoice ?? null } : {}),
        ...(notice !== undefined ? { voiceReplyNotice: current.voiceReplyNotice ?? null } : {}),
      },
      after: {
        copilotEnabled: toggles.copilotEnabled ?? current.copilotEnabled !== false,
        attendantEnabled: toggles.attendantEnabled ?? current.attendantEnabled !== false,
        visionEnabled: toggles.visionEnabled ?? current.visionEnabled === true,
        groupAgentEnabled: toggles.groupAgentEnabled ?? current.groupAgentEnabled === true,
        ...(toggles.voiceReplyEnabled !== undefined
          ? { voiceReplyEnabled: toggles.voiceReplyEnabled }
          : {}),
        ...(toggles.voiceReplyVoice !== undefined ? { voiceReplyVoice: toggles.voiceReplyVoice } : {}),
        ...(notice !== undefined ? { voiceReplyNotice: notice } : {}),
      },
    },
    metadata: { aiConfig: true, ...(params.via ? { via: params.via } : {}) },
    description: "Atualizou os toggles dos produtos de IA (copiloto, atendente, imagens, grupos, resposta em áudio)",
    severity: "medium",
    createdAt: now,
  });
  return null;
}

/** Transcrição automática de áudio de um canal (WhatsApp Meta ou bridge). */
export async function patchChannelTranscriptionCore(
  ctx: MutationCtx,
  params: {
    config: Doc<"channelConfigs">;
    member: Doc<"teamMembers">;
    enabled: boolean;
    via?: ConfigVia;
  }
): Promise<null> {
  const { config, member, enabled } = params;
  if (member.organizationId !== config.organizationId) {
    throw new Error("Channel config not found");
  }
  if (config.channel !== "whatsapp") {
    throw new Error("Edição de credenciais não é suportada para este canal.");
  }
  const now = Date.now();
  await ctx.db.patch(config._id, { autoTranscribeAudio: enabled, updatedAt: now });
  await ctx.db.insert("auditLogs", {
    organizationId: config.organizationId,
    entityType: "channelConfig",
    entityId: config._id,
    action: "update",
    actorId: member._id,
    actorType: member.type === "ai" ? "ai" : "human",
    changes: {
      before: { autoTranscribeAudio: config.autoTranscribeAudio ?? null },
      after: { autoTranscribeAudio: enabled },
    },
    metadata: {
      name: config.displayName,
      channel: config.channel,
      changedFields: ["autoTranscribeAudio"],
      ...(params.via ? { via: params.via } : {}),
    },
    description: buildAuditDescription({
      action: "update",
      entityType: "channelConfig",
      metadata: { name: config.displayName },
    }),
    severity: "high",
    createdAt: now,
  });
  return null;
}
