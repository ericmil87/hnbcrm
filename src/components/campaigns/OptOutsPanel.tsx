import { useEffect, useState } from "react";
import { useMutation, usePaginatedQuery, type PaginatedQueryReference } from "convex/react";
import { toast } from "sonner";
import { Ban, Plus, Search, ShieldOff, Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { mutationErrorMessage } from "@/lib/errors";
import { formatDateTime, formatPhone } from "./campaignUtils";

interface OptOutRow {
  _id: Id<"optOuts">;
  phone: string;
  source: "keyword" | "meta_131050" | "manual" | "import";
  reason?: string;
  campaignId?: Id<"campaigns">;
  contactId?: Id<"contacts">;
  createdAt: number;
}

const SOURCE_LABEL: Record<OptOutRow["source"], { label: string; variant: "warning" | "error" | "default" | "info" }> = {
  keyword: { label: "Pediu para parar", variant: "warning" },
  meta_131050: { label: "Opt-out na Meta", variant: "error" },
  manual: { label: "Manual", variant: "default" },
  import: { label: "Importado", variant: "info" },
};

interface OptOutsPanelProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
}

// Lista de supressão da organização: quem está aqui NUNCA recebe campanha.
// Entradas chegam por palavra-chave inbound (SAIR/PARAR…), pelo erro 131050 da
// Meta, pelo botão "Não contatar" no contato ou por aqui (manual). Remover
// exige `campaigns:full` — é reabrir a porta para alguém que pediu para sair.
export function OptOutsPanel({ organizationId, open, onClose }: OptOutsPanelProps) {
  const { can } = usePermissions(organizationId);
  const canManage = can("campaigns", "manage");
  const canFull = can("campaigns", "full");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const listRef = api.optOuts.listOptOuts as unknown as PaginatedQueryReference;
  const { results, status, loadMore } = usePaginatedQuery(
    listRef,
    open ? { organizationId, ...(search ? { search } : {}) } : "skip",
    { initialNumItems: 30 }
  );
  const rows = (results ?? []) as OptOutRow[];

  const addOptOut = useMutation(api.optOuts.addOptOut);
  const removeOptOut = useMutation(api.optOuts.removeOptOut);

  const [newPhone, setNewPhone] = useState("");
  const [newReason, setNewReason] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<OptOutRow | null>(null);

  const handleAdd = async () => {
    if (!newPhone.trim()) return;
    setAdding(true);
    try {
      const id = await addOptOut({
        organizationId,
        phone: newPhone.trim(),
        ...(newReason.trim() ? { reason: newReason.trim() } : {}),
      });
      toast.success(id ? "Número adicionado à lista de supressão" : "Este número já estava na lista");
      setNewPhone("");
      setNewReason("");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha ao adicionar"));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async () => {
    if (!confirmRemove) return;
    try {
      await removeOptOut({ optOutId: confirmRemove._id });
      toast.success("Número removido da supressão — voltará a receber campanhas");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha ao remover"));
    } finally {
      setConfirmRemove(null);
    }
  };

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="Lista de supressão"
      titleIcon={<Ban size={18} className="text-semantic-warning" />}
      className="md:w-[560px]"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Números que pediram para não receber mensagens. Nenhuma campanha envia para quem está
          aqui, mesmo que o número esteja no segmento ou no CSV. Entradas automáticas vêm das
          palavras-chave (SAIR, PARAR, STOP, CANCELAR) e do opt-out registrado pela Meta.
        </p>

        {canManage && (
          <div className="rounded-lg border border-border bg-surface-sunken p-3 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="Telefone (ex.: 11 99999-0000)"
                className="flex-1"
                inputMode="tel"
              />
              <Input
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder="Motivo (opcional)"
                className="flex-1"
              />
              <Button onClick={() => void handleAdd()} disabled={adding || !newPhone.trim()}>
                <Plus size={16} /> Adicionar
              </Button>
            </div>
          </div>
        )}

        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por telefone"
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-border bg-surface-raised text-text-primary text-base md:text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
            inputMode="tel"
          />
        </div>

        {status === "LoadingFirstPage" ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShieldOff}
            title={search ? "Nenhum número encontrado" : "Lista vazia"}
            description={
              search
                ? "Nenhum número da supressão contém esses dígitos."
                : "Ninguém pediu para sair ainda. Contatos que responderem SAIR entram aqui sozinhos."
            }
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {rows.map((row) => {
              const meta = SOURCE_LABEL[row.source] ?? SOURCE_LABEL.manual;
              return (
                <li key={row._id} className="flex items-start gap-3 p-3 bg-surface-raised">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-text-primary tabular-nums">{formatPhone(row.phone)}</span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </div>
                    {row.reason && <p className="text-xs text-text-secondary mt-0.5 break-words">{row.reason}</p>}
                    <p className="text-[11px] text-text-muted mt-0.5">{formatDateTime(row.createdAt)}</p>
                  </div>
                  {canFull && (
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(row)}
                      className="h-11 w-11 shrink-0 inline-flex items-center justify-center rounded-full text-text-muted hover:text-semantic-error hover:bg-semantic-error/10"
                      aria-label="Remover da supressão"
                      title="Remover da supressão"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {status === "CanLoadMore" && (
          <div className="flex justify-center">
            <Button variant="secondary" onClick={() => loadMore(50)}>
              Carregar mais
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => void handleRemove()}
        title="Remover da lista de supressão?"
        description={
          confirmRemove
            ? `${formatPhone(confirmRemove.phone)} voltará a receber campanhas. Faça isso apenas se a pessoa pediu para voltar a ser contatada — reenviar a quem pediu para parar é o caminho mais curto para denúncia e bloqueio.`
            : ""
        }
        confirmLabel="Remover"
        variant="danger"
      />
    </SlideOver>
  );
}
