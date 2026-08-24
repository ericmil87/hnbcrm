import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "../ui/Modal";
import { Checkbox } from "../ui/Checkbox";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { cn } from "@/lib/utils";
import { EVENT_TYPE_LABELS, RECURRENCE_OPTIONS } from "./constants";
import { toast } from "sonner";

interface CalendarEventModalProps {
  open: boolean;
  onClose: () => void;
  organizationId: Id<"organizations">;
  eventId?: string;
  initialDate?: Date;
  initialHour?: number;
  initialMinute?: number;
}

export function CalendarEventModal({
  open,
  onClose,
  organizationId,
  eventId,
  initialDate,
  initialHour,
  initialMinute,
}: CalendarEventModalProps) {
  const isEdit = Boolean(eventId);

  const existingEvent = useQuery(
    api.calendar.getEvent,
    eventId ? { eventId: eventId as Id<"calendarEvents"> } : "skip"
  );

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const leads = useQuery(api.leads.getLeads, { organizationId });
  const contacts = useQuery(api.contacts.getContacts, { organizationId });

  const createEvent = useMutation(api.calendar.createEvent);
  const updateEvent = useMutation(api.calendar.updateEvent);

  // Form state
  const [title, setTitle] = useState("");
  const [eventType, setEventType] = useState<string>("meeting");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [description, setDescription] = useState("");
  const [leadId, setLeadId] = useState<string>("");
  const [contactId, setContactId] = useState<string>("");
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [recurrence, setRecurrence] = useState("none");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize form with existing event or initial values
  useEffect(() => {
    if (existingEvent && isEdit) {
      setTitle(existingEvent.title);
      setEventType(existingEvent.eventType);
      setAllDay(existingEvent.allDay || false);
      setDescription(existingEvent.description || "");
      setLeadId(existingEvent.leadId || "");
      setContactId(existingEvent.contactId || "");
      setAssignedTo(existingEvent.assignedTo || "");
      setAttendees(existingEvent.attendees || []);
      setLocation(existingEvent.location || "");
      setMeetingUrl(existingEvent.meetingUrl || "");
      setRecurrence(existingEvent.recurrence?.pattern || "none");
      setNotes(existingEvent.notes || "");

      const start = new Date(existingEvent.startTime);
      setStartDate(start.toISOString().split("T")[0]);
      if (!existingEvent.allDay) {
        setStartTime(`${start.getHours().toString().padStart(2, "0")}:${start.getMinutes().toString().padStart(2, "0")}`);
        const end = new Date(existingEvent.endTime);
        setEndTime(`${end.getHours().toString().padStart(2, "0")}:${end.getMinutes().toString().padStart(2, "0")}`);
      }
    } else if (!isEdit && initialDate) {
      // New event with initial date/time
      setStartDate(initialDate.toISOString().split("T")[0]);
      if (initialHour !== undefined && initialMinute !== undefined) {
        setStartTime(`${initialHour.toString().padStart(2, "0")}:${initialMinute.toString().padStart(2, "0")}`);
        // Default to 1-hour duration
        const endHour = initialHour + 1;
        setEndTime(`${endHour.toString().padStart(2, "0")}:${initialMinute.toString().padStart(2, "0")}`);
      }
    }
  }, [existingEvent, isEdit, initialDate, initialHour, initialMinute]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Título é obrigatório");
      return;
    }

    setIsSubmitting(true);
    try {
      let startTimestamp: number;
      let endTimestamp: number;

      if (allDay) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(startDate);
        end.setHours(23, 59, 59, 999);
        startTimestamp = start.getTime();
        endTimestamp = end.getTime();
      } else {
        const [startHour, startMin] = startTime.split(":").map(Number);
        const [endHour, endMin] = endTime.split(":").map(Number);
        const start = new Date(startDate);
        start.setHours(startHour, startMin, 0, 0);
        const end = new Date(startDate);
        end.setHours(endHour, endMin, 0, 0);
        startTimestamp = start.getTime();
        endTimestamp = end.getTime();
      }

      const eventData = {
        title: title.trim(),
        eventType: eventType as "call" | "meeting" | "follow_up" | "demo" | "task" | "reminder" | "other",
        startTime: startTimestamp,
        endTime: endTimestamp,
        allDay,
        description: description.trim() || undefined,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
        contactId: contactId ? (contactId as Id<"contacts">) : undefined,
        assignedTo: assignedTo ? (assignedTo as Id<"teamMembers">) : undefined,
        attendees: attendees.length > 0 ? (attendees as Id<"teamMembers">[]) : undefined,
        location: location.trim() || undefined,
        meetingUrl: meetingUrl.trim() || undefined,
        recurrence: recurrence !== "none" ? { pattern: recurrence as "daily" | "weekly" | "biweekly" | "monthly" } : undefined,
        notes: notes.trim() || undefined,
      };

      if (isEdit && eventId) {
        await updateEvent({ eventId: eventId as Id<"calendarEvents">, ...eventData });
        toast.success("Evento atualizado!");
      } else {
        await createEvent({ organizationId, ...eventData });
        toast.success("Evento criado!");
      }

      onClose();
    } catch (error) {
      toast.error("Erro ao salvar evento");
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleAttendee = (memberId: string) => {
    if (attendees.includes(memberId)) {
      setAttendees(attendees.filter((id) => id !== memberId));
    } else {
      setAttendees([...attendees, memberId]);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "Editar Evento" : "Novo Evento"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <Input
          label="Título"
          placeholder="Nome do evento"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />

        {/* Event Type */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Tipo
          </label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(EVENT_TYPE_LABELS).map(([type, label]) => (
              <button
                key={type}
                type="button"
                onClick={() => setEventType(type)}
                className={cn(
                  "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                  eventType === type
                    ? "bg-brand-500 text-white"
                    : "bg-surface-raised text-text-secondary border border-border hover:bg-surface-overlay"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Date & Time */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="Data"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
          {!allDay && (
            <>
              <Input
                label="Horário Início"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
              />
              <Input
                label="Horário Fim"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
              />
            </>
          )}
        </div>

        {/* All Day Toggle */}
        <Checkbox
          checked={allDay}
          onChange={(e) => setAllDay(e.target.checked)}
          label={<span className="text-text-primary">Dia Inteiro</span>}
        />

        {/* Description */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Descrição
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full px-3.5 py-2.5 bg-surface-raised border border-border-strong rounded-field text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            placeholder="Detalhes do evento"
          />
        </div>

        {/* Lead */}
        {leads && leads.length > 0 && (
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Lead Vinculado
            </label>
            <select
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 text-sm"
            >
              <option value="">Nenhum</option>
              {leads.map((lead) => (
                <option key={lead._id} value={lead._id}>
                  {lead.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Contact */}
        {contacts && contacts.length > 0 && (
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Contato
            </label>
            <select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 text-sm"
            >
              <option value="">Nenhum</option>
              {contacts.map((contact) => (
                <option key={contact._id} value={contact._id}>
                  {[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || "Sem nome"}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Assigned To */}
        {teamMembers && teamMembers.length > 0 && (
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Responsável
            </label>
            <select
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 text-sm"
            >
              <option value="">Nenhum</option>
              {teamMembers.map((member) => (
                <option key={member._id} value={member._id}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Attendees */}
        {teamMembers && teamMembers.length > 0 && (
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Participantes
            </label>
            <div className="flex flex-wrap gap-2">
              {teamMembers.map((member) => (
                <button
                  key={member._id}
                  type="button"
                  onClick={() => toggleAttendee(member._id)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                    attendees.includes(member._id)
                      ? "bg-brand-500 text-white"
                      : "bg-surface-raised text-text-secondary border border-border hover:bg-surface-overlay"
                  )}
                >
                  {member.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Location */}
        <Input
          label="Local"
          placeholder="Endereço ou sala"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        {/* Meeting URL */}
        <Input
          label="Link da Reunião"
          type="url"
          placeholder="https://..."
          value={meetingUrl}
          onChange={(e) => setMeetingUrl(e.target.value)}
        />

        {/* Recurrence */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Recorrência
          </label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 text-sm"
          >
            {RECURRENCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Notas
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-3.5 py-2.5 bg-surface-raised border border-border-strong rounded-field text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            placeholder="Notas internas"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
          <Button type="submit" disabled={isSubmitting} className="flex-1">
            {isSubmitting ? "Salvando..." : isEdit ? "Atualizar" : "Criar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
