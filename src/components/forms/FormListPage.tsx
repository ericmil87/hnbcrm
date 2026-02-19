import { useState, useRef, useEffect } from "react";
import { useOutletContext, useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Plus,
  FileText,
  MoreVertical,
  Pencil,
  Copy,
  Archive,
  ArchiveRestore,
  Trash2,
  Send,
} from "lucide-react";

type FormDoc = {
  _id: Id<"forms">;
  name: string;
  status: "draft" | "published" | "archived";
  submissionCount?: number;
  lastSubmissionAt?: number;
};

function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 30) {
    return new Date(timestamp).toLocaleDateString("pt-BR");
  }
  if (diffDay >= 1) return `${diffDay}d atrás`;
  if (diffHour >= 1) return `${diffHour}h atrás`;
  if (diffMin >= 1) return `${diffMin}min atrás`;
  return "agora";
}

function statusLabel(status: FormDoc["status"]): { label: string; variant: "warning" | "success" | "default" } {
  switch (status) {
    case "published":
      return { label: "Publicado", variant: "success" };
    case "archived":
      return { label: "Arquivado", variant: "default" };
    default:
      return { label: "Rascunho", variant: "warning" };
  }
}

interface FormCardMenuProps {
  form: FormDoc;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function FormCardMenu({ form, onEdit, onDuplicate, onArchive, onDelete }: FormCardMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Abrir menu de acoes"
        className={cn(
          "p-2 rounded-full transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center",
          "text-text-muted hover:text-text-primary hover:bg-surface-overlay",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised"
        )}
      >
        <MoreVertical size={18} />
      </button>

      {open && (
        <div
          className={cn(
            "absolute right-0 top-full mt-1 z-20 w-48",
            "bg-surface-overlay border border-border rounded-xl shadow-elevated",
            "py-1 animate-fade-in-up"
          )}
        >
          <MenuItem
            icon={<Pencil size={16} />}
            label="Editar"
            onClick={() => { setOpen(false); onEdit(); }}
          />
          <MenuItem
            icon={<Copy size={16} />}
            label="Duplicar"
            onClick={() => { setOpen(false); onDuplicate(); }}
          />
          <MenuItem
            icon={form.status === "archived" ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            label={form.status === "archived" ? "Desarquivar" : "Arquivar"}
            onClick={() => { setOpen(false); onArchive(); }}
          />
          <div className="my-1 border-t border-border-subtle" />
          <MenuItem
            icon={<Trash2 size={16} />}
            label="Excluir"
            onClick={() => { setOpen(false); onDelete(); }}
            danger
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors min-h-[44px]",
        danger
          ? "text-semantic-error hover:bg-semantic-error/10"
          : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export function FormListPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();

  const forms = useQuery(api.forms.getForms, { organizationId });

  const createForm = useMutation(api.forms.createForm);
  const duplicateForm = useMutation(api.forms.duplicateForm);
  const archiveForm = useMutation(api.forms.archiveForm);
  const deleteForm = useMutation(api.forms.deleteForm);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFormName, setNewFormName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<FormDoc | null>(null);

  function handleCreate() {
    if (!newFormName.trim()) return;
    setIsCreating(true);
    toast.promise(
      createForm({ organizationId, name: newFormName.trim() }).then((newId) => {
        setShowCreateModal(false);
        setNewFormName("");
        navigate(`/app/formularios/${newId}`);
        return newId;
      }).finally(() => setIsCreating(false)),
      {
        loading: "Criando formulario...",
        success: "Formulario criado!",
        error: "Erro ao criar formulario",
      }
    );
  }

  function handleDuplicate(form: FormDoc) {
    toast.promise(
      duplicateForm({ formId: form._id }).then((newId) => {
        navigate(`/app/formularios/${newId}`);
        return newId;
      }),
      {
        loading: "Duplicando formulario...",
        success: "Formulario duplicado!",
        error: "Erro ao duplicar formulario",
      }
    );
  }

  function handleArchive(form: FormDoc) {
    toast.promise(archiveForm({ formId: form._id }), {
      loading:
        form.status === "archived" ? "Desarquivando..." : "Arquivando...",
      success:
        form.status === "archived"
          ? "Formulario desarquivado!"
          : "Formulario arquivado!",
      error: "Erro ao arquivar formulario",
    });
  }

  function handleDeleteConfirm() {
    if (!deleteTarget) return;
    toast.promise(deleteForm({ formId: deleteTarget._id }), {
      loading: "Excluindo formulario...",
      success: "Formulario excluido!",
      error: "Erro ao excluir formulario",
    });
    setDeleteTarget(null);
  }

  const isLoading = forms === undefined;

  return (
    <main className="min-h-screen bg-surface-base">
      <div className="max-w-6xl mx-auto px-4 py-6 md:px-6 md:py-8">

        {/* Header */}
        <header className="flex items-center justify-between mb-6 md:mb-8">
          <div>
            <h1 className="text-xl font-bold text-text-primary md:text-2xl">
              Formularios
            </h1>
            <p className="mt-0.5 text-sm text-text-secondary">
              Crie formularios para capturar leads diretamente no seu pipeline
            </p>
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={() => setShowCreateModal(true)}
            className="shrink-0"
          >
            <Plus size={18} />
            <span className="hidden sm:inline">Novo Formulario</span>
            <span className="sm:hidden">Novo</span>
          </Button>
        </header>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <Spinner size="lg" />
          </div>
        )}

        {/* Empty state */}
        {!isLoading && forms.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-border flex items-center justify-center mb-4">
              <FileText size={28} className="text-text-muted" />
            </div>
            <h2 className="text-base font-semibold text-text-primary mb-1">
              Nenhum formulario criado
            </h2>
            <p className="text-sm text-text-secondary max-w-xs mb-6">
              Crie seu primeiro formulario para comecar a capturar leads automaticamente.
            </p>
            <Button variant="primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              Criar primeiro formulario
            </Button>
          </div>
        )}

        {/* Grid */}
        {!isLoading && forms.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {forms.map((form: FormDoc) => {
              const { label, variant } = statusLabel(form.status);
              const submissionCount = form.submissionCount ?? 0;
              const lastSub = form.lastSubmissionAt;

              return (
                <article
                  key={form._id}
                  onClick={() => navigate(`/app/formularios/${form._id}`)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Editar formulario ${form.name}`}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/app/formularios/${form._id}`)}
                  className={cn(
                    "group relative flex flex-col gap-4 rounded-card p-4 md:p-5 cursor-pointer",
                    "bg-surface-raised border border-border shadow-card",
                    "hover:border-border-strong hover:shadow-card-hover transition-all duration-150",
                    "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
                  )}
                >
                  {/* Top row: name + menu */}
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-text-primary truncate leading-snug">
                        {form.name}
                      </h3>
                    </div>
                    {/* Menu sits in normal flow — stopPropagation prevents card click */}
                    <div className="relative z-10">
                      <FormCardMenu
                        form={form}
                        onEdit={() => navigate(`/app/formularios/${form._id}`)}
                        onDuplicate={() => handleDuplicate(form)}
                        onArchive={() => handleArchive(form)}
                        onDelete={() => setDeleteTarget(form)}
                      />
                    </div>
                  </div>

                  {/* Status badge */}
                  <div className="flex items-center gap-2">
                    <Badge variant={variant}>{label}</Badge>
                    {form.status === "published" && (
                      <span className="flex items-center gap-1 text-xs text-semantic-success">
                        <Send size={12} />
                        Ativo
                      </span>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
                    <span className="text-sm text-text-secondary tabular-nums">
                      <span className="font-semibold text-text-primary">
                        {submissionCount.toLocaleString("pt-BR")}
                      </span>{" "}
                      {submissionCount === 1 ? "submissao" : "submissoes"}
                    </span>
                    <span className="text-xs text-text-muted">
                      {lastSub
                        ? formatRelativeDate(lastSub)
                        : "Nenhuma"}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Modal
        open={showCreateModal}
        onClose={() => {
          if (!isCreating) {
            setShowCreateModal(false);
            setNewFormName("");
          }
        }}
        title="Novo Formulario"
      >
        <div className="space-y-4">
          <Input
            label="Nome do formulario"
            placeholder="Ex: Formulario de contato, Solicitar orcamento..."
            value={newFormName}
            onChange={(e) => setNewFormName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          <div className="flex gap-2 pt-1">
            <Button
              variant="secondary"
              onClick={() => {
                setShowCreateModal(false);
                setNewFormName("");
              }}
              className="flex-1"
              disabled={isCreating}
            >
              Cancelar
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              className="flex-1"
              disabled={!newFormName.trim() || isCreating}
            >
              {isCreating ? "Criando..." : "Criar formulario"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        title="Excluir formulario"
        description={`Tem certeza que deseja excluir "${deleteTarget?.name}"? Esta acao nao pode ser desfeita e todas as configuracoes serao perdidas.`}
        confirmLabel="Excluir"
        cancelLabel="Cancelar"
        variant="danger"
      />
    </main>
  );
}
