/**
 * E1 — parte pura do push: paridade tipo → template, payload (golden, sem PII),
 * tag/Topic, classificação de resposta, reenvio, validação da assinatura.
 */
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  IGNORED_FOR_PUSH,
  PUSH_TEMPLATES,
  buildPushPayload,
  carriedRenotifyState,
  classifyPushStatus,
  cleanUserAgentLabel,
  hasPushTemplate,
  isAllowedPushEndpoint,
  isValidSubscriptionKeys,
  nextRenotifyState,
  parseRetryAfter,
  pushRequestOptions,
  pushTagOf,
  pushTargetPath,
  pushTopicOf,
  renotifyOf,
  retryDelayMs,
  statsShardOf,
  PUSH_RENOTIFY_MS,
  type PushNotificationInput,
} from "./webPush";
import { ACTIONABLE_TYPES } from "./notificationPolicy";
import { safetyNetDelayMs } from "./notificationChannels";
import type { NotificationType } from "./notify";

const schemaTypes = (schema.tables.notifications.validator as any).fields.type.members.map((m: any) => m.value) as NotificationType[];

describe("paridade tipo → template de push", () => {
  test("todo tipo do schema tem template OU está em IGNORED_FOR_PUSH (nunca os dois)", () => {
    for (const type of schemaTypes) {
      const hasTemplate = PUSH_TEMPLATES[type] !== undefined;
      const ignored = IGNORED_FOR_PUSH.has(type);
      expect(hasTemplate !== ignored, `tipo ${type}`).toBe(true);
    }
    const known = new Set(schemaTypes);
    for (const t of [...Object.keys(PUSH_TEMPLATES), ...IGNORED_FOR_PUSH]) expect(known.has(t as NotificationType), t).toBe(true);
  });

  test("D1: push só para acionável; lead atribuído e informativos ficam fora", () => {
    for (const type of schemaTypes) {
      if (hasPushTemplate(type)) expect(ACTIONABLE_TYPES, type).toContain(type);
    }
    expect(hasPushTemplate("lead_assigned")).toBe(false);
    expect(hasPushTemplate("campaign_completed")).toBe(false);
    expect(hasPushTemplate("handoff_resolved")).toBe(false);
  });

  test("urgência e TTL: atendimento high/4 h, tarefas normal/24 h", () => {
    expect(pushRequestOptions("handoff_requested", "repasse:x")).toMatchObject({ urgency: "high", ttlSeconds: 4 * 3600 });
    expect(pushRequestOptions("new_message", "conversa:x")).toMatchObject({ urgency: "high", ttlSeconds: 4 * 3600 });
    expect(pushRequestOptions("task_assigned", "tarefa:x")).toMatchObject({ urgency: "normal", ttlSeconds: 24 * 3600 });
    expect(pushRequestOptions("campaign_paused", "aviso:x")).toBeNull();
  });
});

const base: PushNotificationInput = {
  _id: "n1",
  type: "new_message",
  title: "2 mensagens novas de Ana Souza",
  body: "Oi, meu número é +55 81 99999-1234 e o e-mail ana@exemplo.com.br, veja https://x.convex.cloud/api/storage/abc",
  organizationId: "org1",
  conversationId: "conv1",
};

