import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { ArrowRight, ArrowRightLeft, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { hexAlpha } from "./centralMeta";

export interface DepartmentOption {
  _id: Id<"departments">;
  name: string;
  color: string;
  description?: string;
  members: { _id: Id<"teamMembers">; name: string; type: "human" | "ai" }[];
  openCount?: number;
}

interface TransferModalProps {
  open: boolean;
  onClose: () => void;
  conversationId: Id<"conversations">;
  departments: DepartmentOption[];
  currentDepartment: { _id: Id<"departments">; name: string; color: string } | null;
  currentAssigneeId: Id<"teamMembers"> | null;
}

/**
 * Transferir conversa para outro setor (e, opcionalmente, uma pessoa dele),
 * com nota interna. Setor sem pessoa = a conversa volta para a FILA do setor.
 */
export function TransferModal({
  open,
  onClose,
  conversationId,
  departments,
  currentDepartment,
  currentAssigneeId,
}: TransferModalProps) {
  const transfer = useMutation(api.conversationRouting.transferConversation);
  const [deptId, setDeptId] = useState<Id<"departments"> | null>(null);
  const [memberId, setMemberId] = useState<Id<"teamMembers"> | "">("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Sugere o primeiro setor diferente do atual.
    setDeptId(departments.find((d) => d._id !== currentDepartment?._id)?._id ?? null);
    setMemberId("");
    setNote("");
    // Só ao abrir: `departments` é reativo (contadores mudam a cada conversa
    // que entra) e resetaria o formulário enquanto a pessoa escreve a nota.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const target = departments.find((d) => d._id === deptId) ?? null;
  const members = (target?.members ?? []).filter((m) => m._id !== currentAssigneeId);
  const memberName = members.find((m) => m._id === memberId)?.name;
  const sameAsCurrent = !!target && target._id === currentDepartment?._id && !memberId;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || sameAsCurrent) return;
    setSubmitting(true);
    try {
      await transfer({
        conversationId,
        toDepartmentId: target._id,
        ...(memberId ? { toMemberId: memberId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(`Conversa transferida para ${target.name}${memberName ? ` · ${memberName}` : ""}`);
      onClose();
    } catch (err) {
      toast.error(mutationErrorMessage(err, "Falha ao transferir a conversa"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Transferir conversa">
      <form onSubmit={handleSubmit} className="space-y-4">
        {departments.length === 0 ? (
          <p className="text-sm text-text-muted">
            Nenhum setor cadastrado. Crie setores em Configurações → Central.
          </p>
        ) : (
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-text-secondary">Para qual setor?</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {departments.map((d) => {
                const selected = d._id === deptId;
                const isCurrent = d._id === currentDepartment?._id;
                return (
                  <label
                    key={d._id}
                    className={cn(
                      "relative flex min-h-[52px] cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors",
                      "focus-within:ring-2 focus-within:ring-brand-500",
                      selected ? "text-text-primary" : "border-border-strong text-text-secondary hover:bg-surface-raised"
                    )}
                    style={
                      selected
                        ? { borderColor: d.color, backgroundColor: hexAlpha(d.color, 0.12) }
                        : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="transfer-department"
                      value={d._id}
                      checked={selected}
                      onChange={() => {
                        setDeptId(d._id);
                        setMemberId("");
                      }}
                      className="sr-only"
                    />
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{d.name}</span>
                      <span className="block truncate text-xs text-text-muted">
                        {isCurrent
                          ? "Setor atual"
                          : `${d.members.length} pessoa${d.members.length === 1 ? "" : "s"}`}
                      </span>
                    </span>
                    {selected && <Check size={16} className="shrink-0 text-brand-500" aria-hidden />}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {target && (
          <div>
            <label htmlFor="transfer-member" className="mb-1.5 block text-[13px] font-medium text-text-secondary">
              Pessoa do setor <span className="font-normal text-text-muted">(opcional)</span>
            </label>
            <select
              id="transfer-member"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value as Id<"teamMembers"> | "")}
              className="h-11 w-full rounded-lg border border-border-strong bg-surface-raised px-3 text-base text-text-primary focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 md:text-sm"
            >
              <option value="">Fila do setor (quem estiver livre pega)</option>
              {members.map((m) => (
                <option key={m._id} value={m._id}>
                  {m.name}
                  {m.type === "ai" ? " (IA)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="transfer-note" className="mb-1.5 block text-[13px] font-medium text-text-secondary">
            Nota interna <span className="font-normal text-text-muted">(o cliente não vê)</span>
          </label>
          <textarea
            id="transfer-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Ex.: hóspede pediu a nota fiscal da estadia de agosto"
            className="w-full resize-none rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 md:text-sm"
          />
        </div>

        {target && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2.5 text-sm"
            aria-live="polite"
          >
            <ArrowRightLeft size={15} className="shrink-0 text-brand-500" aria-hidden />
            <span className="text-text-secondary">{currentDepartment?.name ?? "Sem setor"}</span>
            <ArrowRight size={14} className="shrink-0 text-text-muted" aria-hidden />
            <span className="font-medium text-text-primary">
              {target.name}
              {memberName ? ` · ${memberName}` : ""}
            </span>
          </div>
        )}
        {sameAsCurrent && (
          <p className="text-xs text-semantic-warning">
            A conversa já está neste setor — escolha outro setor ou uma pessoa.
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" className="flex-1" disabled={!target || sameAsCurrent || submitting}>
            {submitting ? "Transferindo…" : "Transferir"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
