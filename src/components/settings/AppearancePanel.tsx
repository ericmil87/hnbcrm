import { useOutletContext } from "react-router";
import { useQuery } from "convex/react";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { Switch } from "@/components/ui/Switch";
import { useCopilotFabPref } from "@/hooks/useCopilotFabPref";
import { writeCopilotFabEnabled } from "@/lib/copilotFabPref";
import { api } from "../../../convex/_generated/api";
import { AppearancePicker } from "./AppearancePicker";
import { APPEARANCE_SUBTITLE } from "./appearanceCopy";

export function AppearancePanel() {
  const { theme, setTheme, organizationId } = useOutletContext<AppOutletContext>();
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const copilotEnabled = Boolean(aiStatus?.active && aiStatus.copilotEnabled);
  const fabEnabled = useCopilotFabPref();
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Aparência</h2>
        <p className="mt-1 text-sm text-text-secondary">{APPEARANCE_SUBTITLE}</p>
      </div>
      <AppearancePicker value={theme} onValueChange={setTheme} />
      {copilotEnabled && (
        <div className="rounded-card border border-border bg-surface-raised p-4">
          <Switch
            checked={fabEnabled}
            onCheckedChange={writeCopilotFabEnabled}
            label="Botão flutuante do Copiloto"
            description="Mostra um botão sobre as telas para abrir o Copiloto. Vale só neste aparelho; o Copiloto continua no menu ⋯ (celular) e na barra lateral (computador)."
          />
        </div>
      )}
    </section>
  );
}
