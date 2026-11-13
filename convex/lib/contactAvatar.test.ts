import { describe, expect, test, afterEach, vi } from "vitest";
import {
  AVATAR_DAILY_CAP_PER_CHANNEL,
  AVATAR_ERROR_STREAK_LIMIT,
  ENRICH_BLOCKED_FIELDS,
  avatarDayKey,
  numberChangedPerson,
  pacingAfterAvatarError,
  sanitizeEnrichFields,
  AVATAR_ERROR_BACKOFF_MS,
  AVATAR_MAX_QUEUE_MS,
  avatarGapMs,
  avatarPauseMs,
  avatarPhoneFor,
  computeNextCheckAt,
  contactAvatarFetchEnabled,
  isAvatarCheckDue,
  planAvatarSlot,
  resolveDisplayedAvatar,
  whatsappAvatarContactPatch,
} from "./contactAvatar";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterEach(() => vi.unstubAllEnvs());

describe("regra de vencimento", () => {
  test("sem linha busca; ok renova em 7 dias; hidden/none em 30", () => {
    expect(isAvatarCheckDue(null, 1000)).toBe(true);
    expect(computeNextCheckAt("ok", 0, 0)).toBe(7 * DAY);
    expect(computeNextCheckAt("hidden", 0, 0)).toBe(30 * DAY);
    expect(computeNextCheckAt("none", 0, 0)).toBe(30 * DAY);
    expect(isAvatarCheckDue({ nextCheckAt: 7 * DAY }, 7 * DAY - 1)).toBe(false);
    expect(isAvatarCheckDue({ nextCheckAt: 7 * DAY }, 7 * DAY)).toBe(true);
  });

  test("error recua 1 h, 6 h, 24 h, depois 7 dias", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => computeNextCheckAt("error", n, 0))).toEqual([
      HOUR,
      6 * HOUR,
      24 * HOUR,
      7 * DAY,
      7 * DAY,
      7 * DAY,
    ]);
    expect(AVATAR_ERROR_BACKOFF_MS).toHaveLength(4);
  });

  test("busca pendente recente (< 10 min) não agenda de novo; pendente velha sim", () => {
    expect(isAvatarCheckDue({ nextCheckAt: 0, pendingSince: 1000 }, 1000 + 9 * MIN)).toBe(false);
    expect(isAvatarCheckDue({ nextCheckAt: 0, pendingSince: 1000 }, 1000 + 10 * MIN)).toBe(true);
  });
});

describe("telefone", () => {
  test("whatsappNumber vence phone; JID e LID nunca viram telefone", () => {
    expect(avatarPhoneFor({ whatsappNumber: "5511999990000", phone: "123" })).toBe("5511999990000");
    expect(avatarPhoneFor({ phone: "+55 (11) 99999-0000" })).toBe("5511999990000");
    expect(avatarPhoneFor({ whatsappNumber: "180002129735765@lid" })).toBeNull();
    expect(avatarPhoneFor({ phone: "15550000001@s.whatsapp.net" })).toBeNull();
    expect(avatarPhoneFor({})).toBeNull();
    expect(avatarPhoneFor({ phone: "12345" })).toBeNull();
  });
});

describe("ritmo por canal", () => {
  test("intervalo de 8 a 15 s com jitter", () => {
    expect(avatarGapMs(0)).toBe(8000);
    expect(avatarGapMs(0.999999)).toBe(15000);
    expect(avatarGapMs(5)).toBe(15000);
  });

  test("duas buscas ficam espaçadas; fila acima de 10 min não agenda; pausa não agenda", () => {
    const first = planAvatarSlot(null, 1000, 0)!;
    expect(first.runAt).toBe(1000);
    const second = planAvatarSlot({ nextFetchAt: first.nextFetchAt }, 1000, 0)!;
    expect(second.runAt - first.runAt).toBeGreaterThanOrEqual(8000);
    expect(second.runAt - first.runAt).toBeLessThanOrEqual(15000);
    expect(planAvatarSlot({ nextFetchAt: 1000 + AVATAR_MAX_QUEUE_MS + 1 }, 1000, 0)).toBeNull();
    expect(planAvatarSlot({ nextFetchAt: 1000 + AVATAR_MAX_QUEUE_MS }, 1000, 0)).not.toBeNull();
    expect(planAvatarSlot({ nextFetchAt: 0, pausedUntil: 5000 }, 1000, 0)).toBeNull();
    expect(planAvatarSlot({ nextFetchAt: 0, pausedUntil: 5000 }, 5000, 0)).not.toBeNull();
  });

  test("pausa por 429: 15 min dobrando até 6 h", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(avatarPauseMs)).toEqual([
      15 * MIN,
      30 * MIN,
      60 * MIN,
      120 * MIN,
      240 * MIN,
      6 * HOUR,
      6 * HOUR,
    ]);
  });
});

