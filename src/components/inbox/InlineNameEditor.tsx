import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import {
  contactNameUpdate,
  joinContactName,
  normalizeFullName,
  shouldSyncLeadTitle,
} from "@/lib/contactName";

export type InlineNameContact = {
  _id: Id<"contacts">;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  whatsappNumber?: string | null;
};

export type InlineNameLead = { _id: Id<"leads">; title?: string | null } | null | undefined;

/**
 * Nome do contato editável ali mesmo (inbox e painel do lead).
 *
 * - Com nome: o nome segue clicável (`onOpen`, ex.: abrir o painel do contato)
 *   e o lápis ao lado entra em edição.
 * - Sem nome: o próprio "Sem nome"/"—" entra em edição — é o que a pessoa
 *   quer fazer ao clicar ali.
 *
 * Enter salva, Esc cancela, perder o foco salva se mudou; vazio nunca é salvo.
 * O título do lead acompanha quando ainda é automático (telefone, vazio, nome
 * antigo) — ver `shouldSyncLeadTitle`.
 */
export function InlineNameEditor({
  contact,
  lead,
  placeholder = "Sem nome",
  onOpen,
  openLabel,
  className,
  textClassName,
}: {
  contact: InlineNameContact;
  lead?: InlineNameLead;
  /** Texto exibido quando o contato não tem nome. */
  placeholder?: string;
  /** Clique no nome (só quando há nome). Sem isso o nome é texto simples. */
  onOpen?: () => void;
  openLabel?: string;
  className?: string;
  textClassName?: string;
}) {
  const updateContact = useMutation(api.contacts.updateContact);
  const updateLead = useMutation(api.leads.updateLead);
  const currentName = joinContactName(contact.firstName, contact.lastName);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter/Esc já resolveram — o blur que vem logo depois não salva de novo.
  const settledRef = useRef(false);

  // Trocar de conversa com o editor aberto: descarta a edição.
  useEffect(() => {
    setEditing(false);
  }, [contact._id]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    settledRef.current = false;
    setDraft(currentName);
    setEditing(true);
  };

  const cancel = () => {
    settledRef.current = true;
    setEditing(false);
  };

  const save = async () => {
    settledRef.current = true;
    const next = normalizeFullName(draft);
    const update = contactNameUpdate(next, contact);
    if (!update || next === currentName) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateContact({ contactId: contact._id, ...update });
      if (
        lead &&
        normalizeFullName(lead.title ?? "") !== next &&
        shouldSyncLeadTitle(lead.title, [contact.phone, contact.whatsappNumber], currentName)
      ) {
        try {
          await updateLead({ leadId: lead._id, title: next });
        } catch (error) {
          toast.error(mutationErrorMessage(error, "Nome salvo, mas o título do lead não foi atualizado"));
        }
      }
      toast.success("Nome atualizado");
      setEditing(false);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao atualizar o nome"));
      settledRef.current = false;
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        onBlur={() => {
          if (!settledRef.current) void save();
        }}
        placeholder="Nome do contato"
        aria-label="Nome do contato"
        maxLength={120}
        className={cn(
          "min-w-0 w-full max-w-full sm:max-w-xs px-2 py-1 -my-1 bg-surface-base border border-brand-500 rounded-field text-sm font-medium text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60",
          className
        )}
      />
    );
  }

  const pencil = (
    <button
      type="button"
      onClick={startEditing}
      aria-label="Editar nome"
      title="Editar nome"
      className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-full text-text-muted transition-colors hover:text-brand-500 hover:bg-surface-overlay focus:outline-none focus:ring-2 focus:ring-brand-500"
    >
      <Pencil size={13} aria-hidden />
    </button>
  );

  return (
    <span className={cn("flex items-center gap-1 min-w-0 max-w-full", className)}>
      {!currentName ? (
        <button
          type="button"
          onClick={startEditing}
          title="Dar um nome a este contato"
          className={cn(
            "min-w-0 truncate text-left italic text-text-muted transition-colors hover:text-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500 rounded",
            textClassName
          )}
        >
          {placeholder}
        </button>
      ) : onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel ?? currentName}
          className={cn(
            "block min-w-0 truncate py-2.5 -my-2.5 text-left transition-colors hover:text-brand-500 hover:underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-500 rounded",
            textClassName
          )}
        >
          {currentName}
        </button>
      ) : (
        <span className={cn("min-w-0 truncate", textClassName)}>{currentName}</span>
      )}
      {pencil}
    </span>
  );
}
