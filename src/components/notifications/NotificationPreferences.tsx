import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/Spinner";
import { usePermissions } from "@/hooks/usePermissions";
import { useNow } from "@/hooks/useNow";
import { PUSH_ENABLED } from "@/lib/featureFlags";
import { PWA_KILL_SWITCH } from "@/lib/pwa/appBuild";
import { deviceTimeZone, pauseArgs, pushAvailability, pushSupported } from "@/lib/notificationPrefsUi";
import { TelegramCard } from "./TelegramCard";
import { PushActivationCard } from "./PushActivationCard";
import { MyDevicesList } from "./MyDevicesList";
import { NotificationPreferencesView } from "./NotificationPreferencesView";

interface NotificationsSectionProps {
  organizationId: Id<"organizations">;
}

/** Configurações › Notificações: Telegram + preferências com salvamento a cada toque. */
export function NotificationsSection({ organizationId }: NotificationsSectionProps) {
  const prefs = useQuery(api.notificationPreferences.getMyEffectivePreferences, { organizationId });
  const telegram = useQuery(api.telegram.getMyLink, { organizationId });
  const vapidKey = useQuery(api.push.getVapidPublicKey, {});
  const myDevices = useQuery(
    api.push.getMyDevices,
    PUSH_ENABLED && !PWA_KILL_SWITCH && typeof vapidKey === "string" ? { organizationId } : "skip",
  );
  const { can } = usePermissions(organizationId);
  const now = useNow();

  const setPreset = useMutation(api.notificationPreferences.setPreset);
  const setChannelPref = useMutation(api.notificationPreferences.setChannelPref);
  const pauseFor = useMutation(api.notificationPreferences.pauseFor);
  const resume = useMutation(api.notificationPreferences.resume);
  const setQuietHours = useMutation(api.notificationPreferences.setQuietHours);
  const setUrgentBypass = useMutation(api.notificationPreferences.setUrgentBypass);
  const setShowPreview = useMutation(api.notificationPreferences.setShowPreview);
  const applyToAllMyOrgs = useMutation(api.notificationPreferences.applyToAllMyOrgs);
  const setNotificationDefaults = useMutation(api.organizations.setNotificationDefaults);

  if (prefs === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const telegramLinked = telegram?.link?.status === "active";
  // `pushEnabled`: deployment com push. `pushAvailable` (coluna Push e prévia pessoal): também exige este aparelho
  // com suporte OU algum aparelho já vinculado.
  const { pushEnabled, pushAvailable } = pushAvailability({
    featureOn: PUSH_ENABLED,
    vapidKey,
    killSwitch: PWA_KILL_SWITCH,
    deviceSupported: pushSupported(),
    hasLinkedDevice: !!myDevices?.some((d) => d.linkedHere),
  });

  return (
    <div className="space-y-6">
      <PushActivationCard organizationId={organizationId} />
      <TelegramCard organizationId={organizationId} />
      <NotificationPreferencesView
        prefs={prefs}
        now={now}
        canManageOrg={can("settings", "manage")}
        telegramLinked={telegramLinked}
        pushAvailable={pushAvailable}
        pushEnabled={pushEnabled}
        deviceTimeZone={deviceTimeZone()}
        onPreset={(preset) => setPreset({ organizationId, preset })}
        onChannel={(channel, flag, enabled) => setChannelPref({ organizationId, channel, flag, enabled })}
        onPause={(mode) => pauseFor({ organizationId, ...pauseArgs(mode, Date.now()) })}
        onResume={() => resume({ organizationId })}
        onQuietHours={(input) => setQuietHours({ organizationId, ...input })}
        onUrgentBypass={(urgentBypass) => setUrgentBypass({ organizationId, urgentBypass })}
        onShowPreview={(showPreview) => setShowPreview({ organizationId, showPreview })}
        onApplyAll={() => applyToAllMyOrgs({ sourceOrganizationId: organizationId })}
        onOrgDefaults={(input) => setNotificationDefaults({ organizationId, ...input })}
      />
      <MyDevicesList organizationId={organizationId} />
    </div>
  );
}
