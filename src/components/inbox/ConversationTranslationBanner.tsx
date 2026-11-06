import { useCallback, useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
import { languageHintFromDialCode } from "../../../convex/lib/languages";
import { usePermissions } from "@/hooks/usePermissions";
import { TAB_ROUTES } from "@/lib/routes";
import {
  languageDisplayName,
  teamLanguageLabel,
  translationBannerKind,
  type ConversationLanguageState,
  type TranslationOrgSettings,
} from "@/lib/translationRules";
import { readLocalFlag, readSessionFlag, writeLocalFlag, writeSessionFlag } from "@/lib/translationPrefs";
import { ConversationLanguageDialog } from "./ConversationLanguageChip";
import { TranslationBanner } from "./TranslationBanner";
import { useConversationLanguage } from "./useConversationLanguage";

interface ConversationTranslationBannerProps {
  organizationId: Id<"organizations">;
  conversation: Record<string, any>;
  settings: TranslationOrgSettings;
  state: ConversationLanguageState;
  canReply: boolean;
}

/** Container do aviso de idioma no topo do thread (escolha, desfazer, descoberta). */
export function ConversationTranslationBanner({
  organizationId,
  conversation,
  settings,
  state,
  canReply,
}: ConversationTranslationBannerProps) {
  const { can } = usePermissions(organizationId);
  const { choose, neverForContact, showBoth, setShowBoth } = useConversationLanguage(conversation._id);
  const [openedAt] = useState(() => Date.now());
  const [dialogOpen, setDialogOpen] = useState(false);
  const translation = conversation.translation ?? null;
  const contact = conversation.contact ?? null;

  const dismissKey = settings.moduleEnabled
    ? `hnbcrm:translation-banner:${conversation._id}:${translation?.detectedAt ?? 0}`
    : `hnbcrm:translation-discover:${organizationId}`;
  const [dismissed, setDismissed] = useState(() =>
    settings.moduleEnabled ? readSessionFlag(dismissKey) : readLocalFlag(dismissKey)
  );
  const dismiss = useCallback(() => {
    if (settings.moduleEnabled) writeSessionFlag(dismissKey);
    else writeLocalFlag(dismissKey);
    setDismissed(true);
  }, [dismissKey, settings.moduleEnabled]);

  const hint: string | undefined =
    contact?.preferredLanguage || languageHintFromDialCode(contact?.whatsappNumber ?? contact?.phone);

  const kind = translationBannerKind({
    state,
    translation,
    settings,
    isGroup: conversation.kind === "group",
    openedAt,
    dismissed,
    canManageSettings: can("settings", "manage"),
    contactLanguageHint: hint,
  });

  if (!kind && !dialogOpen) return null;

  const lang = state.lang ?? hint;
  return (
    <>
      {kind && (
      <TranslationBanner
        kind={kind}
        languageName={languageDisplayName(lang, { lower: true })}
        teamLabel={teamLanguageLabel(settings.teamLanguage)}
        canChoose={canReply}
        settingsHref={`${TAB_ROUTES.settings}?secao=translation`}
        onUndo={() => {
          dismiss();
          void choose({ mode: "off" });
        }}
        onAccept={() => void choose({ mode: "auto" })}
        onDecline={() => void choose({ mode: "off" })}
        onPickLanguage={() => setDialogOpen(true)}
        onNeverForContact={() => {
          dismiss();
          void neverForContact(settings.teamLanguage);
        }}
        onDismiss={dismiss}
      />
      )}
      <ConversationLanguageDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        state={state}
        teamLanguage={settings.teamLanguage}
        onSelect={(choice) => {
          dismiss();
          void choose(choice);
        }}
        showBoth={showBoth}
        onShowBothChange={setShowBoth}
        hasContact={!!contact}
      />
    </>
  );
}
