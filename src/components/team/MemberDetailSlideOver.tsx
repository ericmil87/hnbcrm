import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PermissionsEditor } from "./PermissionsEditor";
import {
  type Permissions,
  type Role,
  DEFAULT_PERMISSIONS,
  resolvePermissions,
} from "../../../convex/lib/permissions";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { isPendingMember } from "@/lib/teamMembers";
import { WizardInviteResults, type InviteOutcome } from "@/components/onboarding/WizardInviteResults";
import {
  Pencil, Trash2, RotateCcw, Save, X,
  Key, Plus, Copy, Check, Eye, EyeOff, ShieldAlert, Ban, RefreshCw,
  Send,
} from "lucide-react";

interface TeamMember {
  _id: Id<"teamMembers">;
  name: string;
  email?: string;
  role: string;
  type: string;
  status: string;
  /** Vínculo com a org encerrado (backend: `removedAt` ou `status` legado). */
  removed?: boolean;
  userId?: Id<"users"> | null;
  pending?: boolean;
  capabilities?: string[];
  permissions?: Permissions | null;
  mustChangePassword?: boolean;
  invitedBy?: Id<"teamMembers"> | null;
  avatarFileId?: Id<"files"> | null;
  avatarUrl?: string | null;
  createdAt: number;
}

interface MemberDetailSlideOverProps {
  open: boolean;
  onClose: () => void;
  member: TeamMember | null;
  organizationId: Id<"organizations">;
  /** Whether the current user has team manage permission */
  canManage: boolean;
  /** The current user's member id (to prevent self-removal) */
  currentMemberId?: Id<"teamMembers">;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Gerente",
  agent: "Agente",
  ai: "IA",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Ativo",
  busy: "Ocupado",
  inactive: "Removido",
  pending: "Convite antigo",
};

