import { describe, expect, test } from "vitest";
import { conversationAiMode, isAiPaused, listAiMode } from "./conversationAiMode";

const org = (cfg: Record<string, unknown> = {}) =>
  ({ settings: { aiConfig: { enabled: true, lgpdAck: {}, ...cfg } } }) as any;
const agent = (mode: "suggest" | "autopilot" = "autopilot", profile: Record<string, unknown> = {}) =>
  ({ _id: "ai1", status: "active", agentProfile: { kind: "attendant", mode, ...profile } }) as any;
const conv = (extra: Record<string, unknown> = {}) => ({ channel: "whatsapp", ...extra }) as any;
const base = () => ({
  org: org(),
  aiMembers: [agent()],
  conversation: conv(),
  lead: { boardId: "b1" } as any,
  contact: null,
});

describe("conversationAiMode", () => {
  test("auto / suggest / off do atendente", () => {
    expect(conversationAiMode(base())).toBe("auto");
    expect(conversationAiMode({ ...base(), aiMembers: [agent("suggest")] })).toBe("suggest");
    expect(conversationAiMode({ ...base(), aiMembers: [] })).toBe("off");
  });
  test("org sem IA, sem aceite, atendente desligado", () => {
    expect(conversationAiMode({ ...base(), org: org({ enabled: false }) })).toBe("off");
    expect(conversationAiMode({ ...base(), org: org({ lgpdAck: undefined }) })).toBe("off");
    expect(conversationAiMode({ ...base(), org: org({ attendantEnabled: false }) })).toBe("off");
    expect(conversationAiMode({ ...base(), org: null })).toBe("off");
  });
  test("pausa: indefinida sempre; com prazo só com now", () => {
    const paused = { ...base(), conversation: conv({ aiPausedUntil: Number.MAX_SAFE_INTEGER }) };
    expect(conversationAiMode(paused)).toBe("off");
    const timed = { ...base(), conversation: conv({ aiPausedUntil: 5_000 }) };
    expect(conversationAiMode(timed)).toBe("auto");
    expect(conversationAiMode({ ...timed, now: 1_000 })).toBe("off");
    expect(conversationAiMode({ ...timed, now: 9_000 })).toBe("auto");
    expect(isAiPaused(undefined, 1)).toBe(false);
  });
  test("repasse pendente, suspeita de bot, lead de humano, opt-out", () => {
    const lead = (x: Record<string, unknown>) => ({ boardId: "b1", ...x }) as any;
    expect(conversationAiMode({ ...base(), lead: lead({ handoffState: { status: "pending" } }) })).toBe("off");
    expect(conversationAiMode({ ...base(), lead: lead({ handoffState: { status: "completed" } }) })).toBe("auto");
    expect(conversationAiMode({ ...base(), conversation: conv({ botSuspicion: {} }) })).toBe("off");
    expect(conversationAiMode({ ...base(), conversation: conv({ botSuspicion: { clearedAt: 1 } }) })).toBe("auto");
    expect(conversationAiMode({ ...base(), lead: lead({ assignedTo: "h1" }) })).toBe("off");
    expect(conversationAiMode({ ...base(), lead: lead({ assignedTo: "ai1" }) })).toBe("auto");
    expect(conversationAiMode({ ...base(), contact: { aiOptOut: true } })).toBe("off");
  });
  test("canal, bridge sem aceite, escopo de canal e funil", () => {
    expect(conversationAiMode({ ...base(), conversation: conv({ channel: "email" }) })).toBe("off");
    expect(conversationAiMode({ ...base(), conversation: conv({ channelProvider: "bridge" }) })).toBe("off");
    expect(
      conversationAiMode({ ...base(), org: org({ bridgeAiAck: {} }), conversation: conv({ channelProvider: "bridge" }) })
    ).toBe("auto");
    expect(conversationAiMode({ ...base(), aiMembers: [agent("autopilot", { channelConfigIds: ["x"] })] })).toBe("off");
    expect(conversationAiMode({ ...base(), aiMembers: [agent("autopilot", { boardIds: ["other"] })] })).toBe("off");
  });
  test("grupo: flag própria do agente de grupo", () => {
    const g = { ...base(), conversation: conv({ kind: "group" }), lead: null, aiMembers: [] };
    expect(conversationAiMode(g)).toBe("off");
    expect(conversationAiMode({ ...g, org: org({ groupAgentEnabled: true }) })).toBe("auto");
  });
  test("lista: grupo fica sem estado (null), 1 a 1 igual à regra", () => {
    const g = { ...base(), conversation: conv({ kind: "group" }), lead: null, aiMembers: [] };
    expect(listAiMode(g)).toBeNull();
    expect(listAiMode({ ...g, org: org({ groupAgentEnabled: true }) })).toBeNull();
    expect(listAiMode(base())).toBe("auto");
  });
  test("Instagram/Messenger só com o módulo da org ligado", () => {
    const ig = { ...base(), conversation: conv({ channel: "instagram" }) };
    expect(conversationAiMode(ig)).toBe("off");
    const withModule = org();
    withModule.settings.modules = { metaMessaging: true };
    expect(conversationAiMode({ ...ig, org: withModule })).toBe("auto");
  });
});
