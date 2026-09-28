import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Building2, Check, ChevronsUpDown, LogOut, Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";

/** Forma mínima de uma org da lista `getUserOrganizations` usada pela UI. */
export interface OrgSummary {
  _id: Id<"organizations">;
  name: string;
  slug: string;
  role: string;
  /**
   * Vínculo veio de convite (servidor). Só `true` gera o aviso "você foi
   * adicionado"; quem criou a org recebe `false`.
   */
  invited?: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Gerente",
  agent: "Agente",
  ai: "IA",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** `getUserOrganizations` devolve `v.any()` — normaliza para `OrgSummary[]`. */
export function toOrgSummaries(list: unknown): OrgSummary[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({
      _id: o._id as Id<"organizations">,
      name: String(o.name ?? ""),
      slug: String(o.slug ?? ""),
      role: String(o.role ?? ""),
      invited: typeof o.invited === "boolean" ? o.invited : undefined,
    }));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- Formulário de criação (usado no seletor e na tela de boas-vindas) ---

interface CreateOrganizationFormProps {
  onCreated: (orgId: Id<"organizations">) => void;
  onCancel: () => void;
  cancelLabel?: string;
}

export function CreateOrganizationForm({
  onCreated,
  onCancel,
  cancelLabel = "Cancelar",
}: CreateOrganizationFormProps) {
  const createOrganization = useMutation(api.organizations.createOrganization);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanSlug = slugify(slug);
    if (!name.trim() || !cleanSlug) return;
    setIsCreating(true);
    try {
      const orgId = await createOrganization({ name: name.trim(), slug: cleanSlug });
      toast.success(`Organização "${name.trim()}" criada!`);
      onCreated(orgId);
    } catch (error) {
      const message = mutationErrorMessage(error, "");
      toast.error(
        /slug/i.test(message)
          ? "Esse identificador já está em uso. Escolha outro."
          : "Falha ao criar organização. Tente novamente."
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Nome da organização"
        placeholder="Minha Empresa"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (!slugEdited) setSlug(slugify(e.target.value));
        }}
        autoFocus
        required
      />
      <Input
        label="Identificador (URL)"
        placeholder="minha-empresa"
        value={slug}
        onChange={(e) => {
          setSlugEdited(true);
          setSlug(e.target.value);
        }}
        required
      />
      <div className="flex gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          {cancelLabel}
        </Button>
        <Button
          type="submit"
          disabled={isCreating || !name.trim() || !slugify(slug)}
          className="flex-1"
        >
          {isCreating ? "Criando..." : "Criar"}
        </Button>
      </div>
    </form>
  );
}

// --- Modal de troca de organização ---

interface OrgSwitcherModalProps {
  open: boolean;
  onClose: () => void;
  organizations: OrgSummary[];
  activeOrgId: Id<"organizations"> | null;
  onSelectOrg: (orgId: Id<"organizations">) => void;
  /** Chamado com o id da org recém-criada (antes de selecioná-la). */
  onCreated?: (orgId: Id<"organizations">) => void;
  onSignOut?: () => void;
  /** Abre direto no formulário de criação. */
  initialMode?: "list" | "create";
}

export function OrgSwitcherModal(props: OrgSwitcherModalProps) {
  if (!props.open) return null;
  // Montado só quando aberto: o modo (lista/criação) sempre começa limpo.
  return <OrgSwitcherModalContent {...props} />;
}

function OrgSwitcherModalContent({
  onClose,
  organizations,
  activeOrgId,
  onSelectOrg,
  onCreated,
  onSignOut,
  initialMode = "list",
}: OrgSwitcherModalProps) {
  const [mode, setMode] = useState<"list" | "create">(initialMode);

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "create" ? "Nova organização" : "Suas organizações"}
    >
      {mode === "create" ? (
        <CreateOrganizationForm
          cancelLabel="Voltar"
          onCancel={() => (initialMode === "create" ? onClose() : setMode("list"))}
          onCreated={(orgId) => {
            onCreated?.(orgId);
            onSelectOrg(orgId);
            onClose();
          }}
        />
      ) : (
        <div className="space-y-2">
          <ul className="space-y-1" aria-label="Organizações">
            {organizations.map((org) => {
              const isActive = org._id === activeOrgId;
              return (
                <li key={org._id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isActive) onSelectOrg(org._id);
                      onClose();
                    }}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors min-h-[44px] border",
                      "focus:outline-none focus:ring-2 focus:ring-brand-500",
                      isActive
                        ? "border-brand-500 bg-brand-500/10"
                        : "border-transparent hover:bg-surface-raised"
                    )}
                  >
                    <span className="flex items-center justify-center h-9 w-9 rounded-lg bg-brand-500/10 shrink-0">
                      <Building2 size={18} className="text-brand-400" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-text-primary truncate">
                        {org.name}
                      </span>
                      <span className="block text-xs text-text-muted truncate">{org.slug}</span>
                    </span>
                    <Badge variant={isActive ? "brand" : "default"}>{roleLabel(org.role)}</Badge>
                    {isActive && (
                      <Check size={18} className="text-brand-500 shrink-0" aria-label="Selecionada" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={() => setMode("create")}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border-strong text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors min-h-[44px] focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <span className="flex items-center justify-center h-9 w-9 rounded-lg bg-surface-raised shrink-0">
              <Plus size={18} />
            </span>
            Nova organização
          </button>

          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors min-h-[44px] focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <span className="flex items-center justify-center h-9 w-9 shrink-0">
                <LogOut size={18} />
              </span>
              Sair
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

// --- Gatilho da sidebar ---

interface OrgSwitcherTriggerProps {
  orgName: string;
  onClick: () => void;
  className?: string;
}

/**
 * Botão que mostra a org atual e abre o seletor. Na sidebar colapsada (md,
 * 64 px) vira só o ícone — o nome inteiro fica no modal, não num select espremido.
 */
export function OrgSwitcherTrigger({ orgName, onClick, className }: OrgSwitcherTriggerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Organização: ${orgName}`}
      aria-label={`Organização atual: ${orgName}. Trocar ou criar organização`}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors min-h-[44px]",
        "text-text-secondary hover:text-text-primary hover:bg-surface-overlay",
        "focus:outline-none focus:ring-2 focus:ring-brand-500",
        className
      )}
    >
      <Building2 size={20} className="shrink-0 text-brand-500" />
      <span className="hidden lg:block flex-1 min-w-0 text-left truncate text-text-primary">
        {orgName}
      </span>
      <ChevronsUpDown size={16} className="hidden lg:block shrink-0 text-text-muted" />
    </button>
  );
}
