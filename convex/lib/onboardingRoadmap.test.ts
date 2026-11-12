import { describe, expect, test } from "vitest";
import {
  ROADMAP_STEPS,
  actionCardSignature,
  cardSignature,
  coherentChips,
  materialPendingMessage,
  nextTask,
  planTurnCards,
  replyMentionsUi,
  roadmapForPrompt,
  roadmapProgress,
  sectionSignature,
  stepMessage,
  taskCard,
  taskChips,
  taskStepIndex,
  type RoadmapFacts,
  type RoadmapNotice,
  type RoadmapTask,
} from "./onboardingRoadmap";
import { templateStartDraft } from "./onboardingInterviewer";
import type { OnboardingDraft } from "./onboardingDraft";

function draftOf(description = "Passeios de buggy em Porto de Galinhas"): OnboardingDraft {
  const d = templateStartDraft("outro", "Passeios do Bruno");
  d.business.description = description;
  return d;
}

const base = (over: Partial<RoadmapFacts> = {}): RoadmapFacts => ({
  draft: draftOf(),
  approvals: {},
  aiActive: false,
  applied: false,
  tested: false,
  connected: false,
  emailVerified: false,
  ...over,
});

function approvedAll(d: OnboardingDraft) {
  return {
    funnel: sectionSignature(d, "funnel"),
    persona: sectionSignature(d, "persona"),
    knowledge: sectionSignature(d, "knowledge"),
  };
}

const TASKS: RoadmapTask[] = ["describe_business", "approve_funnel", "approve_persona", "approve_knowledge", "activate", "test", "connect", "done"];
const NOTICES: RoadmapNotice[] = ["approved", "email_verified", "activated", "tested", "connected", "skip_connect", "next", "material_pending"];

describe("nextTask: um passo por estado", () => {
  test("do negócio até o fim", () => {
    const d = draftOf();
    expect(nextTask(base({ draft: null }))).toBe("describe_business");
    expect(nextTask(base({ draft: draftOf("") }))).toBe("describe_business");
    expect(nextTask(base())).toBe("approve_funnel");
    expect(nextTask(base({ approvals: { funnel: sectionSignature(d, "funnel") } }))).toBe("approve_persona");
    expect(nextTask(base({ approvals: { funnel: sectionSignature(d, "funnel"), persona: sectionSignature(d, "persona") } }))).toBe("approve_knowledge");
    expect(nextTask(base({ approvals: approvedAll(d) }))).toBe("activate");
    const live = { approvals: approvedAll(d), applied: true, aiActive: true };
    expect(nextTask(base(live))).toBe("test");
    expect(nextTask(base({ ...live, tested: true }))).toBe("connect");
    expect(nextTask(base({ ...live, tested: true, connected: true }))).toBe("done");
  });

  test("aprovação vale só para a assinatura aprovada: mudou o funil, pede de novo", () => {
    const d = draftOf();
    const approvals = approvedAll(d);
    const changed = structuredClone(d);
    changed.funnel.stages[0].name = "Primeiro oi";
    expect(nextTask(base({ draft: changed, approvals }))).toBe("approve_funnel");
  });

  test("aplicada com a IA desligada volta a pedir a ativação, não o teste", () => {
    const d = draftOf();
    expect(nextTask(base({ approvals: approvedAll(d), applied: true, aiActive: false }))).toBe("activate");
  });
});

