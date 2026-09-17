/**
 * Passo 3 — o que publicar. Dois modos exclusivos:
 *
 *  - **Biblioteca**: textos prontos, em sequência ou sorteados. Cada um aceita
 *    spintax `{a|b}` e as variáveis `{{grupo}}`, `{{data}}`, `{{dia_semana}}`,
 *    `{{hora}}`, `{{mes}}`, `{{ano}}`, resolvidas na prévia com o mesmo helper
 *    que o worker usa no disparo.
 *  - **IA**: a "mensagem do dia" é escrita antes da hora e (por padrão) espera
 *    aprovação humana. Desligar a aprovação é `campaigns:full` — a partir daí
 *    o texto vai ao ar sem ninguém ler.
 */
import { AlertTriangle, ArrowDown, ArrowUp, Bot, Library, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { WhatsAppPreview } from "@/components/campaigns/WhatsAppPreview";
import { cn } from "@/lib/utils";
import {
  MAX_LIBRARY_ITEMS,
  MAX_POST_TEXT_CHARS,
} from "../../../../convex/lib/groupPostCore";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { GroupPostLibraryItem } from "./types";
import type { PostDraft } from "./wizardState";
import { AttachmentField, useFileMeta } from "./AttachmentField";

const SELECT_CLASS =
  "w-full h-10 rounded-lg border border-border bg-surface-raised px-3 text-base md:text-sm text-text-primary";
const TEXTAREA_CLASS =
  "w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2.5 text-base md:text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

interface StepContentProps {
  draft: PostDraft;
  setDraft: (updater: (prev: PostDraft) => PostDraft) => void;
  organizationId: Id<"organizations">;
  sampleVars: Record<string, string>;
  canFull: boolean;
  aiAvailable: boolean;
  onOpenAiSettings: () => void;
}

export function StepContent({
  draft,
  setDraft,
  organizationId,
  sampleVars,
  canFull,
  aiAvailable,
  onOpenAiSettings,
}: StepContentProps) {
  const setLibrary = (updater: (lib: PostDraft["library"]) => PostDraft["library"]) =>
    setDraft((prev) => ({ ...prev, library: updater(prev.library) }));
  const setAi = (patch: Partial<PostDraft["ai"]>) =>
    setDraft((prev) => ({ ...prev, ai: { ...prev.ai, ...patch } }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2">
        <ModeButton
          active={draft.kind === "library"}
          icon={Library}
          title="Biblioteca de mensagens"
          subtitle="Textos prontos, em sequência ou sorteados"
          onClick={() => setDraft((prev) => ({ ...prev, kind: "library" }))}
        />
        <ModeButton
          active={draft.kind === "ai"}
          icon={Bot}
          title="Gerada por IA"
          subtitle="A mensagem do dia, escrita antes da hora"
          onClick={() => setDraft((prev) => ({ ...prev, kind: "ai" }))}
        />
      </div>

      {draft.kind === "library" ? (
        <div className="space-y-4">
          {draft.library.items.map((item, index) => (
            <LibraryItemEditor
              key={index}
              index={index}
              total={draft.library.items.length}
              item={item}
              organizationId={organizationId}
              sampleVars={sampleVars}
              onChange={(next) =>
                setLibrary((lib) => ({
                  ...lib,
                  items: lib.items.map((it, i) => (i === index ? next : it)),
                }))
              }
              onRemove={() =>
                setLibrary((lib) => ({ ...lib, items: lib.items.filter((_, i) => i !== index) }))
              }
              onMove={(direction) =>
                setLibrary((lib) => {
                  const target = index + direction;
                  if (target < 0 || target >= lib.items.length) return lib;
                  const items = [...lib.items];
                  const [moved] = items.splice(index, 1);
                  items.splice(target, 0, moved);
                  return { ...lib, items };
                })
              }
            />
          ))}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={draft.library.items.length >= MAX_LIBRARY_ITEMS}
            onClick={() => setLibrary((lib) => ({ ...lib, items: [...lib.items, { text: "" }] }))}
          >
            <Plus size={14} />
            Adicionar mensagem
          </Button>

          <div className="rounded-card border border-border bg-surface-raised p-3.5 space-y-3">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="lib-order">
                Ordem
              </label>
              <select
                id="lib-order"
                className={SELECT_CLASS}
                value={draft.library.order}
                onChange={(e) =>
                  setLibrary((lib) => ({ ...lib, order: e.target.value as "sequential" | "random" }))
                }
              >
                <option value="sequential">Em sequência (uma por vez, e volta ao começo)</option>
                <option value="random">Aleatória</option>
              </select>
            </div>
            {draft.library.order === "random" && (
              <div>
                <label
                  className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                  htmlFor="lib-norepeat"
                >
                  Não repetir as últimas N mensagens
                </label>
                <input
                  id="lib-norepeat"
                  type="number"
                  min={0}
                  max={Math.max(0, draft.library.items.length - 1)}
                  value={draft.library.noRepeatWindow ?? 0}
                  onChange={(e) =>
                    setLibrary((lib) => ({ ...lib, noRepeatWindow: Number(e.target.value) || 0 }))
                  }
                  className={SELECT_CLASS}
                />
                <p className="mt-1 text-xs text-text-muted">
                  Máximo {Math.max(0, draft.library.items.length - 1)} (uma a menos que o total, senão
                  não sobra nada para sortear).
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {!aiAvailable && (
            <Warning>
              A IA da organização (ou a IA em grupos) está desligada. Ative em Configurações → IA
              antes de salvar esta publicação.{" "}
              <button type="button" className="underline" onClick={onOpenAiSettings}>
                Abrir configurações
              </button>
            </Warning>
          )}

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="ai-prompt">
              O que a IA deve publicar
            </label>
            <textarea
              id="ai-prompt"
              rows={4}
              maxLength={MAX_POST_TEXT_CHARS}
              className={TEXTAREA_CLASS}
              placeholder="Ex.: uma mensagem curta de bom dia com uma dica prática sobre alimentação natural, sem vender nada."
              value={draft.ai.prompt}
              onChange={(e) => setAi({ prompt: e.target.value })}
            />
            <p className="mt-1 text-xs text-text-muted">
              O nome do grupo e as últimas publicações entram no prompt para a IA não se repetir.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="ai-persona">
                Persona
              </label>
              <select
                id="ai-persona"
                className={SELECT_CLASS}
                value={draft.ai.persona ?? "attendant"}
                onChange={(e) => setAi({ persona: e.target.value as "attendant" | "custom" })}
              >
                <option value="attendant">A do atendente IA</option>
                <option value="custom">Personalizada</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="ai-maxchars">
                Tamanho máximo (opcional)
              </label>
              <input
                id="ai-maxchars"
                type="number"
                min={50}
                max={MAX_POST_TEXT_CHARS}
                placeholder="sem limite"
                className={SELECT_CLASS}
                value={draft.ai.maxChars ?? ""}
                onChange={(e) =>
                  setAi({ maxChars: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </div>
          </div>

          {draft.ai.persona === "custom" && (
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="ai-custom">
                Persona personalizada
              </label>
              <textarea
                id="ai-custom"
                rows={3}
                className={TEXTAREA_CLASS}
                placeholder="Ex.: você é o Guardião, escreve em tom acolhedor, sem emojis em excesso…"
                value={draft.ai.customPersona ?? ""}
                onChange={(e) => setAi({ customPersona: e.target.value })}
              />
            </div>
          )}

          <Checkbox
            checked={draft.ai.useKnowledge}
            onChange={(e) => setAi({ useKnowledge: e.target.checked })}
            label="Usar a base de conhecimento do atendente"
            description="Produtos, preços e regras que o atendente IA já conhece."
          />

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="ai-before">
              Gerar quantos minutos antes do horário
            </label>
            <input
              id="ai-before"
              type="number"
              min={5}
              max={1440}
              className={SELECT_CLASS}
              value={draft.ai.generateMinutesBefore}
              onChange={(e) => setAi({ generateMinutesBefore: Number(e.target.value) || 0 })}
            />
            <p className="mt-1 text-xs text-text-muted">
              Entre 5 e 1440 minutos. É a janela que alguém tem para ler e aprovar o texto.
            </p>
          </div>

          <div className="space-y-2 rounded-card border border-border bg-surface-raised p-3.5">
            <Checkbox
              checked={draft.ai.requiresApproval}
              disabled={!canFull && draft.ai.requiresApproval}
              onChange={(e) => setAi({ requiresApproval: e.target.checked })}
              label="Exigir aprovação humana antes de publicar"
              description={
                canFull
                  ? "Recomendado. Sem isso, o texto da IA vai ao ar sozinho."
                  : "Só quem tem permissão total em campanhas pode desligar."
              }
            />
            {!draft.ai.requiresApproval && (
              <Warning>
                Sem aprovação, o CRM publica no grupo o que a IA escrever, sem ninguém ler antes.
                Isso fica registrado na auditoria.
              </Warning>
            )}
            {draft.ai.requiresApproval && (
              <div>
                <label
                  className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                  htmlFor="ai-missed"
                >
                  Se ninguém aprovar a tempo
                </label>
                <select
                  id="ai-missed"
                  className={SELECT_CLASS}
                  value={draft.ai.onMissedApproval}
                  onChange={(e) => setAi({ onMissedApproval: e.target.value as "skip" | "send" })}
                >
                  <option value="skip">Pular este horário</option>
                  <option value="send">Publicar mesmo assim</option>
                </select>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeButton({
  active,
  icon: Icon,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-card border p-3 text-left transition-colors",
        active
          ? "border-brand-500 bg-brand-500/10"
          : "border-border bg-surface-raised hover:border-border-strong"
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
        <Icon size={15} className={active ? "text-brand-500" : "text-text-muted"} />
        {title}
      </span>
      <span className="mt-0.5 block text-xs text-text-muted">{subtitle}</span>
    </button>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-xs text-semantic-warning">
      <AlertTriangle size={14} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function LibraryItemEditor({
  index,
  total,
  item,
  organizationId,
  sampleVars,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  item: GroupPostLibraryItem;
  organizationId: Id<"organizations">;
  sampleVars: Record<string, string>;
  onChange: (next: GroupPostLibraryItem) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const fileId = item.attachmentFileIds?.[0];
  const meta = useFileMeta(fileId);

  return (
    <div className="rounded-card border border-border bg-surface-raised p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-xs font-medium text-text-muted">Mensagem {index + 1}</span>
        <div className="ml-auto flex items-center gap-1">
          <IconBtn label="Subir" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </IconBtn>
          <IconBtn label="Descer" disabled={index === total - 1} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </IconBtn>
          <IconBtn label="Remover" disabled={total === 1} danger onClick={onRemove}>
            <Trash2 size={13} />
          </IconBtn>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <textarea
            rows={6}
            maxLength={MAX_POST_TEXT_CHARS}
            className={TEXTAREA_CLASS}
            placeholder="Bom dia, {{grupo}}! Hoje é {{dia_semana}}, {{data}}…"
            value={item.text}
            onChange={(e) => onChange({ ...item, text: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <AttachmentField
              organizationId={organizationId}
              fileId={fileId}
              onChange={(next) =>
                onChange({
                  ...item,
                  attachmentFileIds: next ? [next] : undefined,
                  contentType: next ? item.contentType : undefined,
                })
              }
            />
            <span className="ml-auto text-[11px] tabular-nums text-text-muted">
              {item.text.length}/{MAX_POST_TEXT_CHARS}
            </span>
          </div>
        </div>
        <WhatsAppPreview
          text={item.text}
          vars={sampleVars}
          seed={index}
          compact
          attachments={
            meta ? [{ name: meta.name, mimeType: meta.mimeType, url: meta.url, size: meta.size }] : []
          }
        />
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  disabled,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full border border-border p-1.5 text-text-muted transition-colors disabled:opacity-40",
        danger ? "hover:border-semantic-error hover:text-semantic-error" : "hover:text-text-primary"
      )}
    >
      {children}
    </button>
  );
}
