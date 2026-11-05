import { describe, expect, it } from "vitest";
import { deriveOnboardingStatus, type OnboardingSnapshot } from "./onboardingStatus";

const EMPTY: OnboardingSnapshot = {
  hasBusinessOffer: false,
  legacyWizardCompleted: false,
  whatsappConnected: false,
  hasBridgeChannel: false,
  bridgeAiAckDone: false,
  hasAttendant: false,
  aiActive: false,
  extrasEnabled: false,
  humanMemberCount: 1,
  firstAiReplyDone: false,
  saved: {},
};

describe("deriveOnboardingStatus", () => {
  it("funil pulado vira skipped e o próximo passo avança; funil aplicado vence", () => {
    const base = { ...EMPTY, hasBusinessOffer: true };
    const skipped = deriveOnboardingStatus({ ...base, saved: { funnel: "skipped" } });
    expect(skipped.steps.funnel).toBe("skipped");
    expect(skipped.nextStep).toBe("whatsapp");
    const legacy = deriveOnboardingStatus({
      ...base,
      legacyWizardCompleted: true,
      saved: { funnel: "skipped" },
    });
    expect(legacy.steps.funnel).toBe("done");
    expect(deriveOnboardingStatus({ ...base, saved: { funnel: "done" } }).steps.funnel).toBe("done");
  });

  it("deriveOnboardingStatus escolhe o próximo passo", () => {
    expect(deriveOnboardingStatus(EMPTY).nextStep).toBe("business");
    const r = deriveOnboardingStatus({
      ...EMPTY,
      hasBusinessOffer: true,
      saved: { funnel: "done", whatsapp: "skipped" },
    });
    expect(r.steps.funnel).toBe("done");
    expect(r.steps.whatsapp).toBe("skipped");
    expect(r.nextStep).toBe("attendant");
    const all = deriveOnboardingStatus({
      ...EMPTY,
      hasBusinessOffer: true,
      legacyWizardCompleted: true,
      whatsappConnected: true,
      hasAttendant: true,
      aiActive: true,
      extrasEnabled: true,
      humanMemberCount: 2,
      saved: { test: "done" },
    });
    expect(all.nextStep).toBeNull();
  });

  it("atendente sem IA ativa não conta como feito e o aceite bridge depende do canal", () => {
    const r = deriveOnboardingStatus({ ...EMPTY, hasAttendant: true, hasBridgeChannel: true });
    expect(r.steps.attendant).toBe("pending");
    expect(r.bridgeAckPending).toBe(true);
    expect(deriveOnboardingStatus({ ...EMPTY, hasAttendant: true }).bridgeAckPending).toBe(false);
  });

  it("org legada conta business e test como feitos; org v2 não", () => {
    const legacy = deriveOnboardingStatus({ ...EMPTY, legacyOrg: true, legacyWizardCompleted: true });
    expect(legacy.steps.business).toBe("done");
    expect(legacy.steps.test).toBe("done");
    const v2 = deriveOnboardingStatus({ ...EMPTY, legacyOrg: false, legacyWizardCompleted: true });
    expect(v2.steps.business).toBe("pending");
    expect(v2.steps.test).toBe("pending");
  });
});
