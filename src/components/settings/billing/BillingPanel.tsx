import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { useNow } from "@/hooks/useNow";
import { usePermissions } from "@/hooks/usePermissions";
import {
  changePlanMailto,
  monthKeyUtc,
  overageConfirmText,
  overageEligibility,
  parseCapBrl,
  roundNow,
} from "@/lib/billingPanel";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { AttendancesStatement } from "./AttendancesStatement";
import { BillingPanelView } from "./BillingPanelView";
import type { OverageCardViewProps } from "./OverageCard";
import type { UsageSummary } from "./billingTypes";

interface PendingChange {
  enabled: boolean;
  capBrl: number;
}

function errorText(e: unknown, fallback: string): string {
  const data = (e as { data?: unknown } | null)?.data;
  return typeof data === "string" ? data : fallback;
}

function useOverageControl(
  organizationId: Id<"organizations">,
  summary: UsageSummary | undefined,
  mode: UsageSummary["mode"] | undefined,
  canManage: boolean,
): OverageCardViewProps {
  const setOverage = useMutation(api.billing.setOverage);
  const [typed, setTyped] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const enabled = summary?.overage.enabled ?? false;
  const serverCap = summary?.overage.capBrl ?? null;
  const unit = summary?.overage.unitBrlCents ?? null;
  const capInput = typed ?? (serverCap !== null ? String(serverCap) : "");
  const parsed = parseCapBrl(capInput);
  const capDirty = enabled && parsed.ok && parsed.capBrl !== serverCap;

  const ask = (nextEnabled: boolean) => {
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setPending({ enabled: nextEnabled, capBrl: parsed.capBrl });
  };

  const save = async (change: PendingChange) => {
    setSaving(true);
    try {
      await setOverage({ organizationId, enabled: change.enabled, capBrl: change.capBrl });
      toast.success(change.enabled ? "Excedente salvo" : "Excedente desligado");
      setTyped(null);
    } catch (e) {
      toast.error(errorText(e, "Não foi possível salvar o excedente."));
    } finally {
      setSaving(false);
      setPending(null);
    }
  };

  return {
    enabled,
    capBrl: serverCap,
    unitBrlCents: unit,
    eligibility: overageEligibility(mode ?? "trial"),
    canManage,
    capInput,
    capError: error,
    capDirty,
    saving,
    confirmOpen: pending !== null,
    confirmTitle: enabled ? "Salvar o novo teto?" : "Ligar o excedente?",
    confirmText: pending ? overageConfirmText(pending.capBrl, unit) : "",
    parsedCapBrl: parsed.ok ? parsed.capBrl : null,
    onCapInputChange: (v) => {
      setTyped(v);
      setError(null);
    },
    onToggle: (next) => {
      if (next) ask(true);
      else void save({ enabled: false, capBrl: serverCap ?? (parsed.ok ? parsed.capBrl : 1) });
    },
    onSaveCap: () => ask(true),
    onConfirm: () => {
      if (pending) void save(pending);
    },
    onCancelConfirm: () => setPending(null),
  };
}

/** Painel `billing` ("Uso e fatura"): único que assina o resumo de uso e canais/grupos. */
export function BillingPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { can } = usePermissions(organizationId);
  const canView = can("settings", "view");
  const canManage = can("settings", "manage");
  const nowRaw = useNow(true, 15 * 60_000);
  const now = roundNow(nowRaw);
  const month = monthKeyUtc(now);

  const entitlements = useQuery(api.billing.getMyEntitlements, canView ? { organizationId } : "skip");
  const hasPlan = entitlements != null && entitlements.mode !== "legacy";
  const summary = useQuery(api.billing.getUsageSummary, hasPlan ? { organizationId, month, now } : "skip");
  const channelUsage = useQuery(api.billing.getChannelAndGroupUsage, hasPlan ? { organizationId } : "skip");
  const history = useQuery(api.billing.getUsageHistory, hasPlan ? { organizationId } : "skip");
  const orgs = useQuery(api.organizations.getUserOrganizations);
  const orgName = (orgs as { _id: string; name: string }[] | undefined)?.find((o) => o._id === organizationId)?.name ?? null;

  const overage = useOverageControl(organizationId, summary, entitlements?.mode, canManage);
  const changePlanHref = useMemo(
    () => changePlanMailto(orgName, entitlements?.planLabel ?? null),
    [orgName, entitlements?.planLabel],
  );

  return (
    <BillingPanelView
      canView={canView}
      entitlements={entitlements}
      summary={summary}
      channelUsage={channelUsage}
      history={history}
      now={now}
      changePlanHref={changePlanHref}
      overage={overage}
      statement={<AttendancesStatement organizationId={organizationId} month={month} />}
    />
  );
}