describe("payload", () => {
  test("golden: Declarative Web Push + campos do SW, sem telefone/e-mail/link", () => {
    const p = buildPushPayload({ notification: base, appBaseUrl: "https://hnbcrm.com/", showPreview: true, badge: 3, renotify: true });
    expect(p).toEqual({
      web_push: 8030,
      notification: {
        title: "2 mensagens novas de Ana Souza",
        body: "Oi, meu número é [telefone] e o e-mail [e-mail] veja [link]",
        navigate: "https://hnbcrm.com/app/abrir?org=org1&to=%2Fapp%2Fentrada%3Fconversation%3Dconv1",
        lang: "pt-BR",
        dir: "auto",
        tag: "conversa:conv1",
        silent: false,
        renotify: true,
        app_badge: 3,
      },
      hnb: {
        v: 1,
        type: "new_message",
        notificationId: "n1",
        organizationId: "org1",
        url: "/app/abrir?org=org1&to=%2Fapp%2Fentrada%3Fconversation%3Dconv1",
        path: "/app/entrada?conversation=conv1",
        tag: "conversa:conv1",
        renotify: true,
        badge: 3,
      },
    });
    const raw = JSON.stringify(p);
    expect(raw).not.toMatch(/99999|ana@|convex\.cloud|storage/);
  });

  test("sem prévia (membro/org/413): sem corpo, título continua dizendo quem", () => {
    const p = buildPushPayload({ notification: base, appBaseUrl: "https://hnbcrm.com", showPreview: false, renotify: false });
    expect(p.notification.body).toBeUndefined();
    expect(p.notification.title).toBe("2 mensagens novas de Ana Souza");
    expect(p.hnb.renotify).toBe(false);
    expect(p.notification.renotify).toBe(false);
    expect(p.notification.app_badge).toBeUndefined();
  });

  test("multi-org põe o nome da org no título; badge com teto", () => {
    const p = buildPushPayload({ notification: base, appBaseUrl: "https://hnbcrm.com", showPreview: true, orgLabel: "Casa Lumiar", badge: 999, renotify: true });
    expect(p.notification.title).toBe("Casa Lumiar · 2 mensagens novas de Ana Souza");
    expect(p.notification.app_badge).toBe(20);
  });

  test("pedido de ajuda: tag do repasse e ações Assumir/Abrir", () => {
    const p = buildPushPayload({
      notification: { ...base, type: "handoff_requested", title: "A IA pediu ajuda: Ana", body: "Cliente pediu humano", handoffId: "h1" },
      appBaseUrl: "https://hnbcrm.com",
      showPreview: true,
      renotify: true,
    });
    expect(p.notification.tag).toBe("repasse:h1");
    expect(p.hnb.path).toBe("/app/repasses?handoff=h1");
    expect(p.hnb.actions?.map((a) => a.action)).toEqual(["assumir", "abrir"]);
    expect(p.hnb.actions?.[0].url).toContain("acao=assumir");
  });

  test("destinos e tags por tipo", () => {
    expect(pushTargetPath({ ...base, type: "task_assigned", conversationId: undefined, taskId: "t1" })).toBe("/app/tarefas?task=t1");
    expect(pushTagOf({ ...base, type: "task_due_soon", taskId: "t1" })).toBe("tarefa:t1");
    expect(pushTargetPath({ ...base, type: "channel_session_lost", conversationId: undefined, metaConnectionId: "m1" })).toBe(
      "/app/configuracoes?secao=instagram"
    );
    expect(pushTagOf({ ...base, type: "channel_session_lost", conversationId: undefined, channelConfigId: "c9" })).toBe("canal:c9");
    expect(pushTargetPath({ ...base, type: "group_mention", conversationId: undefined })).toBe("/app/grupos");
  });

  test("Topic: ≤ 32 chars do alfabeto base64url", () => {
    const topic = pushTopicOf("conversa:jd7abc123def456ghi789jkl012mno345pq;x");
    expect(topic.length).toBeLessThanOrEqual(32);
    expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pushTopicOf("repasse:h1")).toBe("r-h1");
  });
});

describe("renotify (1ª vez ou a cada 5 min)", () => {
  test("estado do agrupamento", () => {
    const t0 = 1_000_000;
    const first = nextRenotifyState(undefined, t0);
    expect(first).toEqual({ pushRenotify: true, pushRenotifyAt: t0 });
    const soon = nextRenotifyState(first, t0 + 60_000);
    expect(soon).toEqual({ pushRenotify: false, pushRenotifyAt: t0 });
    const later = nextRenotifyState(soon, t0 + PUSH_RENOTIFY_MS);
    expect(later).toEqual({ pushRenotify: true, pushRenotifyAt: t0 + PUSH_RENOTIFY_MS });
    expect(carriedRenotifyState(soon)).toEqual(soon);
    expect(carriedRenotifyState(undefined)).toEqual({});
    expect(renotifyOf(undefined)).toBe(true);
    expect(renotifyOf({ pushRenotify: false })).toBe(false);
  });
});

