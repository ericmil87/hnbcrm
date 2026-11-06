import { describe, expect, it } from "vitest";
import {
  HEADER_DETAILS_KEY,
  headerSubtitle,
  readHeaderDetailsOpen,
  writeHeaderDetailsOpen,
  type HeaderSubtitleInput,
} from "./conversationHeader";

const base: HeaderSubtitleInput = {
  typing: false,
  isGroup: false,
  participantsCount: 0,
  handoffPending: false,
  botSuspected: false,
  aiProcessing: false,
  funnel: { board: "Jornada", stage: "Em conversa" },
};

describe("headerSubtitle", () => {
  it("mostra Funil → Etapa por padrão", () => {
    expect(headerSubtitle(base)).toEqual({ text: "Jornada → Em conversa", tone: "muted" });
  });
  it("digitando vence tudo", () => {
    expect(headerSubtitle({ ...base, typing: true, handoffPending: true })?.text).toBe("digitando…");
    expect(headerSubtitle({ ...base, typing: true, isGroup: true })?.text).toBe("alguém está digitando…");
  });
  it("repasse vence robô e IA preparando", () => {
    expect(headerSubtitle({ ...base, handoffPending: true, botSuspected: true })?.text).toBe("A IA pediu ajuda");
    expect(headerSubtitle({ ...base, botSuspected: true, aiProcessing: true })?.tone).toBe("attention");
    expect(headerSubtitle({ ...base, aiProcessing: true })?.tone).toBe("ai");
  });
  it("IA em espera aparece antes do funil", () => {
    expect(headerSubtitle({ ...base, aiWaiting: true })).toEqual({ text: "IA em espera", tone: "attention" });
  });
  it("sala mostra participantes", () => {
    expect(headerSubtitle({ ...base, isGroup: true, participantsCount: 12 })?.text).toBe("12 participantes");
    expect(headerSubtitle({ ...base, isGroup: true, participantsCount: 1 })?.text).toBe("1 participante");
  });
  it("sem funil carregado não inventa texto", () => {
    expect(headerSubtitle({ ...base, funnel: null })).toBeNull();
    expect(headerSubtitle({ ...base, funnel: { stage: "Novo" } })?.text).toBe("Novo");
  });
});

describe("preferência dos detalhes", () => {
  it("padrão recolhido e persiste", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readHeaderDetailsOpen(storage)).toBe(false);
    writeHeaderDetailsOpen(true, storage);
    expect(store.get(HEADER_DETAILS_KEY)).toBe("1");
    expect(readHeaderDetailsOpen(storage)).toBe(true);
  });
  it("tolera localStorage bloqueado", () => {
    const broken = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
    };
    expect(readHeaderDetailsOpen(broken)).toBe(false);
    expect(() => writeHeaderDetailsOpen(true, broken)).not.toThrow();
  });
});