describe("o que mostrar", () => {
  test("a foto manual vence a do WhatsApp", () => {
    expect(resolveDisplayedAvatar({ manualUrl: "m", whatsappUrl: "w" })).toBe("m");
    expect(resolveDisplayedAvatar({ manualUrl: null, whatsappUrl: "w" })).toBe("w");
    expect(resolveDisplayedAvatar({})).toBeUndefined();
  });

  test("o contato só é escrito quando o valor exibido muda; manual nunca é sobrescrita", () => {
    expect(whatsappAvatarContactPatch({ hasManualPhoto: true, currentAvatarUrl: "m", newWhatsappUrl: "w" })).toEqual({
      write: false,
    });
    expect(whatsappAvatarContactPatch({ hasManualPhoto: false, currentAvatarUrl: "w", newWhatsappUrl: "w" })).toEqual({
      write: false,
    });
    expect(whatsappAvatarContactPatch({ hasManualPhoto: false, currentAvatarUrl: "w1", newWhatsappUrl: "w2" })).toEqual({
      write: true,
      avatarUrl: "w2",
    });
  });
});

test("kill switch CONTACT_AVATAR_FETCH=0", () => {
  expect(contactAvatarFetchEnabled()).toBe(true);
  vi.stubEnv("CONTACT_AVATAR_FETCH", "0");
  expect(contactAvatarFetchEnabled()).toBe(false);
});

describe("teto diário e disjuntor", () => {
  test("300 por dia UTC por canal; o dia seguinte zera", () => {
    const now = Date.UTC(2026, 10, 13, 12);
    const day = avatarDayKey(now);
    expect(day).toBe("2026-11-13");
    expect(planAvatarSlot({ nextFetchAt: 0, day, dayCount: AVATAR_DAILY_CAP_PER_CHANNEL - 1 }, now, 0)).toMatchObject({
      dayCount: AVATAR_DAILY_CAP_PER_CHANNEL,
    });
    expect(planAvatarSlot({ nextFetchAt: 0, day, dayCount: AVATAR_DAILY_CAP_PER_CHANNEL }, now, 0)).toBeNull();
    expect(
      planAvatarSlot({ nextFetchAt: 0, day, dayCount: AVATAR_DAILY_CAP_PER_CHANNEL }, now + 24 * HOUR, 0)
    ).toMatchObject({ dayCount: 1, day: "2026-11-14" });
  });

  test("5 error seguidos pausam com a escada do 429", () => {
    let p: { strikes?: number; errorStreak?: number } = {};
    for (let i = 1; i < AVATAR_ERROR_STREAK_LIMIT; i++) {
      const next = pacingAfterAvatarError(p, 0);
      expect(next).toEqual({ errorStreak: i });
      p = next;
    }
    expect(pacingAfterAvatarError(p, 1000)).toEqual({ errorStreak: 0, strikes: 1, pausedUntil: 1000 + 15 * MIN });
    expect(pacingAfterAvatarError({ errorStreak: 4, strikes: 1 }, 0)).toMatchObject({ strikes: 2, pausedUntil: 30 * MIN });
  });
});

describe("sanitizeEnrichFields", () => {
  test("remove sistema, derivados e foto; mantém campos legítimos", () => {
    const { fields, dropped } = sanitizeEnrichFields({
      avatarUrl: "x",
      photoFileId: "f",
      organizationId: "o",
      _id: "i",
      _creationTime: 1,
      whatsappCheck: {},
      whatsappFails: {},
      whatsappLookup: {},
      searchText: "s",
      enrichmentMeta: {},
      $set: 1,
      city: "Curitiba",
      customFields: { a: 1 },
      linkedinUrl: "https://linkedin.com/in/x",
    });
    expect(Object.keys(fields).sort()).toEqual(["city", "customFields", "linkedinUrl"]);
    expect(dropped).toContain("avatarUrl");
    for (const key of ["avatarUrl", "photoFileId", "organizationId", "_id", "_creationTime", "whatsappCheck", "whatsappFails", "whatsappLookup", "searchText"]) {
      expect(ENRICH_BLOCKED_FIELDS.includes(key) || key.startsWith("_")).toBe(true);
    }
  });
});

describe("numberChangedPerson", () => {
  const spellings = (d: string) => (d === "5511999990001" ? ["5511999990001", "551199990001"] : [d]);
  test("mesma grafia ou outra grafia do mesmo número não conta; outra pessoa conta", () => {
    expect(numberChangedPerson({ phone: "5511999990001" }, { phone: "5511999990001" }, spellings)).toBe(false);
    expect(numberChangedPerson({ phone: "5511999990001" }, { phone: "551199990001" }, spellings)).toBe(false);
    expect(numberChangedPerson({ phone: "5511999990001" }, { phone: "5511988887777" }, spellings)).toBe(true);
    expect(numberChangedPerson({ whatsappNumber: "5511999990001", phone: "1" }, { whatsappNumber: undefined, phone: "1" }, spellings)).toBe(true);
    expect(numberChangedPerson({}, { phone: "5511988887777" }, spellings)).toBe(false);
  });
});
