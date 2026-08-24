import { useState, KeyboardEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { X } from "lucide-react";
import type { FormSettings } from "./types";

interface FormSettingsPanelProps {
  settings: FormSettings;
  onChange: (settings: FormSettings) => void;
  organizationId: string;
}

// ── Shared sub-components ──────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-3 pb-2 border-b border-border-subtle">
      {children}
    </h3>
  );
}

function ToggleSwitch({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "relative flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
        checked ? "bg-brand-600" : "bg-surface-overlay border border-border-strong"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm",
          "transition-transform duration-200",
          checked ? "translate-x-4" : "translate-x-0"
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {description && (
          <p className="text-[12px] text-text-muted mt-0.5">{description}</p>
        )}
      </div>
      <ToggleSwitch checked={checked} onToggle={onToggle} label={label} />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        className={cn(
          "w-full bg-surface-raised border border-border-strong rounded-field",
          "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
          "transition-colors duration-150",
          "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
          "disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
        )}
      >
        {children}
      </select>
    </div>
  );
}

// ── Assignment mode 3-button toggle ───────────────────────────────────────

const ASSIGNMENT_OPTIONS: {
  value: FormSettings["assignmentMode"];
  label: string;
}[] = [
  { value: "none", label: "Nenhum" },
  { value: "specific", label: "Específico" },
  { value: "round_robin", label: "Rodizio" },
];