export function MemberDetailSlideOver({
  open,
  onClose,
  member,
  organizationId,
  canManage,
  currentMemberId,
}: MemberDetailSlideOverProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<Role>("agent");
  const [editPermissions, setEditPermissions] = useState<Permissions>(DEFAULT_PERMISSIONS.agent);
  const [customPermissions, setCustomPermissions] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  // API key state (for AI agents)
  const [showNewKey, setShowNewKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [revokeKeyId, setRevokeKeyId] = useState<Id<"apiKeys"> | null>(null);

  const updateMember = useMutation(api.teamMembers.updateTeamMember);
  const updateMemberAvatar = useMutation(api.teamMembers.updateMemberAvatar);
  const removeMember = useMutation(api.teamMembers.removeTeamMember);
  const reactivateMember = useMutation(api.teamMembers.reactivateTeamMember);
  const inviteHuman = useAction(api.nodeActions.inviteHumanMember);
  const [isResending, setIsResending] = useState(false);
  // Resultado do reenvio (tem senha temporária) — só em memória.
  const [resendOutcome, setResendOutcome] = useState<InviteOutcome | null>(null);
  const createApiKeyAction = useAction(api.nodeActions.createApiKey);
  const revokeApiKeyMutation = useMutation(api.apiKeys.revokeApiKey);

  // Fetch API keys for AI agents
  const apiKeys = useQuery(
    api.apiKeys.getApiKeysForMember,
    member && member.type === "ai"
      ? { organizationId, teamMemberId: member._id }
      : "skip"
  );

  if (!member) return null;

  const isSelf = currentMemberId === member._id;
  const isInactive = member.removed === true || member.status === "inactive";
  // Convite antigo sem conta — só vira acesso se o convite for reenviado.
  const isPending = !isInactive && isPendingMember(member);
  const displayStatus = isInactive ? "inactive" : isPending ? "pending" : member.status;
  const resolvedPermissions = resolvePermissions(
    member.role as Role,
    member.permissions as Permissions | undefined
  );

  const startEditing = () => {
    setEditName(member.name);
    setEditRole(member.role as Role);
    const hasCustom = !!member.permissions;
    setCustomPermissions(hasCustom);
    setEditPermissions(
      hasCustom
        ? { ...(member.permissions as Permissions) }
        : { ...DEFAULT_PERMISSIONS[member.role as Role] }
    );
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateMember({
        teamMemberId: member._id,
        name: editName.trim() || undefined,
        role: editRole !== member.role ? editRole : undefined,
        // Só reenvia permissões que MUDARAM: o servidor valida o objeto
        // inteiro contra as permissões de quem edita, e reenviar as antigas
        // (dadas por um admin) impedia um gerente de só renomear o membro.
        permissions:
          customPermissions &&
          JSON.stringify(editPermissions) !== JSON.stringify(member.permissions ?? null)
            ? editPermissions
            : undefined,
      });
      toast.success("Membro atualizado!");
      setIsEditing(false);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao atualizar membro."));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    try {
      await removeMember({ teamMemberId: member._id });
      toast.success("Membro removido.");
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao remover membro."));
    }
  };

  const handleResendInvite = async () => {
    if (!member.email) return;
    setIsResending(true);
    try {
      const result = await inviteHuman({
        organizationId,
        name: member.name,
        email: member.email,
        role: member.role === "admin" || member.role === "manager" ? member.role : "agent",
      });
      const kind = result.isNewUser ? "new" : result.reactivated ? "reactivated" : "existing";
      setResendOutcome({
        key: member._id,
        name: member.name,
        email: member.email,
        kind,
        tempPassword: result.tempPassword,
        emailSent: result.emailSent,
        pendingPasswordChange: !result.isNewUser && result.pendingPasswordChange,
      });
      toast.success(
        kind === "new" ? "Convite reenviado." : `${member.name} já tinha conta e entrou na organização.`
      );
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao reenviar convite."));
    } finally {
      setIsResending(false);
    }
  };

  const handleReactivate = async () => {
    try {
      await reactivateMember({ teamMemberId: member._id });
      toast.success("Membro reativado!");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao reativar membro."));
    }
  };

  const handleRoleChange = (newRole: Role) => {
    setEditRole(newRole);
    if (!customPermissions) {
      setEditPermissions(DEFAULT_PERMISSIONS[newRole]);
    }
  };

  const handleCreateApiKey = async () => {
    if (!newKeyName.trim()) return;
    setCreatingKey(true);
    try {
      const result = await createApiKeyAction({
        organizationId,
        teamMemberId: member._id,
        name: newKeyName.trim(),
      });
      setNewKeyValue(result.apiKey);
      setNewKeyName("");
      toast.success("Chave API criada!");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao criar chave API."));
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeApiKey = async () => {
    if (!revokeKeyId) return;
    try {
      await revokeApiKeyMutation({ apiKeyId: revokeKeyId, organizationId });
      toast.success("Chave API revogada!");
      setRevokeKeyId(null);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao revogar chave."));
    }
  };

  const handleCopyKey = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setKeyCopied(true);
    toast.success("Copiado!");
    setTimeout(() => setKeyCopied(false), 2000);
  };

  const handleCloseNewKey = () => {
    setNewKeyValue(null);
    setKeyRevealed(false);
    setKeyCopied(false);
    setShowNewKey(false);
  };

  const slugify = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "admin": return "brand" as const;
      case "manager": return "info" as const;
      case "agent": return "success" as const;
      case "ai": return "warning" as const;
      default: return "default" as const;
    }
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "active": return "success" as const;
      case "busy": return "warning" as const;
      case "inactive": return "error" as const;
      default: return "default" as const;
    }
  };

  return (
    <>
      <SlideOver open={open} onClose={onClose} title="Detalhes do Membro">
        <div className="p-4 md:p-6 space-y-6">
          {/* Member header */}
          <div className="flex items-center gap-4">
            <AvatarUpload
              currentPhotoUrl={member.avatarUrl}
              initials={member.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)}
              organizationId={organizationId}
              fileType="member_avatar"
              teamMemberId={member._id}
              onPhotoChange={(fileId) => {
                updateMemberAvatar({ teamMemberId: member._id, avatarFileId: fileId });
              }}
              disabled={!canManage && currentMemberId !== member._id}
              size="lg"
            />
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Nome do membro"
                />
              ) : (
                <>
                  <h3 className="text-lg font-semibold text-text-primary truncate">
                    {member.name}
                  </h3>
                  {member.email && (
                    <p className="text-sm text-text-secondary truncate">
                      {member.email}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Info badges */}
          <div className="flex flex-wrap gap-2">
            <Badge variant={getRoleBadgeVariant(isEditing ? editRole : member.role)}>
              {ROLE_LABELS[isEditing ? editRole : member.role] || member.role}
            </Badge>
            <Badge variant={member.type === "ai" ? "warning" : "info"}>
              {member.type === "ai" ? "IA" : "Humano"}
            </Badge>
            <Badge variant={getStatusBadgeVariant(displayStatus)}>
              {STATUS_LABELS[displayStatus] || displayStatus}
            </Badge>
          </div>

          {/* Role selector (edit mode, human only) */}
          {isEditing && member.type === "human" && (
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Função
              </label>
              <div className="flex flex-wrap gap-2">
                {(["agent", "manager", "admin"] as Role[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => handleRoleChange(r)}
                    className={cn(
                      "px-3 py-2 rounded-full text-sm font-medium transition-colors min-h-[44px]",
                      editRole === r
                        ? "bg-brand-500 text-white"
                        : "bg-surface-raised text-text-secondary hover:bg-surface-overlay border border-border-subtle"
                    )}
                  >
                    {ROLE_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Permissions section */}
          {isEditing ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-secondary">
                  Personalizar permissoes
                </span>
                <button
                  type="button"
                  onClick={() => setCustomPermissions(!customPermissions)}
                  className={cn(
                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                    customPermissions ? "bg-brand-500" : "bg-surface-overlay border border-border-strong"
                  )}
                  role="switch"
                  aria-checked={customPermissions}
                >
                  <span
                    className={cn(
                      "inline-block h-4 w-4 rounded-full bg-white transition-transform",
                      customPermissions ? "translate-x-6" : "translate-x-1"
                    )}
                  />
                </button>
              </div>

              <PermissionsEditor
                value={editPermissions}
                onChange={setEditPermissions}
                role={editRole}
                disabled={!customPermissions}
              />
            </div>
          ) : (
            <div>
              <PermissionsEditor
                value={resolvedPermissions}
                onChange={() => {}}
                role={member.role as Role}
                disabled
              />
            </div>
          )}

          {/* API Keys section (AI agents only) */}
          {member.type === "ai" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Key size={16} className="text-brand-500" />
                  <span className="text-sm font-semibold text-text-primary">Chaves API</span>
                </div>
                {canManage && !newKeyValue && (
                  <button
                    type="button"
                    onClick={() => {
                      setNewKeyName(slugify(member.name));
                      setShowNewKey(true);
                    }}
                    className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:text-brand-400 transition-colors"
                  >
                    <Plus size={14} />
                    Nova Chave
                  </button>
                )}
              </div>

              {/* New key creation form */}
              {showNewKey && !newKeyValue && (
                <div className="p-3 bg-surface-sunken rounded-lg border border-border space-y-3">
                  <Input
                    label="Nome da Chave"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder={slugify(member.name)}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { setShowNewKey(false); setNewKeyName(""); }}
                      className="flex-1"
                    >
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleCreateApiKey}
                      disabled={creatingKey || !newKeyName.trim()}
                      className="flex-1"
                    >
                      {creatingKey ? "Criando..." : "Criar Chave"}
                    </Button>
                  </div>
                </div>
              )}

              {/* Newly created key reveal */}
              {newKeyValue && (
                <div className="p-3 bg-surface-sunken rounded-lg border border-semantic-success/30 space-y-3">
                  <div className="flex items-center gap-2 text-semantic-success">
                    <Check size={16} />
                    <span className="text-sm font-medium">Chave criada!</span>
                  </div>
                  <div className="flex items-center gap-2 bg-surface-base border border-border rounded-lg p-2">
                    <code className="flex-1 text-xs font-mono text-text-primary break-all select-all">
                      {keyRevealed ? newKeyValue : newKeyValue.slice(0, 10) + "\u2022".repeat(20) + newKeyValue.slice(-4)}
                    </code>
                    <button
                      onClick={() => setKeyRevealed(!keyRevealed)}
                      className="flex-shrink-0 p-1 rounded text-text-muted hover:text-text-primary transition-colors"
                    >
                      {keyRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleCopyKey(newKeyValue)}
                    className="w-full"
                  >
                    {keyCopied ? <Check size={14} /> : <Copy size={14} />}
                    {keyCopied ? "Copiada!" : "Copiar Chave"}
                  </Button>
                  <div className="flex gap-2 items-start text-xs text-semantic-warning bg-semantic-warning/5 border border-semantic-warning/20 rounded-lg p-2">
                    <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" />
                    <span>Salve em local seguro. Não será exibida novamente.</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleCloseNewKey}
                    className="w-full"
                  >
                    Fechar
                  </Button>
                </div>
              )}

              {/* Existing keys list */}
              {apiKeys && apiKeys.length > 0 && !newKeyValue && (
                <div className="space-y-2">
                  {apiKeys.map((key: any) => (
                    <div
                      key={key._id}
                      className={cn(
                        "flex items-center justify-between p-2.5 rounded-lg border",
                        key.isActive
                          ? "bg-surface-sunken border-border"
                          : "bg-surface-sunken/50 border-border-subtle opacity-60"
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary truncate">
                            {key.name}
                          </span>
                          {!key.isActive && (
                            <Badge variant="error">Revogada</Badge>
                          )}
                          {key.expiresAt && key.expiresAt < Date.now() && key.isActive && (
                            <Badge variant="warning">Expirada</Badge>
                          )}
                        </div>
                        <p className="text-xs text-text-muted mt-0.5">
                          Criada em {new Date(key.createdAt).toLocaleDateString("pt-BR")}
                          {key.lastUsed && (
                            <> · Usada {new Date(key.lastUsed).toLocaleDateString("pt-BR")}</>
                          )}
                        </p>
                      </div>
                      {canManage && key.isActive && (
                        <button
                          onClick={() => setRevokeKeyId(key._id)}
                          className="flex-shrink-0 p-1.5 rounded-md text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors"
                          title="Revogar chave"
                        >
                          <Ban size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {apiKeys && apiKeys.length === 0 && !showNewKey && !newKeyValue && (
                <p className="text-xs text-text-muted text-center py-2">
                  Nenhuma chave API criada.
                </p>
              )}
            </div>
          )}

          {/* Metadata */}
          <div className="text-xs text-text-muted space-y-1 pt-2 border-t border-border-subtle">
            <p>
              Criado em{" "}
              {new Date(member.createdAt).toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "long",
                year: "numeric",
              })}
            </p>
            {member.mustChangePassword && (
              <p className="text-semantic-warning">
                Aguardando troca de senha
              </p>
            )}
          </div>

          {/* Action buttons */}
          {canManage && (
            <div className="space-y-2 pt-2">
              {isEditing ? (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={cancelEditing}
                    className="flex-1"
                  >
                    <X size={16} />
                    Cancelar
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex-1"
                  >
                    <Save size={16} />
                    {isSaving ? "Salvando..." : "Salvar"}
                  </Button>
                </div>
              ) : (
                <>
                  {isPending && (
                    <div className="space-y-2 p-3 rounded-lg bg-surface-sunken border border-border">
                      <p className="text-sm text-text-secondary">
                        Convite antigo: esta pessoa ainda não tem acesso. Reenvie o convite para
                        criar a conta (ou vincular a conta que já existe), ou remova o membro.
                      </p>
                      <Button
                        variant="primary"
                        onClick={handleResendInvite}
                        disabled={isResending || !member.email}
                        className="w-full"
                      >
                        <Send size={16} />
                        {isResending ? "Enviando..." : "Reenviar convite"}
                      </Button>
                    </div>
                  )}
                  {resendOutcome && <WizardInviteResults outcomes={[resendOutcome]} />}

                  <Button
                    variant="secondary"
                    onClick={startEditing}
                    className="w-full"
                  >
                    <Pencil size={16} />
                    Editar Membro
                  </Button>

                  {isInactive ? (
                    <Button
                      variant="ghost"
                      onClick={handleReactivate}
                      className="w-full"
                    >
                      <RotateCcw size={16} />
                      Reativar Membro
                    </Button>
                  ) : (
                    !isSelf && (
                      <Button
                        variant="danger"
                        onClick={() => setShowRemoveConfirm(true)}
                        className="w-full"
                      >
                        <Trash2 size={16} />
                        Remover Membro
                      </Button>
                    )
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </SlideOver>

      <ConfirmDialog
        open={showRemoveConfirm}
        onClose={() => setShowRemoveConfirm(false)}
        onConfirm={handleRemove}
        title="Remover Membro"
        description={`Remover ${member.name} da equipe? O acesso a esta organização (e às chaves API do membro) é cortado na hora. O histórico fica, e dá para reativar depois.`}
        confirmLabel="Remover"
        variant="danger"
      />

      <ConfirmDialog
        open={!!revokeKeyId}
        onClose={() => setRevokeKeyId(null)}
        onConfirm={handleRevokeApiKey}
        title="Revogar Chave API"
        description="Esta ação é irreversível. Qualquer integração usando esta chave parará de funcionar imediatamente."
        confirmLabel="Revogar"
        variant="danger"
      />
    </>
  );
}
