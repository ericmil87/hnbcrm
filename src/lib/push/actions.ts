import { readPlatform } from "@/lib/pwa/platform";
import {
  addLinkedOrg,
  clearLinkedOrgs,
  getExistingSubscription,
  pushPlatformOf,
  readLinkedOrgs,
  readPushSupport,
  subscribeBrowser,
  unsubscribeBrowser,
  userAgentLabelOf,
  type PushPlatform,
} from "./subscription";

/** Chamadas ao backend (injetadas: o hook passa as mutations do Convex, os testes passam mocks). */
export interface PushBackend {
  subscribe: (args: {
    organizationId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    platform: PushPlatform;
    userAgentLabel?: string;
  }) => Promise<unknown>;
  unsubscribe: (args: { organizationId: string; endpoint: string }) => Promise<unknown>;
}

/** Assina no navegador (idempotente) e vincula à org ativa. */
export async function linkThisDevice(backend: PushBackend, organizationId: string, vapidKey: string): Promise<void> {
  const data = await subscribeBrowser(vapidKey);
  const platform = readPlatform();
  await backend.subscribe({
    organizationId,
    ...data,
    platform: pushPlatformOf(platform),
    userAgentLabel: userAgentLabelOf(navigator.userAgent, platform),
  });
  addLinkedOrg(organizationId);
}

export type EnableResult = "enabled" | "denied" | "dismissed" | "unsupported";

/** Pede a permissão (PRECISA rodar dentro de um toque) e assina. A permissão é o primeiro `await`. */
export async function enablePush(backend: PushBackend, organizationId: string, vapidKey: string): Promise<EnableResult> {
  if (readPushSupport() !== "supported") return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "dismissed";
  await linkThisDevice(backend, organizationId, vapidKey);
  return "enabled";
}

async function unlinkEverywhere(backend: PushBackend, organizationId: string, endpoint: string): Promise<void> {
  const orgs = Array.from(new Set([...readLinkedOrgs(), organizationId]));
  await Promise.allSettled(orgs.map((id) => backend.unsubscribe({ organizationId: id, endpoint })));
}

/** "Desligar": solta o vínculo em todas as orgs deste aparelho e cancela a assinatura do navegador. */
export async function disablePush(backend: PushBackend, organizationId: string): Promise<void> {
  const sub = await getExistingSubscription();
  if (sub) await unlinkEverywhere(backend, organizationId, sub.endpoint);
  await unsubscribeBrowser();
  clearLinkedOrgs();
}

/**
 * A cada abertura logada (e na troca de org): se há assinatura no navegador, vincula de novo à org ativa
 * (idempotente no servidor); se a permissão foi revogada, solta tudo e limpa o rastro local.
 */
export async function resyncPush(backend: PushBackend, organizationId: string, vapidKey: string): Promise<"synced" | "cleaned" | "idle"> {
  if (readPushSupport() !== "supported" || typeof Notification === "undefined") return "idle";
  const permission = Notification.permission;
  if (permission === "denied") {
    const sub = await getExistingSubscription();
    if (sub) {
      await unlinkEverywhere(backend, organizationId, sub.endpoint);
      await sub.unsubscribe().catch(() => false);
    }
    clearLinkedOrgs();
    return "cleaned";
  }
  if (permission === "granted" && (await getExistingSubscription())) {
    await linkThisDevice(backend, organizationId, vapidKey);
    return "synced";
  }
  return "idle";
}
