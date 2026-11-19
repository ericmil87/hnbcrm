import type { LucideIcon } from "lucide-react";
import { Bot, Check, CircleDashed, Handshake, Home, Truck, UserCheck, Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import {
  CONTACT_RELATIONS,
  CONTACT_RELATION_LABEL,
  RELATION_SHEET_HINT,
  RELATION_TONE,
  needsRelationNoPermissionText,
  offBusinessLeadWarning,
  needsRelationText,
  offBusinessRelation,
  relationSheetTitle,
  type ContactRelation,
} from "@/lib/contactRelationUi";
import { cn } from "@/lib/utils";

export const RELATION_ICON: Record<ContactRelation, LucideIcon> = {
  customer: UserCheck,
  personal: Home,
  team: Users,
  supplier: Truck,
  partner: Handshake,
  automated: Bot,
};

interface ContactRelationSheetProps {
  open: boolean;
  onClose: () => void;
  /** Nome do contato (título "Quem é <Nome>?"). */
  name: string | null | undefined;
  current: ContactRelation | null | undefined;
  /** Um toque aplica (sem confirmação extra); quem chama mostra o toast com "Desfazer". */
  onSelect: (relation: ContactRelation) => void;
  /** Título no lugar de "Quem é <Nome>?" (ex.: lote "Definir tipo de 3 contatos"). */
  title?: string;
  /** Mostra "Sem tipo" (volta a não classificado); ausente = só os seis tipos. */
  onClear?: () => void;
  /** Esconde "Lead" (ex.: "Não é cliente…" só oferece os tipos fora do comercial). */
  hideCustomer?: boolean;
}

/**
 * Folha "Quem é <Nome>?": seis botões grandes (Lead, Pessoal, Equipe,
 * Fornecedor, Parceiro, Robô), o atual marcado. Folha inferior no celular e
 * diálogo no computador (`Modal`).
 */
export function ContactRelationSheet({
  open,
  onClose,
  name,
  current,
  onSelect,
  title,
  onClear,
  hideCustomer = false,
}: ContactRelationSheetProps) {
  const relations = hideCustomer ? CONTACT_RELATIONS.filter((r) => r !== "customer") : CONTACT_RELATIONS;
  return (
    <Modal open={open} onClose={onClose} title={title ?? relationSheetTitle(name)}>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Tipo de contato">
        {relations.map((relation) => {
          const Icon = RELATION_ICON[relation];
          const selected = current === relation;
          return (
            <button
              key={relation}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                onClose();
                if (!selected) onSelect(relation);
              }}
              className={cn(
                "relative flex min-h-14 items-center gap-2.5 rounded-card border px-3 py-3 text-left text-sm font-medium text-text-primary transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                selected
                  ? "border-brand-500 bg-brand-500/10"
                  : "border-border bg-surface-raised hover:border-border-strong hover:bg-surface-sunken"
              )}
            >
              <Icon size={20} aria-hidden className={selected ? "text-brand-500" : "text-text-secondary"} />
              <span className="min-w-0 flex-1 truncate">{CONTACT_RELATION_LABEL[relation]}</span>
              {selected && <Check size={16} aria-hidden className="shrink-0 text-brand-500" />}
            </button>
          );
        })}
        {onClear && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onClear();
            }}
            className={cn(
              "relative flex min-h-14 items-center gap-2.5 rounded-card border border-border bg-surface-raised px-3 py-3 text-left text-sm font-medium text-text-primary transition-colors",
              "hover:border-border-strong hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            )}
          >
            <CircleDashed size={20} aria-hidden className="text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">Sem tipo</span>
          </button>
        )}
      </div>
      <p className="mt-3 text-caption text-text-muted">{RELATION_SHEET_HINT}</p>
    </Modal>
  );
}

interface NeedsRelationDialogProps {
  open: boolean;
  onClose: () => void;
  name: string | null | undefined;
  relation: ContactRelation;
  /** "Virar lead e devolver à IA" (ou "… e pedir sugestão"). */
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  /** `contacts:edit`: sem ele só explica e mostra "Cancelar" (sem "Virar lead"). */
  canEdit: boolean;
}

/**
 * "<Nome> está como Pessoal. A IA não responde…" · [Virar lead e devolver à IA] [Cancelar].
 * Sem `contacts:edit`: "<Nome> está como Pessoal. Peça a um admin para mudar o tipo." · [Cancelar].
 */
export function NeedsRelationDialog({
  open,
  onClose,
  name,
  relation,
  confirmLabel,
  onConfirm,
  busy,
  canEdit,
}: NeedsRelationDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title="Contato não é cliente">
      <p className="text-sm leading-relaxed text-text-secondary">
        {canEdit ? needsRelationText(name, relation) : needsRelationNoPermissionText(name, relation)}
      </p>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} className="w-full sm:w-auto">
          Cancelar
        </Button>
        {canEdit && (
          <Button type="button" onClick={onConfirm} loading={busy} className="w-full sm:w-auto">
            <UserCheck size={16} aria-hidden />
            {confirmLabel}
          </Button>
        )}
      </div>
    </Modal>
  );
}

/** Selo do tipo ao lado do nome (só quem não é cliente). */
export function ContactRelationBadge({
  relation,
  className,
}: {
  relation: ContactRelation | null | undefined;
  className?: string;
}) {
  const off = offBusinessRelation(relation);
  if (!off) return null;
  const Icon = RELATION_ICON[off];
  return (
    <Badge
      variant={RELATION_TONE[off]}
      className={cn("shrink-0 gap-1 px-2 py-0 text-micro leading-5", className)}
      data-relation={off}
    >
      <Icon size={11} aria-hidden />
      {CONTACT_RELATION_LABEL[off]}
    </Badge>
  );
}

/**
 * Aviso inline ao criar lead à mão para um contato que não é cliente
 * ("Este contato está como Pessoal. Ao criar o lead ele continua sem IA.
 * Virar lead?"). Avisa, não bloqueia: a criação segue normalmente.
 */
export function OffBusinessLeadWarning({
  relation,
  canEdit,
  onTurnLead,
  busy,
  className,
}: {
  relation: ContactRelation | null | undefined;
  /** `contacts:edit`: mostra o botão "Virar lead". */
  canEdit: boolean;
  onTurnLead: () => void;
  busy?: boolean;
  className?: string;
}) {
  const off = offBusinessRelation(relation);
  if (!off) return null;
  const Icon = RELATION_ICON[off];
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3 sm:flex-row sm:items-center",
        className
      )}
    >
      <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-text-secondary">
        <Icon size={16} aria-hidden className="mt-0.5 shrink-0 text-semantic-warning" />
        <span>{offBusinessLeadWarning(off, canEdit)}</span>
      </p>
      {canEdit && (
        <Button type="button" size="sm" variant="secondary" onClick={onTurnLead} loading={busy} className="shrink-0">
          <UserCheck size={14} aria-hidden />
          Virar lead
        </Button>
      )}
    </div>
  );
}
