import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PUSH_ENABLED } from "@/lib/featureFlags";
import { mutationErrorMessage } from "@/lib/errors";
import { disablePush, enablePush, resyncPush, type PushBackend } from "@/lib/push/actions";
import { getExistingSubscription, pushStatusOf, pushStatusWithServer, readPushSupport, type PushStatus } from "@/lib/push/subscription";

/** Avisa as outras instâncias do hook (cartão, convite, lista) que o estado do aparelho mudou. */
export const PUSH_CHANGED_EVENT = "hnb:push-changed";

function readPermission(): NotificationPermission | "unavailable" {
  return typeof Notification === "undefined" ? "unavailable" : Notification.permission;
}

export interface PushSubscriptionApi {
  /** `true` sem push no deployment (chave VAPID nula) ou com o kill switch `PUSH_ENABLED` desligado. */
  hidden: boolean;
  /** Chave VAPID e usuário carregados: já dá para re-sincronizar. */
  ready: boolean;
  status: PushStatus;
  /** Endpoint desta assinatura (para marcar "Este aparelho"). */
  endpoint: string | null;
  error: string | null;
  busy: boolean;
  /** Pede a permissão (SÓ chamar dentro de um toque) e assina. */
  enable: () => Promise<boolean>;
  disable: () => Promise<void>;
  /** Re-sincroniza a assinatura do navegador com as orgs vinculadas + a ativa (idempotente). */
  resync: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** Estado da ativação de avisos neste aparelho para a org ativa. */
export function usePushSubscription(organizationId: Id<"organizations">): PushSubscriptionApi {
  const vapidQuery = useQuery(api.push.getVapidPublicKey, {});
  // `PUSH_ENABLED` é o kill switch do front: desligado, nada de push (nem o re-sync).
  const vapidKey = PUSH_ENABLED ? vapidQuery : null;
  const user = useQuery(api.auth.loggedInUser);
  const userId: string | undefined = user?._id;
  const convex = useConvex();
  const subscribeMut = useMutation(api.push.subscribe);
  const unsubscribeMut = useMutation(api.push.unsubscribe);
  const backend = useMemo<PushBackend>(
    () => ({
      subscribe: (args) => subscribeMut({ ...args, organizationId: args.organizationId as Id<"organizations"> }),
      unsubscribe: (args) => unsubscribeMut({ ...args, organizationId: args.organizationId as Id<"organizations"> }),
      getMyDevices: (args) => convex.query(api.push.getMyDevices, { ...args, organizationId: args.organizationId as Id<"organizations"> }),
    }),
    [subscribeMut, unsubscribeMut, convex],
  );
  const [status, setStatus] = useState<PushStatus>("loading");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const support = readPushSupport();
    const permission = readPermission();
    const sub = support === "supported" && permission === "granted" ? await getExistingSubscription() : null;
    if (!aliveRef.current) return;
    setEndpoint(sub?.endpoint ?? null);
    setStatus(pushStatusOf({ support, permission, hasSubscription: !!sub }));
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(PUSH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PUSH_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!vapidKey || !userId) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await enablePush(backend, organizationId, vapidKey, userId);
      await refresh();
      if (result !== "enabled") return false;
      window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
      toast.success("Avisos ligados neste aparelho");
      return true;
    } catch (e) {
      await refresh();
      if (aliveRef.current) {
        setError(mutationErrorMessage(e, "Não foi possível ligar os avisos. Tente de novo."));
        setStatus("error");
      }
      return false;
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [vapidKey, userId, backend, organizationId, refresh]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await disablePush(backend, organizationId);
      await refresh();
      window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
      toast.success("Avisos desligados neste aparelho");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível desligar os avisos. Tente de novo."));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [backend, organizationId, refresh]);

  const resync = useCallback(async () => {
    if (!vapidKey || !userId) return;
    try {
      await resyncPush(backend, organizationId, vapidKey, userId);
    } catch {
      /* melhor esforço: a próxima abertura tenta de novo */
    }
    await refresh();
    window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
  }, [vapidKey, userId, backend, organizationId, refresh]);

  // "Ligado" só vale se o servidor também conhece este aparelho nesta org (quando a consulta já carregou).
  const devices = useQuery(
    api.push.getMyDevices,
    vapidKey && endpoint && status === "subscribed" ? { organizationId, currentEndpoint: endpoint } : "skip",
  );
  const effectiveStatus = pushStatusWithServer(status, devices);

  return {
    hidden: vapidKey === null,
    ready: typeof vapidKey === "string" && !!userId,
    status: vapidKey === undefined || (vapidKey !== null && !userId && status === "loading") ? "loading" : effectiveStatus,
    endpoint,
    error,
    busy,
    enable,
    disable,
    resync,
    refresh,
  };
}
