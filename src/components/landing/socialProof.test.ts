import { describe, expect, it } from "vitest";
import {
  INBOX_CHANNELS,
  SOCIAL_PROOF,
  itemsOfKind,
  needsExampleBadge,
  socialProofTitle,
  visibleSocialProof,
  type SocialProofItem,
} from "./socialProof";

describe("socialProof", () => {
  it("em produção só itens reais: nenhum depoimento nem logo hoje", () => {
    const prod = visibleSocialProof(SOCIAL_PROOF, true);
    expect(prod.every((i) => i.real)).toBe(true);
    expect(itemsOfKind(prod, "depoimento")).toHaveLength(0);
    expect(itemsOfKind(prod, "logo")).toHaveLength(0);
    expect(itemsOfKind(prod, "cena")).toHaveLength(3);
    expect(itemsOfKind(prod, "numero").length).toBeGreaterThan(0);
  });

  it("em desenvolvimento mostra também os exemplos, todos com selo", () => {
    const dev = visibleSocialProof(SOCIAL_PROOF, false);
    expect(dev).toHaveLength(SOCIAL_PROOF.length);
    for (const i of dev.filter((x) => !x.real)) expect(needsExampleBadge(i)).toBe(true);
  });

  it("cena ilustrativa leva o selo mesmo sendo real; número real não leva", () => {
    for (const c of itemsOfKind(SOCIAL_PROOF, "cena")) expect(needsExampleBadge(c)).toBe(true);
    for (const n of itemsOfKind(SOCIAL_PROOF, "numero")) expect(needsExampleBadge(n)).toBe(false);
  });

  it("depoimento real aparece em produção sem selo e muda o título", () => {
    const real: SocialProofItem = {
      kind: "depoimento",
      id: "d",
      real: true,
      quote: "q",
      name: "n",
      business: "b",
    };
    expect(visibleSocialProof([real], true)).toEqual([real]);
    expect(needsExampleBadge(real)).toBe(false);
    expect(socialProofTitle([real])).toBe("O que dizem quem já usa");
    expect(socialProofTitle(visibleSocialProof(SOCIAL_PROOF, true))).toBe("Como é usar no dia a dia");
  });

  it("o número de canais sai da lista de canais", () => {
    const n = itemsOfKind(SOCIAL_PROOF, "numero").find((i) => i.id === "num-canais");
    expect(n?.value).toBe(String(INBOX_CHANNELS.length));
  });
});
