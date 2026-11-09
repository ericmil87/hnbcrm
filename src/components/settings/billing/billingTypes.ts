import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../../convex/_generated/api";

export type Entitlements = NonNullable<FunctionReturnType<typeof api.billing.getMyEntitlements>>;
export type UsageSummary = FunctionReturnType<typeof api.billing.getUsageSummary>;
export type ChannelAndGroupUsage = FunctionReturnType<typeof api.billing.getChannelAndGroupUsage>;
export type UsageHistory = FunctionReturnType<typeof api.billing.getUsageHistory>;
