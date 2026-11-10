import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useNow } from "@/hooks/useNow";
import { usePermissions } from "@/hooks/usePermissions";
import { readDismissed, resolveBillingBanner, writeDismissed, type BannerEntitlements } from "@/lib/billingBanner";
import { roundNow } from "@/lib/billingPanel";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { BillingBanner } from "./BillingBanner";

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Banner de plano e uso no AppShell: assina só `getMyEntitlements` (leve). */
export function BillingBannerContainer({
  organizationId,
  className,
}: {
  organizationId: Id<"organizations">;
  className?: string;
}) {
  const { can } = usePermissions(organizationId);
  const ent = useQuery(api.billing.getMyEntitlements, { organizationId });
  const now = roundNow(useNow(true, 15 * 60_000));
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => readDismissed(organizationId, safeStorage()));

  const banner = useMemo(
    () =>
      resolveBillingBanner({
        ent: ent as BannerEntitlements | null | undefined,
        now,
        canViewBilling: can("settings", "view"),
        dismissed,
      }),
    [ent, now, can, dismissed],
  );
  if (!banner) return null;

  return (
    <BillingBanner
      banner={banner}
      className={className}
      onDismiss={() => {
        if (banner.dismissKey === null) return;
        const next = new Set(dismissed);
        next.add(banner.dismissKey);
        setDismissed(next);
        writeDismissed(organizationId, next, safeStorage());
      }}
    />
  );
}
