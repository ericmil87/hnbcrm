import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useOrgModules } from "@/hooks/useOrgModules";
import { DEFAULT_TRANSLATION_SETTINGS, type TranslationOrgSettings } from "@/lib/translationRules";

/**
 * O que a conversa precisa da tradução da org: módulo ligado, idioma da equipe
 * e os modos ao receber/responder. Módulo desligado (ou carregando) = tudo como antes.
 * `getInboxSettings` só exige ser membro da org (atendente sem `settings:view` lê).
 */
export function useTranslationSettings(
  organizationId: Id<"organizations"> | null | undefined
): TranslationOrgSettings {
  const { modules } = useOrgModules(organizationId);
  const data = useQuery(
    api.translation.getInboxSettings,
    organizationId && modules.translation ? { organizationId } : "skip"
  );
  if (!modules.translation) return DEFAULT_TRANSLATION_SETTINGS;
  return {
    moduleEnabled: true,
    teamLanguage: data?.teamLanguage ?? DEFAULT_TRANSLATION_SETTINGS.teamLanguage,
    inboundMode: data?.inboundMode ?? DEFAULT_TRANSLATION_SETTINGS.inboundMode,
    outboundMode: data?.outboundMode ?? DEFAULT_TRANSLATION_SETTINGS.outboundMode,
  };
}
