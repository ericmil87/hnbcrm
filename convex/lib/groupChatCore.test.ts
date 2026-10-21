import { describe, expect, test } from "vitest";
import { Id } from "../_generated/dataModel";
import { mergeParticipant, mergeParticipantWithFlag, GroupParticipantRow } from "./groupChatCore";

const base: GroupParticipantRow[] = [
  { lid: "1@lid", phone: "5581999990001", name: "Ana", isAdmin: false, isSuperAdmin: false },
  { lid: "2@lid", phone: "5581999990002", isAdmin: true, isSuperAdmin: false },
];

describe("mergeParticipantWithFlag (perf Convex I/O, fase 3)", () => {
  test("participante igual: changed false e a MESMA referência", () => {
    const r = mergeParticipantWithFlag(base, { lid: "1@lid", phone: "5581999990001", name: "Ana" });
    expect(r.changed).toBe(false);
    expect(r.list).toBe(base);
  });

  test("nome vazio não conta como mudança", () => {
    const r = mergeParticipantWithFlag(base, { lid: "2@lid", name: "" });
    expect(r.changed).toBe(false);
    expect(r.list).toBe(base);
  });

  test("nome diferente muda e não mexe no array original", () => {
    const r = mergeParticipantWithFlag(base, { lid: "1@lid", name: "Ana Maria" });
    expect(r.changed).toBe(true);
    expect(r.list).not.toBe(base);
    expect(r.list[0].name).toBe("Ana Maria");
    expect(base[0].name).toBe("Ana");
  });

  test("contactId novo, admin e leftAt mudam; valor igual não", () => {
    const contactId = "c1" as Id<"contacts">;
    expect(mergeParticipantWithFlag(base, { lid: "2@lid", contactId }).changed).toBe(true);
    expect(mergeParticipantWithFlag(base, { lid: "2@lid", isAdmin: false }).changed).toBe(true);
    expect(mergeParticipantWithFlag(base, { lid: "2@lid", isAdmin: true }).changed).toBe(false);
    expect(mergeParticipantWithFlag(base, { lid: "2@lid", leftAt: 10 }).changed).toBe(true);
  });

  test("membro novo é acrescentado", () => {
    const r = mergeParticipantWithFlag(base, { lid: "3@lid", name: "Bia" });
    expect(r.changed).toBe(true);
    expect(r.list).toHaveLength(3);
  });

  test("sem chave: nada muda", () => {
    const r = mergeParticipantWithFlag(base, { name: "X" });
    expect(r.changed).toBe(false);
    expect(r.list).toBe(base);
  });

  test("mergeParticipant mantém o contrato (devolve a lista)", () => {
    expect(mergeParticipant(base, { lid: "1@lid", name: "Z" })[0].name).toBe("Z");
    expect(mergeParticipant(undefined, {})).toEqual([]);
  });
});
