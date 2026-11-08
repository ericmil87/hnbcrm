import { closeReadNotifications } from "./closeReadNotifications";
import { getPushRegistration } from "./subscription";

/** Fecha, no aparelho, os avisos que já foram lidos (abrir o app / ler em outro lugar). */

export interface DeviceNotificationLike {
  tag?: string;
  data?: unknown;
  close: () => void;
}

/**
 * Quais notificações do aparelho fechar. `unreadIds` é a página mais recente de não lidas; só
 * dá para concluir "foi lida" quando essa página é a lista COMPLETA (`unreadTotal <= unreadIds.length`),
 * senão um aviso antigo ainda não lido seria fechado por engano. Só olha a org ativa.
 */
export function selectReadNotifications<T extends DeviceNotificationLike>(
  shown: readonly T[],
  opts: { organizationId: string; unreadIds: readonly string[]; unreadTotal: number },
): T[] {
  if (opts.unreadTotal > opts.unreadIds.length) return [];
  const unread = new Set(opts.unreadIds);
  return shown.filter((n) => {
    const { notificationId, organizationId } = identityOf(n.data);
    if (!notificationId || organizationId !== opts.organizationId) return false;
    return !unread.has(notificationId);
  });
}

/** `data.notificationId`/`data.organizationId` (ou o mesmo dentro de `data.hnb`, o payload do servidor). */
function identityOf(data: unknown): { notificationId?: string; organizationId?: string } {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return {};
  const hnb = (d.hnb && typeof d.hnb === "object" ? d.hnb : {}) as Record<string, unknown>;
  const pick = (k: string) => {
    const v = d[k] ?? hnb[k];
    return typeof v === "string" ? v : undefined;
  };
  return { notificationId: pick("notificationId"), organizationId: pick("organizationId") };
}

export async function closeReadDeviceNotifications(opts: {
  organizationId: string;
  unreadIds: readonly string[];
  unreadTotal: number;
}): Promise<number> {
  try {
    const reg = await getPushRegistration(3000);
    if (!reg || typeof reg.getNotifications !== "function") return 0;
    const shown = await reg.getNotifications();
    const ids = selectReadNotifications(shown, opts)
      .map((n) => identityOf(n.data).notificationId)
      .filter((id): id is string => !!id);
    return await closeReadNotifications(reg, { notificationIds: ids });
  } catch {
    return 0;
  }
}
