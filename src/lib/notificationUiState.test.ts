import { beforeEach, describe, expect, it } from "vitest";
import {
  INVITE_QUIET_MS,
  INVITE_RETRY_MS,
  getNotificationUiState,
  inviteWaitMs,
  markArrivalToast,
  resetNotificationUiState,
  setBellOpen,
  shouldAnnounceArrival,
} from "./notificationUiState";

beforeEach(resetNotificationUiState);

describe("shouldAnnounceArrival", () => {
  it("cala com pausa ou painel aberto", () => {
    expect(shouldAnnounceArrival({ paused: false, suppressed: false })).toBe(true);
    expect(shouldAnnounceArrival({ paused: true, suppressed: false })).toBe(false);
    expect(shouldAnnounceArrival({ paused: false, suppressed: true })).toBe(false);
  });
});

describe("inviteWaitMs", () => {
  it("sem chegada recente convida já", () => {
    expect(inviteWaitMs({ bellOpen: false, paused: false, lastArrivalAt: null, now: 1000 })).toBe(0);
    expect(inviteWaitMs({ bellOpen: false, paused: false, lastArrivalAt: 0, now: INVITE_QUIET_MS })).toBe(0);
  });
  it("espera o silêncio depois da última chegada", () => {
    expect(inviteWaitMs({ bellOpen: false, paused: false, lastArrivalAt: 1000, now: 3000 })).toBe(INVITE_QUIET_MS - 2000);
  });
  it("nunca com o sino aberto nem com pausa", () => {
    expect(inviteWaitMs({ bellOpen: true, paused: false, lastArrivalAt: null, now: 1 })).toBe(INVITE_RETRY_MS);
    expect(inviteWaitMs({ bellOpen: false, paused: true, lastArrivalAt: null, now: 1 })).toBe(INVITE_RETRY_MS);
  });
});

describe("estado", () => {
  it("guarda sino aberto e hora do último toast", () => {
    setBellOpen(true);
    markArrivalToast(5);
    expect(getNotificationUiState()).toMatchObject({ bellOpen: true, lastArrivalAt: 5 });
  });
});
