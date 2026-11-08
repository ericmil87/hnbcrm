import { isIosSafari, readPlatform, readStandalone, type InstallPlatform } from "@/lib/pwa/platform";

/** Plataforma gravada na assinatura (espelha `platformValidator` de convex/push.ts). */
export type PushPlatform = "android" | "ios" | "desktop" | "other";

export function pushPlatformOf(platform: InstallPlatform): PushPlatform {
  return platform;
}

export type PushSupport = "supported" | "needs-install" | "unsupported";

export interface PushSupportInput {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  platform: InstallPlatform;
  standalone: boolean;
}

/**
 * iPhone/iPad só recebe push com o app na Tela de Início (16.4+): fora dela a API nem existe,
 * então "sem PushManager" no iOS não instalado vale como "instale o app", não como "sem suporte".
 */
export function pushSupportOf(i: PushSupportInput): PushSupport {
  if (i.platform === "ios" && !i.standalone) return "needs-install";
  if (!i.hasServiceWorker || !i.hasPushManager || !i.hasNotification) return "unsupported";
  return "supported";
}

export function readPushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  return pushSupportOf({
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    platform: readPlatform(),
    standalone: readStandalone(),
  });
}

export type PushStatus = "loading" | "unsupported" | "needs-install" | "default" | "subscribed" | "denied" | "error";

export interface PushStatusInput {
  support: PushSupport;
  permission: NotificationPermission | "unavailable";
  hasSubscription: boolean;
}

export function pushStatusOf({ support, permission, hasSubscription }: PushStatusInput): Exclude<PushStatus, "loading" | "error"> {
  if (support === "needs-install") return "needs-install";
  if (support === "unsupported") return "unsupported";
  if (permission === "denied") return "denied";
  if (permission === "granted" && hasSubscription) return "subscribed";
  return "default";
}

/**
 * "Ligado" só vale se o servidor também conhece este aparelho nesta org. `devices` indefinido
 * (consulta carregando ou pulada) não muda o estado; carregado e sem `isCurrent && linkedHere`, volta a "default".
 */
export function pushStatusWithServer(status: PushStatus, devices: readonly { isCurrent: boolean; linkedHere: boolean }[] | undefined): PushStatus {
  if (status !== "subscribed" || devices === undefined) return status;
  return devices.some((d) => d.isCurrent && d.linkedHere) ? "subscribed" : "default";
}

/** Como reabrir a permissão bloqueada, por plataforma. */
export function blockedHelp(platform: InstallPlatform, userAgent = ""): string {
  if (platform === "ios") return "No iPhone, abra Ajustes › Notificações › HNBCRM e ative Permitir notificações.";
  if (platform === "android") return "No Chrome, toque no cadeado ao lado do endereço › Permissões › Notificações e escolha Permitir.";
  if (/Firefox/i.test(userAgent)) return "Clique no cadeado na barra de endereço, remova o bloqueio de Notificações e recarregue a página.";
  return "Clique no ícone na barra de endereço (cadeado ou ajustes), em Notificações escolha Permitir e recarregue a página.";
}

