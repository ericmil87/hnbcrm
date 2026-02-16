import React, { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

interface CreateLeadModalProps {
  organizationId: Id<"organizations">;
  boardId: Id<"boards">;
  onClose: () => void;
}

export function CreateLeadModal({ organizationId, boardId, onClose }: CreateLeadModalProps) {
  // Form state
  const [title, setTitle] = useState("");
  const [value, setValue] = useState(0);
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [temperature, setTemperature] = useState<"cold" | "warm" | "hot">("cold");
  const [assignedTo, setAssignedTo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Contact selection
  const [contactMode, setContactMode] = useState<"none" | "select" | "create">("none");
  const [selectedContactId, setSelectedContactId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");

  // Queries
  const contacts = useQuery(api.contacts.getContacts, {
    organizationId,
  });

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId,
  });

  // Mutations
  const createContact = useMutation(api.contacts.createContact);
  const createLead = useMutation(api.leads.createLead);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      let contactId: Id<"contacts"> | undefined;

      if (contactMode === "create") {
        if (!firstName.trim() && !lastName.trim() && !email.trim()) {
          setError("Forneça pelo menos um nome ou email.");
          setSubmitting(false);
          return;
        }

        contactId = await createContact({
          organizationId,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          company: company.trim() || undefined,
        });
      } else if (contactMode === "select") {
        if (!selectedContactId) {
          setError("Selecione um contato.");
          setSubmitting(false);
          return;
        }
        contactId = selectedContactId as Id<"contacts">;
      }
      // If contactMode === "none", contactId remains undefined

      await createLead({
        organizationId,
        boardId,
        title: title.trim(),
        contactId,
        value,
        priority,
        temperature,
        assignedTo: assignedTo ? (assignedTo as Id<"teamMembers">) : undefined,
      });

      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao criar lead");
      setError(err instanceof Error ? err.message : "Falha ao criar lead.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} title="Criar Novo Lead">
      {error && (
        <div className="mb-4 p-3 bg-semantic-error/10 text-semantic-error text-sm rounded-lg border border-semantic-error/20">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Título <span className="text-semantic-error">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="ex: Negócio SaaS Enterprise"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
            required
          />
        </div>

        {/* Contact Selection */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-2">Contato</label>

          {/* Mode selector */}
          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={() => {
                setContactMode("none");
                setSelectedContactId("");
              }}
              className={cn(
                "flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
                contactMode === "none"
                  ? "bg-brand-500/10 text-brand-500 border-2 border-brand-500"
                  : "bg-surface-raised text-text-secondary border-2 border-border hover:border-border-strong"
              )}
            >
              Sem contato
            </button>
            <button
              type="button"
              onClick={() => {
                setContactMode("select");
                setSelectedContactId("");
              }}
              className={cn(
                "flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
                contactMode === "select"
                  ? "bg-brand-500/10 text-brand-500 border-2 border-brand-500"
                  : "bg-surface-raised text-text-secondary border-2 border-border hover:border-border-strong"
              )}
            >
              Selecionar
            </button>
            <button
              type="button"
              onClick={() => {
                setContactMode("create");
                setSelectedContactId("");
              }}
              className={cn(
                "flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
                contactMode === "create"
                  ? "bg-brand-500/10 text-brand-500 border-2 border-brand-500"
                  : "bg-surface-raised text-text-secondary border-2 border-border hover:border-border-strong"
              )}
            >
              Criar novo
            </button>
          </div>

          {contactMode === "select" && (
            <>
              <select
                value={selectedContactId}
                onChange={(e) => setSelectedContactId(e.target.value)}
                className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                style={{ fontSize: "16px" }}
              >
                <option value="">Selecione um contato...</option>
                {contacts?.map((contact) => (
                  <option key={contact._id} value={contact._id}>
                    {[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || contact.phone || "Sem nome"}
                    {contact.company ? ` (${contact.company})` : ""}
                  </option>
                ))}
              </select>
              {contacts && contacts.length >= 500 && (
                <p className="text-xs text-text-muted mt-1">
                  Mostrando os primeiros 500 contatos.
                </p>
              )}
            </>
          )}

          {contactMode === "create" && (
            <div className="space-y-3 p-3 bg-surface-sunken rounded-card border border-border">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Nome</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    style={{ fontSize: "16px" }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Sobrenome</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    style={{ fontSize: "16px" }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Telefone</label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Empresa</label>
                <input
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Value */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Valor</label>
          <input
            type="number"
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            min={0}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          />
        </div>

        {/* Priority */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Prioridade</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as typeof priority)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          >
            <option value="low">Baixa</option>
            <option value="medium">Média</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </select>
        </div>

        {/* Temperature */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Temperatura</label>
          <select
            value={temperature}
            onChange={(e) => setTemperature(e.target.value as typeof temperature)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          >
            <option value="cold">Frio</option>
            <option value="warm">Morno</option>
            <option value="hot">Quente</option>
          </select>
        </div>

        {/* Assigned To */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Atribuído a</label>
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          >
            <option value="">Não atribuído</option>
            {teamMembers?.map((member) => (
              <option key={member._id} value={member._id}>
                {member.name} ({member.role})
              </option>
            ))}
          </select>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-4">
          <Button
            type="button"
            onClick={onClose}
            variant="secondary"
            size="md"
            className="flex-1"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={submitting}
            variant="primary"
            size="md"
            className="flex-1"
          >
            {submitting ? "Criando..." : "Criar Lead"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
