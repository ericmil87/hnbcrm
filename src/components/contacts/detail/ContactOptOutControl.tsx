import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { BellOff } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { usePermissions } from "@/hooks/usePermissions";

// Lista de supressão de campanhas: quem está aqui nunca recebe disparo em massa.
// Adicionar exige campaigns:manage OU contacts:edit (regra do backend);
// remover é campaigns:full e fica na página de Campanhas — aqui só marcamos.
export function ContactOptOutControl({
  contactId,
  organizationId,
}: {
  contactId: Id<"contacts">;
  organizationId: Id<"organizations">;
}) {
  const { can } = usePermissions(organizationId);
  const optOut = useQuery(api.optOuts.isContactOptedOut, { contactId });
  const addOptOut = useMutation(api.optOuts.addOptOut);
  const [busy, setBusy] = useState(false);
  if (optOut === undefined) return null;
  if (optOut) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-sm text-text-primary">
        <BellOff size={16} className="text-semantic-warning shrink-0" />
        <span className="flex-1">
          Em supressão — não recebe campanhas
          <span className="text-text-muted"> (desde {new Date(optOut.createdAt).toLocaleDateString("pt-BR")})</span>
        </span>
      </div>
    );
  }
  if (!can("campaigns", "manage") && !can("contacts", "edit")) return null;
  return (
    <Button
      variant="secondary"
      size="md"
      className="w-full"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await addOptOut({ organizationId, contactId, reason: "manual" });
          toast.success("Contato adicionado à lista de supressão");
        } catch (e) {
          toast.error(e instanceof Error ? e.message.replace(/^.*Uncaught Error: /, "") : "Não foi possível marcar.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <BellOff size={16} className="mr-2" />
      Não contatar em campanhas
    </Button>
  );
}
