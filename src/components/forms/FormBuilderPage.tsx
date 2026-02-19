import { useState, useEffect, useRef, useCallback } from "react";
import { useOutletContext, useNavigate, useParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldPalette } from "@/components/forms/builder/FieldPalette";
import { FieldCanvas } from "@/components/forms/builder/FieldCanvas";
import { FieldConfigPanel } from "@/components/forms/builder/FieldConfigPanel";
import { FormSettingsPanel } from "@/components/forms/builder/FormSettingsPanel";
import { ThemePanel } from "@/components/forms/builder/ThemePanel";
import { PublishDialog } from "@/components/forms/builder/PublishDialog";
import { FormRenderer } from "@/components/forms/renderer/FormRenderer";
import type { FormField, FormTheme, FormSettings } from "@/components/forms/builder/types";
import {
  ArrowLeft,
  Save,
  MoreVertical,
  Globe,
  GlobeLock,
  Trash2,
  Smartphone,
  Monitor,
  Pencil,
  Check,
} from "lucide-react";

// ── Default values ────────────────────────────────────────────────────────────

const DEFAULT_THEME: FormTheme = {
  primaryColor: "#EA580C",
  backgroundColor: "#18181B",
  textColor: "#FAFAFA",
  borderRadius: "md",
  showBranding: true,
};

const DEFAULT_SETTINGS: FormSettings = {
  submitButtonText: "Enviar",
  successMessage: "Obrigado! Sua resposta foi recebida com sucesso.",
  notifyOnSubmission: false,
  leadTitle: "Lead via formulario",
  assignmentMode: "none",
  defaultPriority: "medium",
  defaultTemperature: "warm",
  tags: [],
  honeypotEnabled: true,
};

// Map field type → default label (PT-BR)
const DEFAULT_LABELS: Record<FormField["type"], string> = {
  text: "Texto",
  email: "Email",
  phone: "Telefone",
  number: "Numero",
  select: "Selecao",
  textarea: "Mensagem",
  checkbox: "Caixa de selecao",
  date: "Data",
};

// Generate an 8-char alphanumeric ID
function genFieldId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function createNewField(type: FormField["type"]): FormField {
  return {
    id: genFieldId(),
    type,
    label: DEFAULT_LABELS[type],
    isRequired: false,
    width: "full",
    ...(type === "select" ? { options: ["Opcao 1", "Opcao 2"] } : {}),
  };
}

// ── Status helpers ────────────────────────────────────────────────────────────

type FormStatus = "draft" | "published" | "archived";

function statusBadge(status: FormStatus) {
  switch (status) {
    case "published":
      return { label: "Publicado", variant: "success" as const };
    case "archived":
      return { label: "Arquivado", variant: "default" as const };
    default:
      return { label: "Rascunho", variant: "warning" as const };
  }
}

// ── Editable title ────────────────────────────────────────────────────────────

interface EditableTitleProps {
  value: string;
  onChange: (v: string) => void;
}

function EditableTitle({ value, onChange }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed) onChange(trimmed);
    else setDraft(value);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={cn(
          "bg-transparent border-b border-brand-500 text-text-primary font-semibold",
          "text-base md:text-lg focus:outline-none w-full max-w-[240px] md:max-w-xs"
        )}
        aria-label="Nome do formulario"
      />
    );
  }

  return (
    <button
      onClick={() => { setDraft(value); setEditing(true); }}
      aria-label="Editar nome do formulario"
      className={cn(
        "group flex items-center gap-1.5 max-w-[200px] md:max-w-xs",
        "text-base md:text-lg font-semibold text-text-primary truncate",
        "hover:text-brand-400 transition-colors focus:outline-none",
        "focus:ring-2 focus:ring-brand-500 rounded"
      )}
    >
      <span className="truncate">{value}</span>
      <Pencil
        size={14}
        className="shrink-0 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </button>
  );
}

// ── Header three-dot menu ─────────────────────────────────────────────────────

interface HeaderMenuProps {
  status: FormStatus;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
}

function HeaderMenu({ status, onPublish, onUnpublish, onDelete }: HeaderMenuProps) {
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
        onClick={() => setOpen((v) => !v)}
        aria-label="Mais opcoes"
        className={cn(
          "p-2 rounded-full min-w-[44px] min-h-[44px] flex items-center justify-center",
          "text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
        )}
      >
        <MoreVertical size={20} />
      </button>

      {open && (
        <div
          className={cn(
            "absolute right-0 top-full mt-1 z-30 w-52",
            "bg-surface-overlay border border-border rounded-xl shadow-elevated",
            "py-1 animate-fade-in-up"
          )}
        >
          {status !== "published" && (
            <MenuItemRow
              icon={<Globe size={16} />}
              label="Publicar"
              onClick={() => { setOpen(false); onPublish(); }}
            />
          )}
          {status === "published" && (
            <MenuItemRow
              icon={<GlobeLock size={16} />}
              label="Despublicar"
              onClick={() => { setOpen(false); onUnpublish(); }}
            />
          )}
          <div className="my-1 border-t border-border-subtle" />
          <MenuItemRow
            icon={<Trash2 size={16} />}
            label="Excluir formulario"
            onClick={() => { setOpen(false); onDelete(); }}
            danger
          />
        </div>
      )}
    </div>
  );
}

