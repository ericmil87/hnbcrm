import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Zap, Pencil, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// Respostas rápidas: digitar "/" no início do composer abre o dropdown; o item
// escolhido substitui o texto. Gestão (criar/editar/excluir) num modal enxuto.

export interface QuickReplyItem {
  _id: Id<"quickReplies">;
  shortcut: string;
  content: string;
}

interface UseQuickRepliesArgs {
  organizationId: Id<"organizations">;
  value: string;
  /** Aplica o conteúdo escolhido no composer (substitui o texto atual). */
  onApply: (content: string) => void;
  /** Desliga o gatilho (ex.: modo nota interna usa "@", não "/"). */
  enabled?: boolean;
}

export function useQuickReplies({ organizationId, value, onApply, enabled = true }: UseQuickRepliesArgs) {
  const replies = useQuery(api.quickReplies.list, { organizationId });
  const [manageOpen, setManageOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Gatilho: mensagem começando com "/" e sem espaço ainda ("/sau").
  const match = enabled ? value.match(/^\/(\S*)$/) : null;
  const filter = (match?.[1] ?? "").toLowerCase();
  const open = match !== null && replies !== undefined;

  const items = useMemo(() => {
    if (!open || !replies) return [];
    return replies
      .filter(
        (r) =>
          r.shortcut.toLowerCase().startsWith(filter) ||
          r.content.toLowerCase().includes(filter)
      )
      .slice(0, 8);
  }, [open, replies, filter]);

  useEffect(() => setActiveIndex(0), [filter, open]);

  const pick = (item: QuickReplyItem) => onApply(item.content);

  /** Trata navegação do dropdown; retorna true quando consumiu a tecla. */
  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open || items.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(items[activeIndex]);
      return true;
    }
    return false;
  };

  return { open, items, activeIndex, pick, handleKeyDown, manageOpen, setManageOpen };
}

interface QuickReplyDropdownProps {
  open: boolean;
  items: QuickReplyItem[];
  activeIndex: number;
  onPick: (item: QuickReplyItem) => void;
  onManage: () => void;
}

/** Dropdown ancorado acima do composer — o pai precisa de um container relative. */
export function QuickReplyDropdown({ open, items, activeIndex, onPick, onManage }: QuickReplyDropdownProps) {
  if (!open) return null;
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-40 bg-surface-overlay border border-border rounded-xl shadow-elevated overflow-hidden">
      {items.length === 0 ? (
        <div className="p-3 text-center">
          <p className="text-xs text-text-muted mb-2">Nenhuma resposta rápida encontrada</p>
          <button
            type="button"
            onClick={onManage}
            className="text-xs text-brand-500 hover:text-brand-400 font-medium transition-colors"
          >
            + Criar resposta rápida
          </button>
        </div>
      ) : (
        <>
          <div className="max-h-56 overflow-y-auto">
            {items.map((item, index) => (
              <button
                key={item._id}
                type="button"
                // onMouseDown para ganhar do blur do textarea
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(item);
                }}
                className={cn(
                  "w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors",
                  index === activeIndex ? "bg-brand-500/10" : "hover:bg-surface-raised"
                )}
              >
                <Zap size={13} className="shrink-0 mt-0.5 text-brand-500" />
                <span className="min-w-0">
                  <span className="text-xs font-semibold text-text-primary">/{item.shortcut}</span>
                  <span className="block text-xs text-text-secondary truncate">{item.content}</span>
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onManage();
            }}
            className="w-full px-3 py-1.5 text-left text-[11px] text-text-muted hover:text-text-primary border-t border-border transition-colors"
          >
            Gerenciar respostas rápidas
          </button>
        </>
      )}
    </div>
  );
}

interface QuickRepliesModalProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
}

export function QuickRepliesModal({ organizationId, open, onClose }: QuickRepliesModalProps) {
  const replies = useQuery(api.quickReplies.list, open ? { organizationId } : "skip");
  const createReply = useMutation(api.quickReplies.create);
  const updateReply = useMutation(api.quickReplies.update);
  const removeReply = useMutation(api.quickReplies.remove);

  const [editing, setEditing] = useState<QuickReplyItem | "new" | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = (item: QuickReplyItem | "new") => {
    setEditing(item);
    setShortcut(item === "new" ? "" : item.shortcut);
    setContent(item === "new" ? "" : item.content);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (editing === "new") {
        await createReply({ organizationId, shortcut, content });
        toast.success("Resposta rápida criada");
      } else if (editing) {
        await updateReply({ quickReplyId: editing._id, shortcut, content });
        toast.success("Resposta rápida atualizada");
      }
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message.replace(/^.*Uncaught Error: /, "").split("\n")[0] : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: QuickReplyItem) => {
    try {
      await removeReply({ quickReplyId: item._id });
      toast.success(`/${item.shortcut} excluída`);
    } catch {
      toast.error("Falha ao excluir");
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Respostas rápidas">
      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          Digite <span className="font-mono text-text-secondary">/</span> no campo de mensagem para
          usar. O atalho filtra a lista.
        </p>

        {editing !== null ? (
          <div className="space-y-3 p-3 rounded-xl border border-border bg-surface-sunken">
            <Input
              label="Atalho"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder="saudacao"
            />
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Mensagem</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={4}
                placeholder="Olá! Obrigado pelo contato..."
                className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || !shortcut.trim() || !content.trim()}
              >
                {editing === "new" ? "Criar" : "Salvar"}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => startEdit("new")}>
            <Plus size={14} />
            Nova resposta rápida
          </Button>
        )}

        <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
          {replies === undefined ? (
            <div className="p-4 text-center text-xs text-text-muted">Carregando…</div>
          ) : replies.length === 0 ? (
            <div className="p-4 text-center text-xs text-text-muted">
              Nenhuma resposta rápida ainda
            </div>
          ) : (
            replies.map((item) => (
              <div key={item._id} className="flex items-start gap-2 p-3 bg-surface-raised">
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-semibold text-text-primary">/{item.shortcut}</span>
                  <p className="text-xs text-text-secondary line-clamp-2">{item.content}</p>
                </div>
                <button
                  type="button"
                  onClick={() => startEdit(item)}
                  className="shrink-0 p-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
                  aria-label={`Editar /${item.shortcut}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(item)}
                  className="shrink-0 p-1.5 rounded-full text-text-muted hover:text-semantic-error hover:bg-surface-overlay transition-colors"
                  aria-label={`Excluir /${item.shortcut}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
