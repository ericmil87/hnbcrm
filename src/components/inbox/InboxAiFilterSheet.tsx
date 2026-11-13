import { InboxChoiceList } from "@/components/inbox/InboxChoiceList";
import { Modal } from "@/components/ui/Modal";
import { AI_FILTER_LABEL, type InboxAiFilter } from "@/lib/inboxState";

interface InboxAiFilterSheetProps {
  open: boolean;
  onClose: () => void;
  value: InboxAiFilter | null;
  onChoose: (value: InboxAiFilter | null) => void;
}

/** Celular: folha do chip "IA" (todas · IA atendendo · IA desligada). */
export function InboxAiFilterSheet({ open, onClose, value, onChoose }: InboxAiFilterSheetProps) {
  const pick = (next: InboxAiFilter | null) => {
    onChoose(next);
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Filtrar por Atendente IA">
      <InboxChoiceList
        ariaLabel="Atendente IA"
        choices={[
          { id: "all", label: "Todas as conversas", selected: !value },
          { id: "on", label: AI_FILTER_LABEL.on, selected: value === "on" },
          { id: "off", label: AI_FILTER_LABEL.off, selected: value === "off" },
        ]}
        onChoose={(id) => pick(id === "on" || id === "off" ? id : null)}
      />
    </Modal>
  );
}
