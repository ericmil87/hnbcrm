import { useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { MoreVertical, Archive, ArchiveRestore, Bot, Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/usePermissions";
import { DeleteLeadDialog } from "@/components/leads/DeleteLeadDialog";
import { useChatMode } from "@/components/layout/chatMode";
import { Popover } from "@/components/ui/Popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Button } from "@/components/ui/Button";

// Menu "..." do header da conversa: arquivar/desarquivar + etiquetas (toggle,
// criar, excluir). Paleta fixa — a cor vive no doc da etiqueta.

export const LABEL_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#64748b",
] as const;

interface ConversationActionsMenuProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  archivedAt: number | undefined;
  labelIds: string[];
  /** Chamado após arquivar/desarquivar (ex.: voltar para a lista). */
  onArchivedChange?: (archived: boolean) => void;
  /**
   * Itens extras no topo do menu (conversa de GRUPO: parar de acompanhar,
   * sair da sala, resumo por IA). Recebe o fechador do menu porque quem
   * renderiza o item é quem sabe se a ação abre um diálogo antes de agir.
   */
  renderExtraItems?: (close: () => void) => React.ReactNode;
  /** Lead da conversa (ausente em grupo). Habilita "Excluir lead permanentemente…" com `leads:full`. */
  leadId?: Id<"leads">;
  /** Chamado após o lead ser excluído (ex.: fechar a conversa). */
  onLeadDeleted?: () => void;
}

export function ConversationActionsMenu({
  organizationId,
  conversationId,
  archivedAt,
  labelIds,
  onArchivedChange,
  renderExtraItems,
  leadId,
  onLeadDeleted,
}: ConversationActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmDeleteLead, setConfirmDeleteLead] = useState(false);
  const { can } = usePermissions(organizationId);
  const canDeleteLead = !!leadId && can("leads", "full");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(LABEL_COLORS[3]);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const { openCopilot } = useChatMode();

  const labels = useQuery(api.conversations.listLabels, { organizationId });
  const setArchived = useMutation(api.conversations.setConversationArchived);
  const toggleLabel = useMutation(api.conversations.toggleConversationLabel);
  const createLabel = useMutation(api.conversations.createLabel);
  const deleteLabel = useMutation(api.conversations.deleteLabel);

  const archived = !!archivedAt;

  const handleArchive = async () => {
    try {
      await setArchived({ conversationId, archived: !archived });
      toast.success(archived ? "Conversa desarquivada" : "Conversa arquivada");
      setOpen(false);
      onArchivedChange?.(!archived);
    } catch {
      toast.error("Não foi possível arquivar a conversa.");
    }
  };

  const handleToggleLabel = async (labelId: Id<"conversationLabels">) => {
    try {
      await toggleLabel({ conversationId, labelId });
    } catch {
      toast.error("Não foi possível aplicar a etiqueta.");
    }
  };

  const handleCreateLabel = async () => {
    if (!newName.trim() || saving) return;
    setSaving(true);
    try {
      const labelId = await createLabel({ organizationId, name: newName, color: newColor });
      // Já aplica a etiqueta recém-criada nesta conversa.
      await toggleLabel({ conversationId, labelId });
      setNewName("");
      setCreating(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message.split("\n")[0].replace(/^.*Error: /, "") : "Não foi possível criar a etiqueta.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteLabel = async (labelId: Id<"conversationLabels">, name: string) => {
    try {
      await deleteLabel({ labelId });
      toast.success(`Etiqueta "${name}" excluída`);
    } catch {
      toast.error("Não foi possível excluir a etiqueta.");
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors md:h-9 md:w-9",
          open && "text-text-primary bg-surface-overlay"
        )}
        aria-label="Ações da conversa"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <MoreVertical size={20} />
      </button>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchorRef}
        align="end"
        sheet={isMobile}
        role="dialog"
        aria-label="Ações da conversa"
        className={cn("py-1", !isMobile && "w-60")}
      >
        <div>
          {openCopilot && (
            <div className="border-b border-border pb-1 mb-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  openCopilot();
                }}
                className="w-full min-h-[44px] md:min-h-0 flex items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
              >
                <Bot size={15} />
                Copiloto
              </button>
            </div>
          )}
          {renderExtraItems && (
            <div className="border-b border-border pb-1 mb-1">
              {renderExtraItems(() => setOpen(false))}
            </div>
          )}
          <button
            type="button"
            onClick={handleArchive}
            className="w-full coarse:min-h-11 flex items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
          >
            {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            {archived ? "Desarquivar conversa" : "Arquivar conversa"}
          </button>

          <p className="px-3 pt-2 pb-1 text-caption font-semibold uppercase tracking-wide text-text-muted border-t border-border mt-1">
            Etiquetas
          </p>
          {labels === undefined ? (
            <p className="px-3 py-1.5 text-xs text-text-muted">Carregando…</p>
          ) : (
            labels.map((label) => {
              const active = labelIds.includes(label._id);
              return (
                <div
                  key={label._id}
                  className="group flex coarse:min-h-11 items-center gap-2.5 px-3 py-1.5 hover:bg-surface-raised transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => handleToggleLabel(label._id)}
                    className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1 min-w-0 truncate text-sm text-text-primary">
                      {label.name}
                    </span>
                    {active && <Check size={14} className="shrink-0 text-brand-500" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteLabel(label._id, label.name)}
                    className="shrink-0 p-1 rounded-full text-text-muted opacity-0 coarse:opacity-100 group-hover:opacity-100 coarse:p-2.5 hover:text-semantic-error transition-all"
                    aria-label={`Excluir etiqueta ${label.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })
          )}

          {creating ? (
            // <form>: no iPhone o ✓/"OK" do teclado envia o formulário; sem ele
            // o teclado só fechava e a etiqueta não era criada (só Enter criava).
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateLabel();
              }}
              className="px-3 py-2 space-y-2 border-t border-border mt-1"
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                enterKeyHint="done"
                maxLength={30}
                placeholder="Nome da etiqueta"
                aria-label="Nome da etiqueta"
                className="w-full h-10 md:h-8 px-2.5 rounded-lg text-base md:text-sm bg-surface-sunken border border-border-strong text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              />
              <div className="flex items-center gap-1.5">
                {LABEL_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setNewColor(color)}
                    className={cn(
                      "h-5 w-5 rounded-full transition-transform hover:scale-110",
                      newColor === color && "ring-2 ring-offset-1 ring-brand-500 ring-offset-surface-overlay"
                    )}
                    style={{ backgroundColor: color }}
                    aria-label={`Cor ${color}`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                >
                  Cancelar
                </Button>
                <Button type="submit" size="sm" disabled={!newName.trim()} loading={saving}>
                  Criar
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full coarse:min-h-11 flex items-center gap-2.5 px-3 py-2 text-left text-xs text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
            >
              <Plus size={13} />
              Nova etiqueta
            </button>
          )}

          {canDeleteLead && (
            <div className="border-t border-border mt-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setConfirmDeleteLead(true);
                }}
                className="w-full min-h-[44px] md:min-h-0 flex items-center gap-2.5 px-3 py-2 text-left text-sm text-semantic-error hover:bg-semantic-error/10 transition-colors"
              >
                <Trash2 size={15} />
                Excluir lead permanentemente…
              </button>
            </div>
          )}
        </div>
      </Popover>

      {confirmDeleteLead && leadId && (
        <DeleteLeadDialog
          leadId={leadId}
          onClose={() => setConfirmDeleteLead(false)}
          onDeleted={() => onLeadDeleted?.()}
        />
      )}
    </div>
  );
}
