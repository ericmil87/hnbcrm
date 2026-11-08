import { ConvexError } from "convex/values";
import { readPlatform } from "@/lib/pwa/platform";
import {
  addLinkedOrg,
  clearLinkedOrgs,
  getExistingSubscription,
  pushPlatformOf,
  readLinkedEndpoint,
  readLinkedOrgs,
  readPushOwner,
  readPushSupport,
  removeLinkedOrg,
  subscribeBrowser,
  unsubscribeBrowser,
  userAgentLabelOf,
  writeLinkedEndpoint,
  writePushOwner,
  type PushPlatform,
  type SerializedSubscription,
} from "./subscription";

/** Chamadas ao backend (injetadas: o hook passa o Convex, os testes passam mocks). */
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
  getMyDevices: (args: { organizationId: string; currentEndpoint: string }) => Promise<readonly { isCurrent: boolean; linkedHere: boolean }[]>;
}

async function subscribeOrg(backend: PushBackend, organizationId: string, data: SerializedSubscription): Promise<void> {
  const platform = readPlatform();
  await backend.subscribe({
    organizationId,
    ...data,
    platform: pushPlatformOf(platform),
    userAgentLabel: userAgentLabelOf(navigator.userAgent, platform),
  });
}

/**
 * Assina no navegador (idempotente) e vincula à org ativa. Se o servidor recusar o vínculo
 * (ConvexError) e o aparelho não tem outra org vinculada, cancela a assinatura do navegador
 * antes de relançar: o cartão nunca diz "ligados" sem vínculo.
 */
export async function linkThisDevice(backend: PushBackend, organizationId: string, vapidKey: string, userId: string): Promise<void> {
  const data = await subscribeBrowser(vapidKey);
  try {
    await subscribeOrg(backend, organizationId, data);
  } catch (e) {
    if (e instanceof ConvexError && readLinkedOrgs().filter((o) => o !== organizationId).length === 0) {
      await unsubscribeBrowser().catch(() => null);
      clearLinkedOrgs();
    }
    throw e;
  }
  addLinkedOrg(organizationId);
  writePushOwner(userId);
  writeLinkedEndpoint(data.endpoint);
}

export type EnableResult = "enabled" | "denied" | "dismissed" | "unsupported";

/** Pede a permissão (PRECISA rodar dentro de um toque) e assina. A permissão é o primeiro `await`. */
export async function enablePush(backend: PushBackend, organizationId: string, vapidKey: string, userId: string): Promise<EnableResult> {
  if (readPushSupport() !== "supported") return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "dismissed";
  await linkThisDevice(backend, organizationId, vapidKey, userId);
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

export type ResyncResult = "synced" | "cleaned" | "foreign" | "removed" | "idle";

/**
 * A cada abertura logada (e na troca de org / `hnb:push-resubscribed`):
 *  - permissão revogada: solta tudo e limpa o rastro;
 *  - assinatura de OUTRA pessoa (dono diferente, ou sem dono e sem orgs vinculadas): cancela no navegador
 *    e NÃO re-vincula (a pessoa nova ativa por gesto);
 *  - aparelho removido em "Meus aparelhos" (o endpoint vinculado é o atual e o servidor não o conhece mais):
 *    cancela no navegador, sem pedir permissão;
 *  - senão vincula de novo (idempotente) todas as orgs vinculadas + a ativa.
 */
export async function resyncPush(backend: PushBackend, organizationId: string, vapidKey: string, userId: string): Promise<ResyncResult> {
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
  if (permission !== "granted") return "idle";
  const sub = await getExistingSubscription();
  if (!sub) return "idle";

  const linked = readLinkedOrgs();
  const owner = readPushOwner();
  if ((owner && owner !== userId) || (!owner && linked.length === 0)) {
    await sub.unsubscribe().catch(() => false);
    clearLinkedOrgs();
    return "foreign";
  }

  // Só é "removido" o MESMO endpoint que vinculamos e que o servidor não conhece mais; endpoint diferente
  // é rotação da assinatura (`pushsubscriptionchange`) e segue para o re-vínculo.
  if (linked.includes(organizationId) && sub.endpoint === readLinkedEndpoint()) {
    let known = true;
    try {
      const devices = await backend.getMyDevices({ organizationId, currentEndpoint: sub.endpoint });
      known = devices.some((d) => d.isCurrent);
    } catch {
      /* sem resposta: não trata como removido */
    }
    if (!known) {
      await sub.unsubscribe().catch(() => false);
      clearLinkedOrgs();
      return "removed";
    }
  }

  const data = await subscribeBrowser(vapidKey);
  const orgs = Array.from(new Set([...linked, organizationId]));
  const results = await Promise.allSettled(orgs.map((id) => subscribeOrg(backend, id, data)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") addLinkedOrg(orgs[i]);
    else if (r.reason instanceof ConvexError) removeLinkedOrg(orgs[i]);
  });
  if (readLinkedOrgs().length > 0) {
    writePushOwner(userId);
    writeLinkedEndpoint(data.endpoint);
  }
  return "synced";
}
