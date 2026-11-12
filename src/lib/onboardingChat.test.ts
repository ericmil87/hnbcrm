import { describe, expect, it } from "vitest";
import { coherentChips, type RoadmapFacts } from "../../convex/lib/onboardingRoadmap";
import {
  accountProgress,
  blockKey,
  buildTimeline,
  cardIsLatest,
  chatProgress,
  collapsedBlockLine,
  currentChips,
  isBareEmailCode,
  nextStepFor,
  plainModelText,
  shouldProcessPending,
  supersededBlockKeys,
  type HistoryMessage,
  type PendingTurn,
} from "./onboardingChat";

function msg(id: string, role: "user" | "assistant", text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage {
  return { _id: id, role, text, blocks: [], chips: [], attachment: null, createdAt: 1, ...extra };
}

function pending(extra: Partial<PendingTurn> = {}): PendingTurn {
  return {
    userText: "Quero vender mais",
    baselineId: "m2",
    startedAt: 100,
    replyText: "",
    blocks: [],
    chips: [],
    status: null,
    streaming: true,
    ...extra,
  };
}

const facts = (over: Partial<RoadmapFacts> = {}): RoadmapFacts => ({
  draft: null,
  approvals: {},
  aiActive: false,
  applied: false,
  tested: false,
  connected: false,
  emailVerified: true,
  ...over,
});

describe("progresso do roteiro", () => {
  it("sem login/sem organização: 'Crie a sua conta' antes da etapa 1, tudo em português", () => {
    const p = accountProgress();
    expect(p).toMatchObject({ index: 0, total: 6, label: "Crie a sua conta" });
    expect(p.steps.map((s) => s.label)).toEqual(["Negócio", "Funil", "Atendente", "Ativar", "Testar", "Conectar"]);
    expect(p.steps.every((s) => s.state === "todo")).toBe(true);
  });
  it("conversa aberta sem rascunho: etapa 1 Negócio", () => {
    const p = chatProgress(facts());
    expect(p).toMatchObject({ index: 1, label: "Negócio", valueText: "Etapa 1 de 6: Negócio" });
    expect(p.steps[0].state).toBe("current");
  });
  it("nunca regride: reachedStep do servidor e o máximo visto na tela sustentam a barra", () => {
    expect(chatProgress(facts({ reachedStep: 3 })).index).toBe(4);
    expect(chatProgress(facts({ reachedStep: 0 }), 5).label).toBe("Testar");
    const p = chatProgress(facts({ reachedStep: 1 }), 3);
    expect(p.index).toBe(3);
    expect(p.steps.map((s) => s.state)).toEqual(["done", "done", "current", "todo", "todo", "todo"]);
  });
  it("concluído: tudo feito e rótulo em português", () => {
    const p = chatProgress(facts({ applied: true, aiActive: true, tested: true, connected: true }));
    expect(p.complete).toBe(true);
    expect(p.valueText).toBe("Configuração concluída");
    expect(p.steps.every((s) => s.state === "done")).toBe(true);
  });
  it("nenhum rótulo em inglês em nenhum estado", () => {
    const all = [accountProgress(), chatProgress(facts()), chatProgress(facts(), 6), chatProgress(facts({ reachedStep: 99 }))];
    for (const p of all) expect(`${p.label} ${p.valueText} ${p.steps.map((s) => s.label).join(" ")}`).not.toMatch(/interview|draft|applied|account|materials|test\b/i);
  });
  it("próximo passo: sem rascunho é contar do negócio; concluído é abrir o CRM", () => {
    expect(nextStepFor(facts())).toMatchObject({ task: "describe_business", label: "Contar sobre o meu negócio", cardKind: null });
    expect(nextStepFor(facts({ applied: true, aiActive: true, tested: true, connected: true }))).toMatchObject({
      task: "done",
      label: "Abrir o meu CRM",
    });
  });
});

describe("código de e-mail digitado", () => {
  it("só exatamente 6 dígitos valem como código", () => {
    expect(isBareEmailCode("123456")).toBe(true);
    expect(isBareEmailCode(" 123456 ")).toBe(true);
    expect(isBareEmailCode("12345")).toBe(false);
    expect(isBareEmailCode("1234567")).toBe(false);
    expect(isBareEmailCode("meu cep é 123456")).toBe(false);
  });
});

describe("cartões sem repetição (supersededBlockKeys)", () => {
  const funil = { kind: "funilPreview", funnelName: "Vendas", stages: [], customFields: [], blockedCount: 0 };
  const persona = { kind: "personaCard" };
  const item = (key: string, blocks: unknown[], role: "assistant" | "user" = "assistant") => ({ key, role, blocks });

  it("o mesmo cartão em várias mensagens: só a mais recente fica inteira (histórico antigo com o funil 3 vezes)", () => {
    const t = [item("a", [funil]), item("b", [funil, persona]), item("c", [funil])];
    const s = supersededBlockKeys(t);
    expect(s.has(blockKey("a", 0))).toBe(true);
    expect(s.has(blockKey("b", 0))).toBe(true);
    expect(s.has(blockKey("c", 0))).toBe(false);
    expect(s.has(blockKey("b", 1))).toBe(false);
  });
  it("tipos diferentes e tipos de conversa (chips, upload) não são tocados", () => {
    const t = [item("a", [funil, { kind: "chips", options: [] }, { kind: "uploadProgresso" }]), item("b", [{ kind: "uploadProgresso" }])];
    expect(supersededBlockKeys(t).size).toBe(0);
  });
  it("cartões de ação repetidos (ativarIa, operacaoPronta, cartaoConta) recolhem os anteriores", () => {
    const t = [item("a", [{ kind: "cartaoConta" }, { kind: "ativarIa" }]), item("u", [], "user"), item("b", [{ kind: "cartaoConta" }, { kind: "ativarIa" }, { kind: "operacaoPronta" }])];
    const s = supersededBlockKeys(t);
    expect([...s].sort()).toEqual([blockKey("a", 0), blockKey("a", 1)].sort());
  });
  it("aplicarOperacao/cartaoAceite antigos: recolhidos quando não são a mensagem mais recente; funcionam como hoje na última", () => {
    const old = [item("a", [{ kind: "aplicarOperacao" }, { kind: "cartaoAceite" }]), item("b", [funil])];
    expect(supersededBlockKeys(old).size).toBe(2);
    const latest = [item("b", [funil]), item("a", [{ kind: "aplicarOperacao" }])];
    expect(supersededBlockKeys(latest).size).toBe(0);
  });
  it("linha recolhida diz onde está o cartão atual", () => {
    expect(collapsedBlockLine("funilPreview")).toBe("Funil de vendas · atualizado mais abaixo");
    expect(collapsedBlockLine("aplicarOperacao")).toMatch(/cartão mais recente/);
  });
  it("cardIsLatest: o cartão está na última mensagem do Copiloto", () => {
    expect(cardIsLatest([item("a", [funil])], "funilPreview")).toBe(true);
    expect(cardIsLatest([item("a", [funil]), item("u", [], "user")], "funilPreview")).toBe(false);
    expect(cardIsLatest([item("a", [funil])], null)).toBe(false);
  });
});

describe("sugestões coerentes na tela", () => {
  it("sugestão gravada antes de uma ação some quando ela conclui", () => {
    const draft = { business: { description: "passeios de buggy" } } as never;
    expect(coherentChips(["Tenho uma clínica", "Vendo serviços", "Outra coisa"], facts({ draft }))).toEqual(["Outra coisa"]);
    expect(coherentChips(["Confirmar o e-mail", "Seguir"], facts({ emailVerified: true }))).toEqual(["Seguir"]);
    expect(coherentChips(["Testar a IA", "Seguir"], facts({ tested: true }))).toEqual(["Seguir"]);
  });
});

describe("process_pending sem laço", () => {
  const base = { emailVerified: true, noticeOk: true, idle: true, queued: 0, pending: 2, lastAttempt: null as number | null };
  it("tenta uma vez; só repete se o número cair", () => {
    expect(shouldProcessPending(base)).toBe(true);
    expect(shouldProcessPending({ ...base, lastAttempt: 2 })).toBe(false);
    expect(shouldProcessPending({ ...base, pending: 1, lastAttempt: 2 })).toBe(true);
  });
  it("espera e-mail, ciência, conversa ociosa e a fila de arquivos", () => {
    expect(shouldProcessPending({ ...base, emailVerified: false })).toBe(false);
    expect(shouldProcessPending({ ...base, noticeOk: false })).toBe(false);
    expect(shouldProcessPending({ ...base, idle: false })).toBe(false);
    expect(shouldProcessPending({ ...base, queued: 1 })).toBe(false);
    expect(shouldProcessPending({ ...base, pending: 0 })).toBe(false);
  });
});

describe("plainModelText", () => {
  it("tira HTML, imagem, link e URL; mantém quebras", () => {
    const raw = 'Oi <b>Ana</b>!\n<img src=x onerror=alert(1)>Veja ![logo](https://x.com/a.png) e [clique](https://mal.example) ou https://mal.example/p?q=1 ou www.mal.example\n\n\n\nFim';
    const out = plainModelText(raw);
    expect(out).not.toMatch(/<|>|https?:|www\.|\]\(/);
    expect(out).toContain("Oi Ana!");
    expect(out).toContain("Veja logo e clique ou [link removido] ou [link removido]");
    expect(out).toContain("\n\nFim");
    expect(out).not.toContain("\n\n\n");
  });
  it("remove invisíveis e esquemas perigosos; não-string vira vazio", () => {
    expect(plainModelText("a\u200Bb\uFEFFc")).toBe("abc");
    expect(plainModelText("javascript:alert(1)")).toBe("[link removido]");
    expect(plainModelText("<script>alert(1)</script>Oi<style>p{}</style>")).toBe("Oi");
    expect(plainModelText(42)).toBe("");
    expect(plainModelText(null)).toBe("");
  });
});

describe("plainModelText e caracteres de junção", () => {
  it("ZWJ/ZWNJ ficam (emoji compostos e escritas que dependem deles); zero-width space sai", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(plainModelText(`Familia ${family}`)).toBe(`Familia ${family}`);
    expect(plainModelText("a\u200Cb")).toBe("a\u200Cb");
    expect(plainModelText("a\u200Bb\uFEFFc\u202Ed")).toBe("abcd");
  });
});

