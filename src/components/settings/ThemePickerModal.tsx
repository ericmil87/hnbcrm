import { Modal } from "@/components/ui/Modal";
import { AppearancePicker } from "./AppearancePicker";
import { APPEARANCE_SUBTITLE } from "./appearanceCopy";
import { CopilotFabSwitch } from "./CopilotFabSwitch";
import type { UiTheme } from "@/lib/theme";
import type { Id } from "../../../convex/_generated/dataModel";

interface ThemePickerModalProps {
  open: boolean;
  onClose: () => void;
  organizationId: Id<"organizations">;
  theme: UiTheme;
  setTheme: (theme: UiTheme) => void;
}

export function ThemePickerModal({ open, onClose, organizationId, theme, setTheme }: ThemePickerModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Aparência">
      <p className="mb-4 text-sm text-text-secondary">{APPEARANCE_SUBTITLE}</p>
      <AppearancePicker value={theme} onValueChange={setTheme} />
      <div className="mt-4">
        <CopilotFabSwitch organizationId={organizationId} />
      </div>
    </Modal>
  );
}
