import { PhoneOff } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { NOT_FOUND_BADGE, NOT_ON_WHATSAPP_BADGE, numberWarningOf, type ContactWhatsappMarker } from "@/lib/messageDelivery";
import { cn } from "@/lib/utils";

/**
 * Selo de aviso do número: "Sem WhatsApp" (marcador) ou "Número não encontrado"
 * (falhas seguidas, sem afirmar que não há conta). Só aparece enquanto vale para o número atual.
 */
export function NotOnWhatsappBadge({
  contact,
  className,
}: {
  contact: ContactWhatsappMarker | null | undefined;
  className?: string;
}) {
  const warning = numberWarningOf(contact);
  if (!warning) return null;
  const copy = warning === "not_found" ? NOT_FOUND_BADGE : NOT_ON_WHATSAPP_BADGE;
  return (
    <Tooltip content={copy.explanation} asInfo>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full bg-semantic-warning/10 px-2 py-0.5 text-xs font-medium text-semantic-warning",
          className
        )}
      >
        <PhoneOff className="size-3" aria-hidden="true" />
        {copy.label}
      </span>
    </Tooltip>
  );
}