describe("buildTimeline", () => {
  const history = [msg("m2", "assistant", "Qual o nome?", { chips: ["Loja X"] }), msg("m1", "user", "Oi")];

  it("sem turno pendente: histórico em ordem cronológica", () => {
    expect(buildTimeline(history, null).map((t) => t.key)).toEqual(["m1", "m2"]);
  });

  it("turno em andamento: bolha da pessoa e resposta parcial no fim", () => {
    const tl = buildTimeline(history, pending({ replyText: "Leg" }));
    expect(tl.map((t) => t.key)).toEqual(["m1", "m2", "pending:user", "pending:assistant"]);
    expect(tl[3]).toMatchObject({ role: "assistant", text: "Leg", pending: true });
  });

  it("sem texto nem bloco ainda: só a bolha da pessoa (os pontos vêm da tela)", () => {
    expect(buildTimeline(history, pending()).map((t) => t.key)).toEqual(["m1", "m2", "pending:user"]);
  });

  it("mensagem da pessoa já no histórico: some a pendente dela, a resposta segue", () => {
    const h = [msg("m3", "user", "Quero vender mais"), ...history];
    const keys = buildTimeline(h, pending({ replyText: "Ok" })).map((t) => t.key);
    expect(keys).toEqual(["m1", "m2", "m3", "pending:assistant"]);
  });

  it("resposta já no histórico: nada pendente duplicado; áudio do stream completa a resposta", () => {
    const h = [msg("m4", "assistant", "Ok!"), msg("m3", "user", "Quero vender mais"), ...history];
    const audio = { url: "https://abc.convex.cloud/api/storage/a1", durationSec: 2, mimeType: "audio/wav" };
    const tl = buildTimeline(h, pending({ replyText: "Ok!", streaming: false, audio }));
    expect(tl.map((t) => t.key)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(tl[3].audio).toEqual(audio);
  });

  it("áudio fora do storage do Convex (histórico ou stream) não vira player", () => {
    const h = [msg("m4", "assistant", "Ok!", { audio: { url: "https://mal.example/a.wav", durationSec: 1, mimeType: "audio/wav" } }), msg("m3", "user", "Quero vender mais"), ...history];
    const tl = buildTimeline(h, pending({ audio: { url: "http://abc.convex.cloud/a.wav", durationSec: 1, mimeType: "audio/wav" } }));
    expect(tl.find((t) => t.key === "m4")?.audio).toBeUndefined();
    expect(buildTimeline(h, null).find((t) => t.key === "m4")?.audio).toBeUndefined();
  });

  it("histórico vazio (baseline null): tudo o que chegar é do turno", () => {
    expect(buildTimeline([], pending({ baselineId: null })).map((t) => t.key)).toEqual(["pending:user"]);
    const h = [msg("a1", "assistant", "Oi"), msg("u1", "user", "Quero vender mais")];
    expect(buildTimeline(h, pending({ baselineId: null })).map((t) => t.key)).toEqual(["u1", "a1"]);
  });
});

describe("currentChips", () => {
  it("chips da última resposta; depois de mensagem da pessoa, nenhum; vazio usa o reserva", () => {
    const tl = buildTimeline([msg("m2", "assistant", "?", { chips: ["A", "B"] }), msg("m1", "user", "Oi")], null);
    expect(currentChips(tl)).toEqual(["A", "B"]);
    expect(currentChips([...tl, { key: "u", role: "user", text: "x", blocks: [], chips: [] }])).toEqual([]);
    expect(currentChips([], ["Saudação"])).toEqual(["Saudação"]);
  });
});
