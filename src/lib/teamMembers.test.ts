import { describe, expect, it } from "vitest";
import { assignableMembers, isPendingMember, memberLabel } from "./teamMembers";

const members = [
  { _id: "a", name: "Ana" },
  { _id: "b", name: "Bia", removed: true },
  { _id: "c", name: "Caio", removed: false },
];

describe("assignableMembers", () => {
  it("tira removidos das opções", () => {
    expect(assignableMembers(members).map((m) => m._id)).toEqual(["a", "c"]);
  });

  it("mantém o removido que já está selecionado", () => {
    expect(assignableMembers(members, ["b", null]).map((m) => m._id)).toEqual(["a", "b", "c"]);
  });

  it("aceita lista ainda carregando", () => {
    expect(assignableMembers(undefined)).toEqual([]);
  });
});

describe("memberLabel", () => {
  it("marca quem saiu da org", () => {
    expect(memberLabel(members[1])).toBe("Bia (removido)");
    expect(memberLabel(members[0])).toBe("Ana");
  });
});

describe("isPendingMember", () => {
  it("humano sem conta e não removido é convite pendente", () => {
    expect(isPendingMember({ type: "human" })).toBe(true);
    expect(isPendingMember({ type: "human", userId: "u1" })).toBe(false);
    expect(isPendingMember({ type: "human", removed: true })).toBe(false);
    expect(isPendingMember({ type: "ai" })).toBe(false);
  });

  it("respeita o campo do servidor quando existe", () => {
    expect(isPendingMember({ type: "human", userId: "u1", pending: true })).toBe(true);
  });
});
