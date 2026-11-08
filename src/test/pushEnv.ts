import { vi } from "vitest";

export interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
}

export function makeSub(endpoint = "https://fcm.googleapis.com/fcm/send/abc", keys = { p256dh: "BPkey_-", auth: "authKey_-" }): FakeSub {
  return {
    endpoint,
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint, keys }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

interface EnvOptions {
  permission?: NotificationPermission;
  subscription?: FakeSub | null;
  requestResult?: NotificationPermission;
  shown?: { data: unknown; close: () => void }[];
}

/** Instala Notification, PushManager e serviceWorker falsos no jsdom. */
export function installPushEnv(opts: EnvOptions = {}) {
  let current: FakeSub | null = opts.subscription ?? null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      current = makeSub();
      return current;
    }),
  };
  const registration = { pushManager, getNotifications: vi.fn(async () => opts.shown ?? []) };
  const swListeners: ((e: MessageEvent) => void)[] = [];
  const serviceWorker = {
    ready: Promise.resolve(registration),
    getRegistration: vi.fn(async () => registration),
    addEventListener: (_t: string, fn: (e: MessageEvent) => void) => swListeners.push(fn),
    removeEventListener: vi.fn(),
  };
  const NotificationMock = {
    permission: (opts.permission ?? "default") as NotificationPermission,
    requestPermission: vi.fn(async () => {
      NotificationMock.permission = opts.requestResult ?? "granted";
      return NotificationMock.permission;
    }),
  };
  Object.defineProperty(navigator, "serviceWorker", { value: serviceWorker, configurable: true });
  Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
  Object.defineProperty(window, "Notification", { value: NotificationMock, configurable: true });
  Object.defineProperty(globalThis, "Notification", { value: NotificationMock, configurable: true });
  return {
    pushManager,
    registration,
    serviceWorker,
    Notification: NotificationMock,
    emit: (data: unknown) => swListeners.forEach((fn) => fn({ data } as MessageEvent)),
    current: () => current,
  };
}

export function uninstallPushEnv() {
  const w = window as unknown as Record<string, unknown>;
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  delete w.PushManager;
  delete w.Notification;
  delete (globalThis as unknown as Record<string, unknown>).Notification;
}