describe("barra de etapas", () => {
  test("rótulos em português, nunca inglês", () => {
    for (const step of ROADMAP_STEPS) expect(step.label).toMatch(/^[A-ZÀ-Ú][a-zà-ú]+$/);
    const labels = ROADMAP_STEPS.map((s) => s.label).join(" ");
    expect(labels).not.toMatch(/Materials|Draft|Interview|Test\b|Connect\b/);
    for (const task of TASKS) expect(taskStepIndex(task)).toBeGreaterThanOrEqual(0);
  });

  test("monótona ao longo do roteiro", () => {
    const d = draftOf();
    const states: RoadmapFacts[] = [
      base({ draft: null }),
      base(),
      base({ approvals: { funnel: sectionSignature(d, "funnel") } }),
      base({ approvals: approvedAll(d) }),
      base({ approvals: approvedAll(d), applied: true, aiActive: true }),
      base({ approvals: approvedAll(d), applied: true, aiActive: true, tested: true }),
      base({ approvals: approvedAll(d), applied: true, aiActive: true, tested: true, connected: true }),
    ];
    const idx = states.map((f) => roadmapProgress(f).index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(idx[0]).toBe(1);
    const last = roadmapProgress(states[states.length - 1]);
    expect(last.complete).toBe(true);
    expect(last.ratio).toBe(1);
    expect(last.valueText).toBe("Configuração concluída");
    expect(roadmapProgress(states[1]).valueText).toBe("Etapa 2 de 6: Funil");
  });

  test("reachedStep impede regressão quando uma seção aprovada muda", () => {
    const d = draftOf();
    const approvals = approvedAll(d);
    const changed = structuredClone(d);
    changed.funnel.name = "Outro nome";
    const before = roadmapProgress(base({ approvals, reachedStep: 3 }));
    expect(before.stepId).toBe("ativar");
    const after = roadmapProgress(base({ draft: changed, approvals, reachedStep: 3 }));
    expect(nextTask(base({ draft: changed, approvals }))).toBe("approve_funnel");
    expect(after.index).toBe(4);
    expect(after.label).toBe("Ativar");
    // Sem o reachedStep a barra voltaria para "Funil".
    expect(roadmapProgress(base({ draft: changed, approvals })).label).toBe("Funil");
  });

  test("reachedStep inválido ou fora da faixa é tolerado", () => {
    expect(roadmapProgress(base({ reachedStep: 99 })).index).toBe(ROADMAP_STEPS.length);
    expect(roadmapProgress(base({ reachedStep: -4 })).index).toBe(2);
    expect(roadmapProgress(base({ reachedStep: Number.NaN })).index).toBe(2);
  });
});

describe("planTurnCards: sem duplicar", () => {
  const noAction = { draftHash: "h1", appliedDraftHash: null };

  test("cartão do passo entra uma vez; idêntico nunca reaparece", () => {
    const f = base();
    const first = planTurnCards({ facts: f, shown: {}, requested: [], actionState: noAction });
    expect(first.map((c) => c.kind)).toEqual(["funilPreview"]);
    const shown = { funilPreview: first[0].sig };
    expect(planTurnCards({ facts: f, shown, requested: ["funilPreview"], actionState: noAction })).toEqual([]);
    expect(planTurnCards({ facts: f, shown, requested: ["funilPreview"], actionState: noAction })).toEqual([]);
  });

  test("cartão que pede aprovação não é adiantado pelo modelo: entra quando vira o passo", () => {
    const f = base();
    // Passo atual = funil; o modelo pede o jeito de atender e o conhecimento antes da hora.
    const early = planTurnCards({ facts: f, shown: {}, requested: ["personaCard", "conhecimentoLista"], actionState: noAction });
    expect(early.map((c) => c.kind)).toEqual(["funilPreview"]);
    // Cartão sem aprovação (resumo do negócio) pode ser pedido a qualquer momento.
    const withSummary = planTurnCards({ facts: f, shown: {}, requested: ["resumoNegocio"], actionState: noAction });
    expect(withSummary.map((c) => c.kind)).toEqual(["resumoNegocio", "funilPreview"]);
  });

  test("conteúdo que mudou reaparece uma vez", () => {
    const f = base();
    const shown = { funilPreview: cardSignature(f.draft, "funilPreview") };
    const changed = structuredClone(f.draft!);
    changed.funnel.stages[0].name = "Chegou";
    const plan = planTurnCards({ facts: { ...f, draft: changed }, shown, requested: [], actionState: noAction });
    expect(plan.map((c) => c.kind)).toEqual(["funilPreview"]);
    const shown2 = { funilPreview: plan[0].sig };
    expect(planTurnCards({ facts: { ...f, draft: changed }, shown: shown2, requested: [], actionState: noAction })).toEqual([]);
  });

  test("texto que cita cartão/botão anexa o cartão do passo mesmo repetido", () => {
    const f = base();
    const shown = { funilPreview: cardSignature(f.draft, "funilPreview") };
    expect(planTurnCards({ facts: f, shown, requested: [], actionState: noAction, mentionsUi: false })).toEqual([]);
    const plan = planTurnCards({ facts: f, shown, requested: [], actionState: noAction, mentionsUi: true });
    expect(plan.map((c) => c.kind)).toEqual(["funilPreview"]);
    expect(replyMentionsUi("Veja o cartão abaixo.")).toBe(true);
    expect(replyMentionsUi("Toque em Está bom.")).toBe(true);
    expect(replyMentionsUi("Me conta o que você vende.")).toBe(false);
  });

  test("pedido do modelo por cartão de ação ou de tipo desconhecido é ignorado; o do rascunho entra uma vez", () => {
    const f = base();
    const plan = planTurnCards({
      facts: f,
      shown: { funilPreview: cardSignature(f.draft, "funilPreview") },
      requested: ["ativarIa", "operacaoPronta", "aplicarOperacao", "rodarComando", "resumoNegocio"],
      actionState: noAction,
    });
    expect(plan.map((c) => c.kind)).toEqual(["resumoNegocio"]);
  });

  test("passo de ativar anexa o cartão de ação; muda com o estado da IA", () => {
    const d = draftOf();
    const f = base({ approvals: approvedAll(d) });
    const plan = planTurnCards({ facts: f, shown: {}, requested: [], actionState: noAction });
    expect(plan.at(-1)?.kind).toBe("ativarIa");
    const sigOff = actionCardSignature("ativarIa", { draftHash: "h1", appliedDraftHash: null, aiActive: false, tested: false, connected: false });
    const sigOn = actionCardSignature("ativarIa", { draftHash: "h1", appliedDraftHash: null, aiActive: true, tested: false, connected: false });
    expect(sigOff).not.toBe(sigOn);
  });

  test("sem negócio contado nenhum cartão do passo", () => {
    expect(planTurnCards({ facts: base({ draft: draftOf("") }), shown: {}, requested: [], actionState: noAction })).toEqual([]);
    expect(taskCard("describe_business")).toBeNull();
  });
});

describe("coherentChips", () => {
  test("nada de segmento depois do negócio contado", () => {
    const chips = ["Clínica ou consultório", "Tenho uma loja", "Vendo serviços", "Quero mudar o nome da IA"];
    expect(coherentChips(chips, base({ draft: draftOf("") }))).toEqual(chips);
    expect(coherentChips(chips, base())).toEqual(["Quero mudar o nome da IA"]);
  });

  test("nada de e-mail, aceite ou montar depois de feitos", () => {
    const chips = ["Confirmar e-mail", "Aceitar termos", "Montar minha operação", "Ativar a IA", "Ok"];
    const open = coherentChips(chips, base());
    expect(open).toEqual(chips);
    expect(coherentChips(chips, base({ emailVerified: true }))).not.toContain("Confirmar e-mail");
    const done = coherentChips(chips, base({ emailVerified: true, aiActive: true, applied: true }));
    expect(done).toEqual(["Ok"]);
  });

  test("nada de horário: o padrão é 24h e ninguém precisa responder", () => {
    const d = draftOf();
    const f = base({ approvals: { persona: sectionSignature(d, "persona") } });
    expect(coherentChips(["Só no horário comercial", "Ok"], f)).toEqual(["Ok"]);
  });

  test("funil depois de aprovado; teste e conexão depois de concluídos", () => {
    const d = draftOf();
    expect(coherentChips(["Quero mudar as etapas", "Ok"], base({ approvals: { funnel: sectionSignature(d, "funnel") } }))).toEqual(["Ok"]);
    expect(coherentChips(["Testar a minha IA", "Conectar o WhatsApp", "Ok"], base({ tested: true, connected: true }))).toEqual(["Ok"]);
  });

  test("os chips da tarefa são coerentes com o estado em que aparecem", () => {
    for (const task of TASKS) {
      const chips = taskChips(task);
      for (const c of chips) expect(c.length).toBeLessThanOrEqual(40);
    }
    // Quem já descreveu o negócio nunca recebe os chips de segmento do passo 1.
    expect(coherentChips(taskChips("describe_business"), base()).length).toBeLessThan(taskChips("describe_business").length);
  });
});

describe("falas determinísticas", () => {
  test("stepMessage nunca é vazio, em nenhuma combinação", () => {
    for (const n of NOTICES) for (const t of TASKS) expect(stepMessage(n, t).trim().length).toBeGreaterThan(10);
  });

  test("nenhuma fala cita elemento de tela que o servidor não anexa", () => {
    for (const n of NOTICES) for (const t of TASKS) expect(stepMessage(n, t)).not.toMatch(/abaixo|cartão abaixo|botão abaixo/i);
  });

  test("e-mail confirmado com material guardado avisa que vai ler", () => {
    expect(stepMessage("email_verified", "approve_funnel", { pendingMaterials: 1 })).toContain("Já vou ler");
    expect(stepMessage("email_verified", "approve_funnel")).not.toContain("Já vou ler");
  });

  test("material pendente mostra o e-mail mascarado e respeita o teto", () => {
    expect(materialPendingMessage({ label: "o link de x.com", maskedEmail: "bu…te@milfont.net", stored: true })).toContain("bu…te@milfont.net");
    expect(materialPendingMessage({ label: "x", maskedEmail: null, stored: false })).toContain("demais");
  });

  test("o prompt recebe o respondido, o aprovado e o passo único", () => {
    const lines = roadmapForPrompt(base({ emailVerified: true })).join("\n");
    expect(lines).toContain("já respondido");
    expect(lines).toContain("PRÓXIMO PASSO (único)");
    expect(lines).toContain("e-mail confirmado: sim");
  });
});
