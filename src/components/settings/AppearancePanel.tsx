import { useOutletContext } from "react-router";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { AppearancePicker } from "./AppearancePicker";
import { APPEARANCE_SUBTITLE } from "./appearanceCopy";

export function AppearancePanel() {
  const { theme, setTheme } = useOutletContext<AppOutletContext>();
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Aparência</h2>
        <p className="mt-1 text-sm text-text-secondary">{APPEARANCE_SUBTITLE}</p>
      </div>
      <AppearancePicker value={theme} onValueChange={setTheme} />
    </section>
  );
}
