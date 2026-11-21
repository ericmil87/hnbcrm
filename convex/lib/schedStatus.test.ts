import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  ALL_STATUSES,
  type ActorClass,
  allocationEffect,
  canTransition,
  canUndo,
  checkTransition,
  INITIAL_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  type SchedStatus,
  TERMINAL_STATUSES,
  UNDO_TARGETS,
} from "./schedStatus";

const ACTORS: ActorClass[] = ["staff", "client", "ai", "system"];
const START = 1_000_000;
const AFTER = START + 1; // já começou
const BEFORE = START - 1;

// Tabela do §2.4 escrita à mão, independente da implementação: "de>para" -> atores.
const ALLOWED: Record<string, ActorClass[]> = {
  "pending_approval>scheduled": ["staff", "system"],
  "pending_approval>cancelled": ["staff", "client", "ai"],
  "scheduled>confirmed": ["staff", "client", "ai", "system"],
  "scheduled>checked_in": ["staff"],
  "confirmed>checked_in": ["staff"],
  "scheduled>completed": ["staff"],
  "confirmed>completed": ["staff"],
  "checked_in>completed": ["staff"],
  "scheduled>no_show": ["staff"],
  "confirmed>no_show": ["staff"],
  "scheduled>cancelled": ["staff", "client", "ai"],
  "confirmed>cancelled": ["staff", "client", "ai"],
  "scheduled>rescheduled": ["staff", "client", "ai", "system"],
  "confirmed>rescheduled": ["staff", "client", "ai", "system"],
  "pending_approval>rescheduled": ["staff", "client", "ai", "system"],
};

describe("canTransition — matriz completa (8 × 8 × 4 atores)", () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      for (const actor of ACTORS) {
        const expected = (ALLOWED[`${from}>${to}`] ?? []).includes(actor);
        it(`${from} → ${to} por ${actor}: ${expected ? "permite" : "recusa"}`, () => {
          // no_show só com now >= startTime: usa "já começou" para isolar a regra de quem/de onde
          expect(canTransition(from, to, actor, AFTER, START)).toBe(expected);
        });
      }
    }
  }
});

describe("no_show", () => {
  it("antes do início é recusado; no instante do início e depois passa (só equipe)", () => {
    expect(canTransition("scheduled", "no_show", "staff", BEFORE, START)).toBe(false);
    expect(checkTransition("confirmed", "no_show", "staff", BEFORE, START)).toEqual({ ok: false, reason: "no_show_before_start" });
    expect(canTransition("scheduled", "no_show", "staff", START, START)).toBe(true);
    expect(canTransition("confirmed", "no_show", "staff", AFTER, START)).toBe(true);
    expect(canTransition("scheduled", "no_show", "client", AFTER, START)).toBe(false);
    expect(canTransition("scheduled", "no_show", "system", AFTER, START)).toBe(false); // nunca por job
  });
  it("as demais transições não dependem do relógio", () => {
    expect(canTransition("scheduled", "completed", "staff", BEFORE, START)).toBe(true);
    expect(canTransition("scheduled", "cancelled", "client", BEFORE, START)).toBe(true);
  });
});

describe("motivos", () => {
  it("not_allowed × actor_not_allowed", () => {
    expect(checkTransition("completed", "scheduled", "staff", AFTER, START)).toEqual({ ok: false, reason: "not_allowed" });
    expect(checkTransition("scheduled", "checked_in", "client", AFTER, START)).toEqual({ ok: false, reason: "actor_not_allowed" });
    expect(checkTransition("scheduled", "confirmed", "client", AFTER, START)).toEqual({ ok: true });
  });
  it("estados terminais não saem pela frente", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ALL_STATUSES) for (const a of ACTORS) expect(canTransition(from, to, a, AFTER, START)).toBe(false);
    }
  });
  it("transição para o mesmo estado é recusada", () => {
    for (const s of ALL_STATUSES) for (const a of ACTORS) expect(canTransition(s, s, a, AFTER, START)).toBe(false);
  });
});

describe("desfazer", () => {
  it("só equipe, só dos estados com desfazer e para um estado anterior; rescheduled não tem", () => {
    expect(canUndo("cancelled", "scheduled", "staff")).toBe(true);
    expect(canUndo("cancelled", "pending_approval", "staff")).toBe(true);
    expect(canUndo("no_show", "confirmed", "staff")).toBe(true);
    expect(canUndo("completed", "checked_in", "staff")).toBe(true);
    expect(canUndo("checked_in", "scheduled", "staff")).toBe(true);
    expect(canUndo("confirmed", "scheduled", "staff")).toBe(true);
    for (const a of ["client", "ai", "system"] as const) expect(canUndo("cancelled", "scheduled", a)).toBe(false);
    expect(canUndo("rescheduled", "scheduled", "staff")).toBe(false);
    expect(canUndo("scheduled", "pending_approval", "staff")).toBe(false);
    expect(canUndo("pending_approval", "scheduled", "staff")).toBe(false);
    expect(canUndo("completed", "no_show", "staff")).toBe(false);
    expect(canUndo("cancelled", "completed", "staff")).toBe(false);
  });
  it("destinos do desfazer nunca incluem o próprio estado nem rescheduled", () => {
    for (const [from, tos] of Object.entries(UNDO_TARGETS)) {
      expect(tos).not.toContain(from);
      expect(tos).not.toContain("rescheduled");
    }
  });
});

describe("classificação e efeito nas alocações", () => {
  it("ativos e terminais particionam os 8 estados", () => {
    expect([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
    for (const s of ALL_STATUSES) expect(isActiveStatus(s)).toBe(!isTerminalStatus(s));
    expect(INITIAL_STATUSES).toEqual(["pending_approval", "scheduled"]);
  });
  it("cria, mantém, apaga e recria", () => {
    const eff = (f: SchedStatus | null, t: SchedStatus) => allocationEffect(f, t);
    expect(eff(null, "scheduled")).toBe("create");
    expect(eff(null, "pending_approval")).toBe("create");
    expect(eff("pending_approval", "scheduled")).toBe("keep");
    expect(eff("scheduled", "confirmed")).toBe("keep");
    expect(eff("scheduled", "completed")).toBe("keep");
    expect(eff("scheduled", "no_show")).toBe("delete");
    expect(eff("confirmed", "cancelled")).toBe("delete");
    expect(eff("pending_approval", "rescheduled")).toBe("delete");
    expect(eff("cancelled", "scheduled")).toBe("recreate");
    expect(eff("no_show", "confirmed")).toBe("recreate");
    expect(eff("cancelled", "no_show")).toBe("none");
  });
});