function MenuItemRow({
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

// ── Editor tab bar ────────────────────────────────────────────────────────────

type EditorTab = "campos" | "configuracoes" | "tema";

const EDITOR_TABS: { key: EditorTab; label: string }[] = [
  { key: "campos", label: "Campos" },
  { key: "configuracoes", label: "Configuracoes" },
  { key: "tema", label: "Tema" },
];

// ── Main component ────────────────────────────────────────────────────────────

export function FormBuilderPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { formId } = useParams<{ formId: string }>();

  // ── Remote data ─────────────────────────────────────────────────────────────
  const form = useQuery(
    api.forms.getForm,
    formId ? { formId: formId as Id<"forms"> } : "skip"
  );

  const updateForm = useMutation(api.forms.updateForm);
  const publishForm = useMutation(api.forms.publishForm);
  const unpublishForm = useMutation(api.forms.unpublishForm);
  const deleteForm = useMutation(api.forms.deleteForm);

  // ── Local editor state ───────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [description, setDescription] = useState<string | undefined>(undefined);
  const [slug, setSlug] = useState<string | undefined>(undefined);
  const [fields, setFields] = useState<FormField[]>([]);
  const [theme, setTheme] = useState<FormTheme>(DEFAULT_THEME);
  const [settings, setSettings] = useState<FormSettings>(DEFAULT_SETTINGS);

  // Track what the server last gave us (for dirty detection)
  const serverStateRef = useRef({
    name: "",
    description: undefined as string | undefined,
    slug: undefined as string | undefined,
    fields: [] as FormField[],
    theme: DEFAULT_THEME,
    settings: DEFAULT_SETTINGS,
  });

  const [initialized, setInitialized] = useState(false);

  // Sync local state from fetched form (only once on first load)
  useEffect(() => {
    if (form === undefined || form === null || initialized) return;
    setName(form.name ?? "");
    setDescription(form.description);
    setSlug(form.slug);
    setFields((form.fields as FormField[]) ?? []);
    setTheme((form.theme as FormTheme) ?? DEFAULT_THEME);
    setSettings((form.settings as FormSettings) ?? DEFAULT_SETTINGS);
    serverStateRef.current = {
      name: form.name ?? "",
      description: form.description,
      slug: form.slug,
      fields: (form.fields as FormField[]) ?? [],
      theme: (form.theme as FormTheme) ?? DEFAULT_THEME,
      settings: (form.settings as FormSettings) ?? DEFAULT_SETTINGS,
    };
    setInitialized(true);
  }, [form, initialized]);

  // ── Dirty tracking ───────────────────────────────────────────────────────────
  const isDirty =
    initialized &&
    (name !== serverStateRef.current.name ||
      description !== serverStateRef.current.description ||
      slug !== serverStateRef.current.slug ||
      JSON.stringify(fields) !== JSON.stringify(serverStateRef.current.fields) ||
      JSON.stringify(theme) !== JSON.stringify(serverStateRef.current.theme) ||
      JSON.stringify(settings) !== JSON.stringify(serverStateRef.current.settings));

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [editorTab, setEditorTab] = useState<EditorTab>("campos");
  const [mobileTab, setMobileTab] = useState<"editar" | "visualizar">("editar");
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [previewDevice, setPreviewDevice] = useState<"mobile" | "desktop">("mobile");
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // ── Field actions ─────────────────────────────────────────────────────────────
  const handleAddField = useCallback((type: FormField["type"]) => {
    const newField = createNewField(type);
    setFields((prev) => [...prev, newField]);
    setSelectedFieldId(newField.id);
    // Switch to editor tab if not already there
    setEditorTab("campos");
  }, []);

  const handleDeleteField = useCallback((id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    setSelectedFieldId((prev) => (prev === id ? null : prev));
  }, []);

  const handleReorderFields = useCallback((reordered: FormField[]) => {
    setFields(reordered);
  }, []);

  const handleFieldChange = useCallback((updated: FormField) => {
    setFields((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
  }, []);

  // ── Save ──────────────────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    if (!formId || !isDirty) return;
    setIsSaving(true);
    toast.promise(
      updateForm({
        formId: formId as Id<"forms">,
        name,
        description,
        slug,
        fields: fields as Parameters<typeof updateForm>[0]["fields"],
        theme: theme as Parameters<typeof updateForm>[0]["theme"],
        settings: settings as Parameters<typeof updateForm>[0]["settings"],
      }).then(() => {
        // Update server ref so dirty state resets
        serverStateRef.current = { name, description, slug, fields, theme, settings };
      }).finally(() => setIsSaving(false)),
      {
        loading: "Salvando...",
        success: "Formulario salvo!",
        error: "Erro ao salvar formulario",
      }
    );
  }, [formId, isDirty, name, description, slug, fields, theme, settings, updateForm]);

  // ── Publish / Unpublish ───────────────────────────────────────────────────────
  const handlePublish = useCallback(() => {
    if (!formId) return;
    // Save first if dirty
    if (isDirty) {
      updateForm({
        formId: formId as Id<"forms">,
        name, description, slug,
        fields: fields as Parameters<typeof updateForm>[0]["fields"],
        theme: theme as Parameters<typeof updateForm>[0]["theme"],
        settings: settings as Parameters<typeof updateForm>[0]["settings"],
      }).then(() => {
        serverStateRef.current = { name, description, slug, fields, theme, settings };
        setShowPublishDialog(true);
      });
    } else {
      setShowPublishDialog(true);
    }
  }, [formId, isDirty, name, description, slug, fields, theme, settings, updateForm]);

  const handleUnpublish = useCallback(() => {
    if (!formId) return;
    toast.promise(unpublishForm({ formId: formId as Id<"forms"> }), {
      loading: "Despublicando...",
      success: "Formulario despublicado!",
      error: "Erro ao despublicar",
    });
  }, [formId, unpublishForm]);

  // ── Delete ────────────────────────────────────────────────────────────────────
  const handleDelete = useCallback(() => {
    if (!formId) return;
    toast.promise(
      deleteForm({ formId: formId as Id<"forms"> }).then(() => {
        navigate("/app/formularios");
      }),
      {
        loading: "Excluindo formulario...",
        success: "Formulario excluido!",
        error: "Erro ao excluir formulario",
      }
    );
    setShowDeleteConfirm(false);
  }, [formId, deleteForm, navigate]);

  // ── Loading / not-found ───────────────────────────────────────────────────────
  if (form === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface-base">
        <Spinner size="lg" />
      </div>
    );
  }

  if (form === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-surface-base gap-4">
        <p className="text-text-secondary">Formulario nao encontrado.</p>
        <Button variant="secondary" onClick={() => navigate("/app/formularios")}>
          <ArrowLeft size={18} />
          Voltar para formularios
        </Button>
      </div>
    );
  }

  const { label: statusLabel, variant: statusVariant } = statusBadge(form.status as FormStatus);
  const selectedField = fields.find((f) => f.id === selectedFieldId) ?? null;

  // ── Shared preview ────────────────────────────────────────────────────────────
  const previewPane = (
    <div className="flex flex-col h-full">
      {/* Device toggle (desktop only) */}
      <div className="hidden md:flex items-center justify-center gap-1 py-3 border-b border-border-subtle shrink-0">
        <button
          onClick={() => setPreviewDevice("mobile")}
          aria-label="Visualizar versao mobile"
          className={cn(
            "p-2 rounded-lg transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center",
            previewDevice === "mobile"
              ? "bg-brand-500/10 text-brand-500"
              : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
          )}
        >
          <Smartphone size={18} />
        </button>
        <button
          onClick={() => setPreviewDevice("desktop")}
          aria-label="Visualizar versao desktop"
          className={cn(
            "p-2 rounded-lg transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center",
            previewDevice === "desktop"
              ? "bg-brand-500/10 text-brand-500"
              : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
          )}
        >
          <Monitor size={18} />
        </button>
      </div>

      {/* Preview frame */}
      <div className="flex-1 overflow-y-auto bg-surface-sunken p-4 md:p-6">
        <div
          className={cn(
            "mx-auto transition-all duration-300",
            previewDevice === "mobile" ? "max-w-sm" : "max-w-full"
          )}
        >
          <FormRenderer
            form={{ name, description, fields, theme, settings }}
            isPreview={true}
          />
        </div>
      </div>
    </div>
  );

  // ── Editor content ────────────────────────────────────────────────────────────
  const editorContent = (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Editor tab bar */}
      <div className="flex shrink-0 border-b border-border bg-surface-raised">
        {EDITOR_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setEditorTab(tab.key)}
            className={cn(
              "flex-1 py-3 text-sm font-medium transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500",
              editorTab === tab.key
                ? "text-brand-500 border-b-2 border-brand-500"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {editorTab === "campos" && (
          <div className="flex flex-col h-full">
            {/* Field palette */}
            <div className="border-b border-border-subtle p-4">
              <FieldPalette onAddField={handleAddField} />
            </div>

            {/* Canvas */}
            <div className="flex-1 overflow-y-auto p-4">
              <FieldCanvas
                fields={fields}
                selectedFieldId={selectedFieldId}
                onSelectField={setSelectedFieldId}
                onDeleteField={handleDeleteField}
                onReorderFields={handleReorderFields}
              />
            </div>

            {/* Config panel for selected field */}
            {selectedField && (
              <div className="border-t border-border bg-surface-overlay">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle">
                  <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Configurar campo
                  </span>
                  <button
                    onClick={() => setSelectedFieldId(null)}
                    aria-label="Fechar configuracao do campo"
                    className={cn(
                      "p-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised",
                      "transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center"
                    )}
                  >
                    <Check size={16} />
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <FieldConfigPanel
                    field={selectedField}
                    onChange={handleFieldChange}
                    organizationId={organizationId}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {editorTab === "configuracoes" && (
          <div className="p-4">
            <FormSettingsPanel
              settings={settings}
              onChange={setSettings}
              organizationId={organizationId}
            />
          </div>
        )}

        {editorTab === "tema" && (
          <div className="p-4">
            <ThemePanel theme={theme} onChange={setTheme} />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-screen bg-surface-base overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-2 px-3 py-2 md:px-4 md:py-3 border-b border-border bg-surface-raised shrink-0">
        {/* Back */}
        <button
          onClick={() => navigate("/app/formularios")}
          aria-label="Voltar para formularios"
          className={cn(
            "p-2 rounded-full min-w-[44px] min-h-[44px] flex items-center justify-center",
            "text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised"
          )}
        >
          <ArrowLeft size={20} />
        </button>

        {/* Title + badge */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <EditableTitle value={name} onChange={setName} />
          <Badge variant={statusVariant} className="hidden sm:inline-flex shrink-0">
            {statusLabel}
          </Badge>
          {isDirty && (
            <span
              className="hidden sm:inline text-xs text-text-muted"
              aria-live="polite"
            >
              Nao salvo
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant={isDirty ? "primary" : "secondary"}
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            aria-label="Salvar formulario"
          >
            <Save size={16} />
            <span className="hidden sm:inline">
              {isSaving ? "Salvando..." : "Salvar"}
            </span>
          </Button>

          <HeaderMenu
            status={form.status as FormStatus}
            onPublish={handlePublish}
            onUnpublish={handleUnpublish}
            onDelete={() => setShowDeleteConfirm(true)}
          />
        </div>
      </header>

      {/* ── Mobile tab switcher (Editar | Visualizar) ────────────────────── */}
      <div className="flex md:hidden shrink-0 border-b border-border bg-surface-raised">
        {(["editar", "visualizar"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setMobileTab(tab)}
            className={cn(
              "flex-1 py-2.5 text-sm font-medium capitalize transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500",
              mobileTab === tab
                ? "text-brand-500 border-b-2 border-brand-500"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {tab === "editar" ? "Editar" : "Visualizar"}
          </button>
        ))}
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">

        {/* ── Mobile: single pane ─────────────────────────────────────────── */}
        <div className="flex md:hidden flex-col flex-1 min-w-0 overflow-hidden">
          {mobileTab === "editar" ? editorContent : previewPane}
        </div>

        {/* ── Desktop: split pane ─────────────────────────────────────────── */}
        <div className="hidden md:flex flex-1 min-w-0 overflow-hidden">
          {/* Editor — 60% */}
          <div className="flex flex-col border-r border-border overflow-hidden" style={{ flex: "0 0 60%" }}>
            {editorContent}
          </div>

          {/* Preview — 40% */}
          <div className="flex flex-col overflow-hidden" style={{ flex: "0 0 40%" }}>
            {previewPane}
          </div>
        </div>
      </div>

      {/* ── Publish Dialog ───────────────────────────────────────────────────── */}
      <PublishDialog
        open={showPublishDialog}
        onClose={() => setShowPublishDialog(false)}
        form={form}
        onPublish={async () => {
          await publishForm({ formId: formId as Id<"forms"> });
        }}
        onUnpublish={async () => {
          await unpublishForm({ formId: formId as Id<"forms"> });
        }}
      />

      {/* ── Delete Confirm ───────────────────────────────────────────────────── */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Excluir formulario"
        description={`Tem certeza que deseja excluir "${name}"? Esta acao nao pode ser desfeita.`}
        confirmLabel="Excluir"
        cancelLabel="Cancelar"
        variant="danger"
      />
    </div>
  );
}
