import { describe, expect, it } from "vitest";
import { TRIAL } from "../../../convex/lib/plans";
import { ACTOR_LABEL, DAY_IN_THE_LIFE } from "./dayInTheLife";
import {
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
    expect(itemsOfKind(prod, "fato")).toHaveLength(4);
  });

  it("em desenvolvimento mostra também os exemplos, todos com selo", () => {
    const dev = visibleSocialProof(SOCIAL_PROOF, false);
    expect(dev).toHaveLength(SOCIAL_PROOF.length);
    for (const i of dev.filter((x) => !x.real)) expect(needsExampleBadge(i)).toBe(true);
  });

  it("fato real não leva selo; os dias de teste vêm de TRIAL", () => {
    for (const f of itemsOfKind(SOCIAL_PROOF, "fato")) expect(needsExampleBadge(f)).toBe(false);
    expect(itemsOfKind(SOCIAL_PROOF, "fato").some((f) => f.title.includes(String(TRIAL.days)))).toBe(true);
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
    expect(socialProofTitle(visibleSocialProof(SOCIAL_PROOF, true))).toBe("Um dia com o HNBCRM");
  });
});

describe("dayInTheLife", () => {
  it("cinco momentos com horário válido, em ordem, e autor conhecido", () => {
    expect(DAY_IN_THE_LIFE).toHaveLength(5);
    const times = DAY_IN_THE_LIFE.map((m) => m.time);
    for (const t of times) expect(t).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect([...times].sort()).toEqual(times);
    for (const m of DAY_IN_THE_LIFE) expect(ACTOR_LABEL[m.actor]).toBeTruthy();
  });

  it("a IA nunca confirma pagamento sozinha", () => {
    const pix = DAY_IN_THE_LIFE.find((m) => m.id === "comprovante-pix");
    expect(pix?.actor).toBe("ia-equipe");
    expect(pix?.text).toMatch(/nunca a IA/);
  });
});
