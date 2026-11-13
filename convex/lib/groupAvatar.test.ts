import { describe, expect, test, vi, afterEach } from "vitest";
import {
  groupAvatarConversationPatch,
  groupAvatarEligible,
  groupAvatarStampDue,
} from "./groupAvatar";
import { otherChannelPhotoStillValid, planMetaAvatarSlot, AVATAR_DAILY_CAP_PER_CHANNEL } from "./contactAvatar";

afterEach(() => vi.unstubAllEnvs());

const group = { organizationId: "o1", monitored: true, conversationId: "c1", jid: "1203@g.us" };

describe("groupAvatarEligible", () => {
  test("só sala acompanhada, ativa, com JID de grupo e conversa não arquivada", () => {
    expect(groupAvatarEligible(group, { organizationId: "o1" })).toBe(true);
    expect(groupAvatarEligible({ ...group, monitored: false })).toBe(false);
    expect(groupAvatarEligible({ ...group, leftAt: 1 })).toBe(false);
    expect(groupAvatarEligible({ ...group, removedAt: 1 })).toBe(false);
    expect(groupAvatarEligible({ ...group, jid: "5511@s.whatsapp.net" })).toBe(false);
    expect(groupAvatarEligible(group, { organizationId: "o1", archivedAt: 5 })).toBe(false);
    expect(groupAvatarEligible(group, { organizationId: "o2" })).toBe(false);
  });
  test("kill switch", () => {
    vi.stubEnv("CONTACT_AVATAR_FETCH", "0");
    expect(groupAvatarEligible(group)).toBe(false);
  });
});

test("carimbo: ausente ou vencido é devido", () => {
  expect(groupAvatarStampDue({}, 10)).toBe(true);
  expect(groupAvatarStampDue({ avatarNextCheckAt: 0 }, 10)).toBe(true);
  expect(groupAvatarStampDue({ avatarNextCheckAt: 11 }, 10)).toBe(false);
});

test("conversa só é escrita quando a URL muda", () => {
  expect(groupAvatarConversationPatch("a", "a")).toEqual({ write: false });
  expect(groupAvatarConversationPatch(undefined, "a")).toEqual({ write: true, groupAvatarUrl: "a" });
  expect(groupAvatarConversationPatch("a", undefined)).toEqual({ write: true, groupAvatarUrl: undefined });
});

test("regra entre canais e teto da Graph", () => {
  const row = { status: "ok", url: "u", nextCheckAt: 100 };
  expect(otherChannelPhotoStillValid(row, "messenger", 50)).toBe(true); // WhatsApp (sem source) válida
  expect(otherChannelPhotoStillValid(row, "messenger", 100)).toBe(false); // vencida
  expect(otherChannelPhotoStillValid({ ...row, source: "messenger" }, "messenger", 50)).toBe(false); // mesmo canal
  expect(otherChannelPhotoStillValid({ ...row, status: "none" }, "instagram", 50)).toBe(false);
  const day = new Date(1_000_000).toISOString().slice(0, 10);
  expect(planMetaAvatarSlot({ nextFetchAt: 0, day, dayCount: AVATAR_DAILY_CAP_PER_CHANNEL }, 1_000_000)).toBeNull();
  expect(planMetaAvatarSlot({ nextFetchAt: 0, pausedUntil: 2_000_000 }, 1_000_000)).toBeNull();
  expect(planMetaAvatarSlot(null, 1_000_000)).toMatchObject({ dayCount: 1 });
});
