import { useQuery } from "convex/react";
import { Switch } from "@/components/ui/Switch";
import { useCopilotFabPref } from "@/hooks/useCopilotFabPref";
import { writeCopilotFabEnabled } from "@/lib/copilotFabPref";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

interface CopilotFabSwitchProps {
  organizationId: Id<"organizations">;
}

/** "Botão flutuante do Copiloto" (por aparelho). Some se o Copiloto não está ativo na organização. */
export function CopilotFabSwitch({ organizationId }: CopilotFabSwitchProps) {
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const fabEnabled = useCopilotFabPref();
  if (!aiStatus?.active || !aiStatus.copilotEnabled) return null;
  return (
    <div className="rounded-card border border-border bg-surface-raised p-4">
      <Switch
        checked={fabEnabled}
        onCheckedChange={writeCopilotFabEnabled}
        label="Botão flutuante do Copiloto"
        description="Mostra um botão sobre as telas para abrir o Copiloto. Vale só neste aparelho; o Copiloto continua no menu ⋯ (celular) e na barra lateral (computador)."
      />
    </div>
  );
}
