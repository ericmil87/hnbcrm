import { Modal } from "@/components/ui/Modal";
import { AppearancePicker } from "./AppearancePicker";
import { APPEARANCE_SUBTITLE } from "./appearanceCopy";
import type { UiTheme } from "@/lib/theme";

interface ThemePickerModalProps {
  open: boolean;
  onClose: () => void;
  theme: UiTheme;
  setTheme: (theme: UiTheme) => void;
}

export function ThemePickerModal({ open, onClose, theme, setTheme }: ThemePickerModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Aparência">
      <p className="mb-4 text-sm text-text-secondary">{APPEARANCE_SUBTITLE}</p>
      <AppearancePicker value={theme} onValueChange={setTheme} />
    </Modal>
  );
}