function AssignmentModeToggle({
  value,
  onChange,
}: {
  value: FormSettings["assignmentMode"];
  onChange: (v: FormSettings["assignmentMode"]) => void;
}) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
        Modo de atribuição
      </label>
      <div className="flex gap-1 p-1 rounded-lg bg-surface-sunken border border-border">
        {ASSIGNMENT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            aria-pressed={value === opt.value}
            className={cn(
              "flex-1 py-1.5 text-sm rounded-md transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 focus:ring-offset-surface-sunken",
              value === opt.value
                ? "bg-surface-raised text-text-primary font-medium shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Tag pill editor ────────────────────────────────────────────────────────

function TagEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");

  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag]);
    setInput("");
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input);
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
        Tags
      </label>
      <div
        className={cn(
          "w-full min-h-[42px] bg-surface-raised border border-border-strong rounded-field",
          "px-3 py-2 flex flex-wrap gap-1.5",
          "focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20",
          "transition-colors duration-150"
        )}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-brand-500/10 text-brand-400"
          >
            {tag}
            <button
              onClick={() => removeTag(tag)}
              aria-label={`Remover tag ${tag}`}
              className="text-brand-400/70 hover:text-brand-400 focus:outline-none"
            >
              <X size={10} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { if (input) addTag(input); }}
          placeholder={tags.length === 0 ? "formulário, site, lead" : ""}
          className="flex-1 min-w-[80px] bg-transparent text-base md:text-sm text-text-primary placeholder:text-text-muted outline-none"
        />
      </div>
      <p className="mt-1 text-[12px] text-text-muted">
        Pressione Enter ou vírgula para adicionar
      </p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function FormSettingsPanel({
  settings,
  onChange,
  organizationId,
}: FormSettingsPanelProps) {
  const orgId = organizationId as Id<"organizations">;

  const boards = useQuery(api.boards.getBoards, { organizationId: orgId });
  const stages = useQuery(
    api.boards.getStages,
    settings.boardId
      ? { boardId: settings.boardId as Id<"boards"> }
      : "skip"
  );
  const leadSources = useQuery(api.leadSources.getLeadSources, {
    organizationId: orgId,
  });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId: orgId,
  });

  function update(patch: Partial<FormSettings>) {
    onChange({ ...settings, ...patch });
  }

  const humanMembers =
    teamMembers?.filter(
      (m: any) => m.type === "human" && m.status === "active"
    ) ?? [];

  return (
    <div className="space-y-8 pb-6">
      {/* ── 1. Lead ─────────────────────────────────────────────── */}
      <section aria-label="Configurações de lead">
        <SectionHeader>Lead</SectionHeader>
        <div className="space-y-4">
          <div>
            <Input
              label="Título do lead"
              value={settings.leadTitle}
              onChange={(e) => update({ leadTitle: e.target.value })}
              placeholder="Formulário - {email}"
            />
            <p className="mt-1 text-[12px] text-text-muted">
              Variaveis: <span className="text-brand-400">{"{email}"}</span>,{" "}
              <span className="text-brand-400">{"{nome}"}</span>
            </p>
          </div>

          <SelectField
            label="Pipeline"
            value={settings.boardId ?? ""}
            onChange={(v) =>
              update({ boardId: v || undefined, stageId: undefined })
            }
          >
            <option value="">Nenhum</option>
            {boards?.map((b: any) => (
              <option key={b._id} value={b._id}>
                {b.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Estágio"
            value={settings.stageId ?? ""}
            onChange={(v) => update({ stageId: v || undefined })}
            disabled={!settings.boardId}
          >
            <option value="">Primeiro estágio</option>
            {stages?.map((s: any) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Fonte"
            value={settings.sourceId ?? ""}
            onChange={(v) => update({ sourceId: v || undefined })}
          >
            <option value="">Nenhuma</option>
            {leadSources?.map((s: any) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </SelectField>

          <AssignmentModeToggle
            value={settings.assignmentMode}
            onChange={(v) =>
              update({
                assignmentMode: v,
                assignedTo: v !== "specific" ? undefined : settings.assignedTo,
              })
            }
          />

          {settings.assignmentMode === "specific" && (
            <SelectField
              label="Atribuir a"
              value={settings.assignedTo ?? ""}
              onChange={(v) => update({ assignedTo: v || undefined })}
            >
              <option value="">Selecione um membro</option>
              {humanMembers.map((m: any) => (
                <option key={m._id} value={m._id}>
                  {m.name}
                </option>
              ))}
            </SelectField>
          )}

          <SelectField
            label="Prioridade padrão"
            value={settings.defaultPriority}
            onChange={(v) =>
              update({ defaultPriority: v as FormSettings["defaultPriority"] })
            }
          >
            <option value="low">Baixa</option>
            <option value="medium">Media</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </SelectField>

          <SelectField
            label="Temperatura padrão"
            value={settings.defaultTemperature}
            onChange={(v) =>
              update({
                defaultTemperature: v as FormSettings["defaultTemperature"],
              })
            }
          >
            <option value="cold">Frio</option>
            <option value="warm">Morno</option>
            <option value="hot">Quente</option>
          </SelectField>

          <TagEditor
            tags={settings.tags}
            onChange={(tags) => update({ tags })}
          />
        </div>
      </section>

      {/* ── 2. Submissao ────────────────────────────────────────── */}
      <section aria-label="Configurações de submissão">
        <SectionHeader>Submissão</SectionHeader>
        <div className="space-y-4">
          <Input
            label="Texto do botão de envio"
            value={settings.submitButtonText}
            onChange={(e) => update({ submitButtonText: e.target.value })}
            placeholder="Enviar"
          />

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Mensagem de sucesso
            </label>
            <textarea
              rows={3}
              value={settings.successMessage}
              onChange={(e) => update({ successMessage: e.target.value })}
              placeholder="Obrigado! Recebemos sua mensagem."
              className={cn(
                "w-full bg-surface-raised border border-border-strong rounded-field",
                "px-3.5 py-2.5 text-base md:text-sm text-text-primary placeholder:text-text-muted",
                "transition-colors duration-150 resize-y",
                "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              )}
            />
          </div>

          <Input
            label="URL de redirecionamento (opcional)"
            value={settings.redirectUrl ?? ""}
            onChange={(e) =>
              update({ redirectUrl: e.target.value || undefined })
            }
            placeholder="https://exemplo.com/obrigado"
          />
        </div>
      </section>

      {/* ── 3. Notificacoes ─────────────────────────────────────── */}
      <section aria-label="Configurações de notificações">
        <SectionHeader>Notificações</SectionHeader>
        <div className="space-y-4">
          <ToggleRow
            label="Notificar ao receber submissão"
            description="Envia email quando o formulário for preenchido"
            checked={settings.notifyOnSubmission}
            onToggle={() =>
              update({ notifyOnSubmission: !settings.notifyOnSubmission })
            }
          />

          {settings.notifyOnSubmission && (
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-2">
                Membros a notificar
              </label>
              <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                {humanMembers.map((m: any) => {
                  const isSelected =
                    settings.notifyMemberIds?.includes(m._id) ?? false;
                  return (
                    <div
                      key={m._id}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg",
                        "border transition-all duration-150",
                        isSelected
                          ? "border-brand-500 bg-brand-500/10"
                          : "border-border bg-surface-raised hover:border-border-strong"
                      )}
                    >
                      <Checkbox
                        checked={isSelected}
                        onChange={(e) => {
                          const current = settings.notifyMemberIds ?? [];
                          update({
                            notifyMemberIds: e.target.checked
                              ? [...current, m._id]
                              : current.filter((id) => id !== m._id),
                          });
                        }}
                        containerClassName="flex-1"
                        label={<span className="text-text-primary">{m.name}</span>}
                      />
                    </div>
                  );
                })}
                {humanMembers.length === 0 && (
                  <p className="text-[12px] text-text-muted text-center py-2">
                    Nenhum membro humano ativo disponível
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── 4. Pagina de sucesso ──────────────────────────────── */}
      <section aria-label="Página de sucesso">
        <SectionHeader>Página de sucesso</SectionHeader>
        <div className="space-y-4">
          <Input
            label="Título (opcional)"
            value={settings.successTitle ?? ""}
            onChange={(e) =>
              update({ successTitle: e.target.value || undefined })
            }
            placeholder="Obrigado, {nome}!"
          />
          <p className="text-[12px] text-text-muted -mt-2">
            Use <span className="text-brand-400">{"{campo}"}</span> para inserir
            valores das respostas
          </p>

          <Input
            label="Subtítulo (opcional)"
            value={settings.successSubtitle ?? ""}
            onChange={(e) =>
              update({ successSubtitle: e.target.value || undefined })
            }
            placeholder="Entraremos em contato em breve."
          />

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Botão de ação (opcional)
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label=""
                value={settings.successCta?.label ?? ""}
                onChange={(e) =>
                  update({
                    successCta:
                      e.target.value || settings.successCta?.url
                        ? {
                            label: e.target.value,
                            url: settings.successCta?.url ?? "",
                          }
                        : undefined,
                  })
                }
                placeholder="Texto do botão"
              />
              <Input
                label=""
                value={settings.successCta?.url ?? ""}
                onChange={(e) =>
                  update({
                    successCta:
                      e.target.value || settings.successCta?.label
                        ? {
                            label: settings.successCta?.label ?? "",
                            url: e.target.value,
                          }
                        : undefined,
                  })
                }
                placeholder="https://..."
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── 5. Email de confirmacao ──────────────────────────── */}
      <section aria-label="Email de confirmação">
        <SectionHeader>Email de confirmação</SectionHeader>
        <div className="space-y-4">
          <ToggleRow
            label="Enviar email de confirmacao"
            description="Envia um email para quem preencher o formulário"
            checked={settings.confirmationEmail?.enabled ?? false}
            onToggle={() =>
              update({
                confirmationEmail: {
                  ...(settings.confirmationEmail ?? {}),
                  enabled: !(settings.confirmationEmail?.enabled ?? false),
                },
              })
            }
          />

          {settings.confirmationEmail?.enabled && (
            <>
              <Input
                label="Assunto do email"
                value={settings.confirmationEmail.subject ?? ""}
                onChange={(e) =>
                  update({
                    confirmationEmail: {
                      ...settings.confirmationEmail!,
                      subject: e.target.value || undefined,
                    },
                  })
                }
                placeholder="Recebemos sua mensagem!"
              />

              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Corpo do email
                </label>
                <textarea
                  rows={4}
                  value={settings.confirmationEmail.body ?? ""}
                  onChange={(e) =>
                    update({
                      confirmationEmail: {
                        ...settings.confirmationEmail!,
                        body: e.target.value || undefined,
                      },
                    })
                  }
                  placeholder="Obrigado por entrar em contato, {nome}! Recebemos sua mensagem e retornaremos em breve."
                  className={cn(
                    "w-full bg-surface-raised border border-border-strong rounded-field",
                    "px-3.5 py-2.5 text-base md:text-sm text-text-primary placeholder:text-text-muted",
                    "transition-colors duration-150 resize-y",
                    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                  )}
                />
                <p className="mt-1 text-[12px] text-text-muted">
                  Use <span className="text-brand-400">{"{campo}"}</span> para
                  inserir valores das respostas
                </p>
              </div>

              <Input
                label="Reply-To (opcional)"
                value={settings.confirmationEmail.replyTo ?? ""}
                onChange={(e) =>
                  update({
                    confirmationEmail: {
                      ...settings.confirmationEmail!,
                      replyTo: e.target.value || undefined,
                    },
                  })
                }
                placeholder="contato@empresa.com"
              />
            </>
          )}
        </div>
      </section>

      {/* ── 6. Spam ─────────────────────────────────────────────── */}
      <section aria-label="Configurações de spam">
        <SectionHeader>Spam</SectionHeader>
        <div className="space-y-4">
          <ToggleRow
            label="Honeypot habilitado"
            description="Campo oculto para bloquear bots automaticamente"
            checked={settings.honeypotEnabled}
            onToggle={() =>
              update({ honeypotEnabled: !settings.honeypotEnabled })
            }
          />

          <Input
            label="Limite de envios (opcional)"
            type="number"
            min={1}
            value={settings.submissionLimit ?? ""}
            onChange={(e) =>
              update({
                submissionLimit: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
            placeholder="Sem limite"
          />
        </div>
      </section>

      {/* ── 7. Captura parcial ────────────────────────────────── */}
      <section aria-label="Captura parcial">
        <SectionHeader>Captura parcial</SectionHeader>
        <div className="space-y-4">
          <ToggleRow
            label="Captura parcial habilitada"
            description="Salva dados automaticamente quando visitantes preenchem campos, mesmo que não enviem o formulário"
            checked={settings.partialCaptureEnabled ?? false}
            onToggle={() =>
              update({ partialCaptureEnabled: !(settings.partialCaptureEnabled ?? false) })
            }
          />
        </div>
      </section>
    </div>
  );
}