/** Nome amigável do aparelho para "Meus aparelhos" (sem versão nem dado pessoal). */
export function userAgentLabelOf(userAgent: string, platform: InstallPlatform): string {
  let browser = "Navegador";
  if (/Edg\/|EdgA\/|EdgiOS/i.test(userAgent)) browser = "Edge";
  else if (/OPR\/|OPiOS/i.test(userAgent)) browser = "Opera";
  else if (/SamsungBrowser/i.test(userAgent)) browser = "Samsung Internet";
  else if (/Firefox|FxiOS/i.test(userAgent)) browser = "Firefox";
  else if (/Chrome|CriOS/i.test(userAgent)) browser = "Chrome";
  else if (isIosSafari(userAgent) || /Safari\//i.test(userAgent)) browser = "Safari";
  const where =
    platform === "ios"
      ? "iPhone"
      : platform === "android"
        ? "Android"
        : /Windows/i.test(userAgent)
          ? "Windows"
          : /Macintosh/i.test(userAgent)
            ? "Mac"
            : /Linux/i.test(userAgent)
              ? "Linux"
              : "computador";
  return `${browser} no ${where}`;
}

/** Nome mostrado na lista: o rótulo salvo, ou um nome genérico pela plataforma. */
export function deviceDisplayName(d: { userAgentLabel: string | null; platform: PushPlatform }): string {
  if (d.userAgentLabel) return d.userAgentLabel;
  return { android: "Celular Android", ios: "iPhone ou iPad", desktop: "Computador", other: "Outro aparelho" }[d.platform];
}

export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bufferToBase64Url(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SerializedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** `endpoint` + chaves em base64url (o formato que o backend e o web-push esperam). */
export function serializeSubscription(sub: PushSubscription): SerializedSubscription | null {
  const json = typeof sub.toJSON === "function" ? sub.toJSON() : undefined;
  const p256dh = json?.keys?.p256dh ?? bufferToBase64Url(sub.getKey?.("p256dh"));
  const auth = json?.keys?.auth ?? bufferToBase64Url(sub.getKey?.("auth"));
  if (!sub.endpoint || !p256dh || !auth) return null;
  return { endpoint: sub.endpoint, p256dh, auth };
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

const READY_TIMEOUT_MS = 4000;

/** Registro do SW ativo (ou `null` sem SW/em dev/depois do tempo). Nunca rejeita. */
export async function getPushRegistration(timeoutMs = READY_TIMEOUT_MS): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    // Sem registro (dev, SW desligado): `ready` nunca resolveria; não faz o logout esperar à toa.
    if (typeof navigator.serviceWorker.getRegistration === "function" && !(await navigator.serviceWorker.getRegistration())) return null;
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  const reg = await getPushRegistration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Assina o aparelho (`userVisibleOnly`). Se já existe uma assinatura de outra chave VAPID
 * (par trocado), cancela e assina de novo.
 */
export async function subscribeBrowser(vapidPublicKey: string): Promise<SerializedSubscription> {
  const reg = await getPushRegistration(8000);
  if (!reg) throw new Error("O app ainda não está pronto para avisos. Recarregue a página e tente de novo.");
  const key = urlBase64ToUint8Array(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const data = serializeSubscription(sub);
  if (!data) throw new Error("O navegador não devolveu uma assinatura válida.");
  return data;
}

export async function unsubscribeBrowser(): Promise<string | null> {
  const sub = await getExistingSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  return endpoint;
}

// ----- organizações vinculadas por este aparelho (para o logout) -----

const LINKED_ORGS_KEY = "hnbcrm.push.linkedOrgs";

export function readLinkedOrgs(): string[] {
  try {
    const raw = localStorage.getItem(LINKED_ORGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function addLinkedOrg(orgId: string): void {
  try {
    const list = readLinkedOrgs();
    if (!list.includes(orgId)) localStorage.setItem(LINKED_ORGS_KEY, JSON.stringify([...list, orgId]));
  } catch {
    /* sem localStorage: o logout só tenta a org ativa */
  }
}

export function removeLinkedOrg(orgId: string): void {
  try {
    localStorage.setItem(LINKED_ORGS_KEY, JSON.stringify(readLinkedOrgs().filter((o) => o !== orgId)));
  } catch {
    /* ignore */
  }
}

const OWNER_KEY = "hnbcrm.push.owner";

/** Dono (userId) da assinatura deste navegador: outra pessoa logada não herda o aparelho. */
export function readPushOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

export function writePushOwner(userId: string): void {
  try {
    localStorage.setItem(OWNER_KEY, userId);
  } catch {
    /* ignore */
  }
}

/** Esquece orgs vinculadas e dono. */
export function clearLinkedOrgs(): void {
  try {
    localStorage.removeItem(OWNER_KEY);
    localStorage.removeItem(LINKED_ORGS_KEY);
  } catch {
    /* ignore */
  }
}

export interface PushLogoutDeps {
  unsubscribe: (args: { organizationId: string; endpoint: string }) => Promise<unknown>;
  /** Orgs extras a desvincular (a ativa, se ainda não estiver na lista guardada). */
  extraOrgIds?: readonly string[];
  timeoutMs?: number;
}

/**
 * Antes de sair da conta: desvincula o endpoint de cada org e cancela a assinatura no
 * navegador, para a próxima pessoa neste navegador não receber os avisos da anterior.
 * Melhor esforço com prazo curto: nunca rejeita nem atrasa o logout além de `timeoutMs`.
 */
export async function teardownPushOnLogout({ unsubscribe, extraOrgIds = [], timeoutMs = 2500 }: PushLogoutDeps): Promise<void> {
  const run = async () => {
    const sub = await getExistingSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    const orgs = Array.from(new Set([...readLinkedOrgs(), ...extraOrgIds]));
    // Navegador primeiro (em paralelo com o backend): mesmo que o servidor demore, a assinatura já saiu.
    const browser = sub.unsubscribe().catch(() => false);
    await Promise.allSettled([browser, ...orgs.map((organizationId) => unsubscribe({ organizationId, endpoint }))]);
  };
  try {
    await Promise.race([run(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  } catch {
    /* melhor esforço */
  } finally {
    clearLinkedOrgs();
  }
}