describe("resposta do serviço e reenvio", () => {
  test("classificação", () => {
    expect(classifyPushStatus(201)).toBe("sent");
    expect(classifyPushStatus(404)).toBe("gone");
    expect(classifyPushStatus(410)).toBe("gone");
    expect(classifyPushStatus(413)).toBe("too_large");
    expect(classifyPushStatus(429)).toBe("retry");
    expect(classifyPushStatus(503)).toBe("retry");
    expect(classifyPushStatus(403)).toBe("failed");
    expect(classifyPushStatus(400)).toBe("failed");
  });

  test("backoff ≤ 3 tentativas, Retry-After respeitado com teto", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBeNull();
    expect(retryDelayMs(1, 90_000)).toBe(90_000);
    expect(parseRetryAfter("120", 0)).toBe(120_000);
    expect(parseRetryAfter("99999", 0)).toBe(30 * 60_000);
    expect(parseRetryAfter("lixo", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  test("fragmento estável 0–7", () => {
    const s = statsShardOf("abc");
    expect(s).toBe(statsShardOf("abc"));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(8);
  });
});

describe("assinatura vinda do navegador", () => {
  test("endpoint: só serviços de push conhecidos, https, sem porta/credencial", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-bl2p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isAllowedPushEndpoint("https://evil.example.com/fcm.googleapis.com")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/x?a=b@c")).toBe(true);
    expect(isAllowedPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isAllowedPushEndpoint("não é url")).toBe(false);
  });

  test("chaves p256dh/auth em base64url com tamanho plausível", () => {
    const p256dh = "B" + "a".repeat(86);
    expect(isValidSubscriptionKeys(p256dh, "a".repeat(22))).toBe(true);
    expect(isValidSubscriptionKeys("curta", "a".repeat(22))).toBe(false);
    expect(isValidSubscriptionKeys(p256dh, "a b")).toBe(false);
  });

  test("rótulo do aparelho: curto e sem PII", () => {
    expect(cleanUserAgentLabel("Chrome no Android")).toBe("Chrome no Android");
    expect(cleanUserAgentLabel("<b>ana@x.com</b>")).toBe("b [e-mail] /b");
    expect(cleanUserAgentLabel("x".repeat(200))!.length).toBeLessThanOrEqual(60);
    expect(cleanUserAgentLabel("   ")).toBeUndefined();
  });
});

describe("espera do e-mail de reserva", () => {
  const MIN = 60_000;
  test("sem prazo: janela da classe; tipo fora da escada: 0", () => {
    expect(safetyNetDelayMs("taskAssigned", 0)).toBe(30 * MIN);
    expect(safetyNetDelayMs("handoffRequested", 0)).toBe(10 * MIN);
    expect(safetyNetDelayMs("leadAssigned", 0)).toBe(0);
  });
  test("prazo longe: janela cheia; antecedência ≤ janela: metade do que falta; < 2 min: na hora", () => {
    expect(safetyNetDelayMs("taskDueSoon", 0, 60 * MIN)).toBe(30 * MIN);
    expect(safetyNetDelayMs("taskDueSoon", 0, 30 * MIN)).toBe(15 * MIN);
    expect(safetyNetDelayMs("taskDueSoon", 0, 15 * MIN)).toBe(Math.floor(7.5 * MIN));
    expect(safetyNetDelayMs("taskDueSoon", 0, 3 * MIN)).toBe(Math.floor(1.5 * MIN));
    expect(safetyNetDelayMs("taskDueSoon", 0, 90_000)).toBe(0);
    expect(safetyNetDelayMs("taskDueSoon", 0, -MIN)).toBe(0);
  });
});
