import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Laptop, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SectionCard } from "@/components/ui/SectionCard";
import { PUSH_CHANGED_EVENT, usePushSubscription } from "@/hooks/usePushSubscription";
import { useNow } from "@/hooks/useNow";
import { formatRelative } from "@/lib/format";
import { mutationErrorMessage } from "@/lib/errors";
import { clearLinkedOrgs, deviceDisplayName, unsubscribeBrowser, type PushPlatform } from "@/lib/push/subscription";

export interface DeviceRow {
  subscriptionId: string;
  platform: PushPlatform;
  userAgentLabel: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  linkedHere: boolean;
  isCurrent: boolean;
}

interface MyDevicesListViewProps {
  devices: readonly DeviceRow[];
  now: number;
  onRemove: (subscriptionId: string) => void | Promise<void>;
}

/** "Meus aparelhos" (apresentacional): nome, "Este aparelho", visto por último, "Remover" com confirmação. */
export function MyDevicesListView({ devices, now, onRemove }: MyDevicesListViewProps) {
  const [pending, setPending] = useState<DeviceRow | null>(null);
  return (
    <SectionCard
      title="Meus aparelhos"
      description="Aparelhos que recebem seus avisos. Ao remover, os avisos param só naquele aparelho."
      icon={<Smartphone size={20} aria-hidden="true" />}
    >
      <ul className="divide-y divide-border-subtle">
        {devices.map((d) => (
          <li key={d.subscriptionId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-text-secondary">
              {d.platform === "desktop" ? <Laptop size={18} aria-hidden="true" /> : <Smartphone size={18} aria-hidden="true" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                <span className="truncate">{deviceDisplayName(d)}</span>
                {d.isCurrent && <Badge variant="brand">Este aparelho</Badge>}
                {!d.linkedHere && <Badge variant="default">Outra organização</Badge>}
              </p>
              <p className="text-caption text-text-muted">Visto {formatRelative(d.lastSeenAt ?? d.createdAt, now)}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setPending(d)} aria-label={`Remover ${deviceDisplayName(d)}`}>
              <Trash2 size={16} aria-hidden="true" />
              Remover
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const target = pending;
          setPending(null);
          if (target) void onRemove(target.subscriptionId);
        }}
        title="Remover este aparelho?"
        description={
          pending?.isCurrent
            ? "Este aparelho deixa de receber avisos com o app fechado. Você pode ativar de novo quando quiser."
            : "Ele deixa de receber seus avisos em todas as organizações."
        }
        confirmLabel="Remover"
        variant="danger"
      />
    </SectionCard>
  );
}

/** Container. Some sem push no deployment ou sem aparelhos. */
export function MyDevicesList({ organizationId }: { organizationId: Id<"organizations"> }) {
  const push = usePushSubscription(organizationId);
  const devices = useQuery(
    api.push.getMyDevices,
    push.hidden ? "skip" : { organizationId, ...(push.endpoint ? { currentEndpoint: push.endpoint } : {}) },
  );
  const removeDevice = useMutation(api.push.removeDevice);
  const now = useNow();
  if (push.hidden || !devices || devices.length === 0) return null;
  return (
    <MyDevicesListView
      devices={devices}
      now={now}
      onRemove={async (subscriptionId) => {
        const device = devices.find((d) => d.subscriptionId === subscriptionId);
        try {
          await removeDevice({ organizationId, subscriptionId: subscriptionId as Id<"pushSubscriptions"> });
          if (device?.isCurrent) {
            await unsubscribeBrowser();
            clearLinkedOrgs();
            window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
          }
          toast.success("Aparelho removido");
        } catch (e) {
          toast.error(mutationErrorMessage(e, "Não foi possível remover o aparelho."));
        }
      }}
    />
  );
}
