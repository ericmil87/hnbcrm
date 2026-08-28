import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { SlideOver } from "../ui/SlideOver";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Avatar } from "../ui/Avatar";
import { Spinner } from "../ui/Spinner";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useState } from "react";
import {
  Calendar,
  Clock,
  MapPin,
  Video,
  User,
  Users,
  FileText,
  CheckCircle2,
  XCircle,
  Edit,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { EVENT_TYPE_LABELS, EVENT_STATUS_LABELS } from "./constants";
import { toast } from "sonner";

interface EventDetailSlideOverProps {
  open: boolean;
  onClose: () => void;
  eventId: string | null;
  onEdit: (eventId: string) => void;
}

export function EventDetailSlideOver({ open, onClose, eventId, onEdit }: EventDetailSlideOverProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const event = useQuery(
    api.calendar.getEvent,
    eventId ? { eventId: eventId as Id<"calendarEvents"> } : "skip"
  );

  const completeEvent = useMutation(api.calendar.completeEvent);
  const cancelEvent = useMutation(api.calendar.cancelEvent);
  const deleteEvent = useMutation(api.calendar.deleteEvent);

  const handleComplete = async () => {
    if (!eventId) return;
    try {
      await completeEvent({ eventId: eventId as Id<"calendarEvents"> });
      toast.success("Evento concluído!");
      onClose();
    } catch (error) {
      toast.error("Erro ao concluir evento");
      console.error(error);
    }
  };

  const handleCancel = async () => {
    if (!eventId) return;
    try {
      await cancelEvent({ eventId: eventId as Id<"calendarEvents"> });
      toast.success("Evento cancelado!");
      onClose();
    } catch (error) {
      toast.error("Erro ao cancelar evento");
      console.error(error);
    }
  };

  const handleDelete = async () => {
    if (!eventId) return;
    try {
      await deleteEvent({ eventId: eventId as Id<"calendarEvents"> });
      toast.success("Evento excluído!");
      setShowDeleteConfirm(false);
      onClose();
    } catch (error) {
      toast.error("Erro ao excluir evento");
      console.error(error);
    }
  };

  if (!event) {
    return (
      <SlideOver open={open} onClose={onClose} title="Evento">
        <div className="flex justify-center py-8">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }

  const startDate = new Date(event.startTime);
  const endDate = new Date(event.endTime);
  const isAllDay = event.allDay;

  const formatTime = (date: Date) => {
    return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("pt-BR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  };

  return (
    <>
      <SlideOver open={open} onClose={onClose} title="Detalhes do Evento">
        <div className="p-4 md:p-6 space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-start gap-3 mb-2">
              <Badge variant={event.status === "completed" ? "success" : event.status === "cancelled" ? "error" : "default"}>
                {EVENT_STATUS_LABELS[event.status]}
              </Badge>
              <Badge variant="brand">{EVENT_TYPE_LABELS[event.eventType]}</Badge>
            </div>
            <h2 className="text-xl font-semibold text-text-primary">{event.title}</h2>
          </div>

          {/* Date & Time */}
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Calendar size={20} className="text-text-muted shrink-0 mt-0.5" />
              <div>
                <div className="text-sm text-text-primary font-medium">
                  {formatDate(startDate)}
                </div>
                {!isAllDay && (
                  <div className="text-xs text-text-muted">
                    {formatTime(startDate)} - {formatTime(endDate)}
                  </div>
                )}
                {isAllDay && (
                  <div className="text-xs text-text-muted">Dia inteiro</div>
                )}
              </div>
            </div>

            {event.location && (
              <div className="flex items-start gap-3">
                <MapPin size={20} className="text-text-muted shrink-0 mt-0.5" />
                <div className="text-sm text-text-primary">{event.location}</div>
              </div>
            )}

            {event.meetingUrl && (
              <div className="flex items-start gap-3">
                <Video size={20} className="text-text-muted shrink-0 mt-0.5" />
                <a
                  href={event.meetingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-brand-500 hover:text-brand-400 transition-colors flex items-center gap-1"
                >
                  Link da reunião
                  <ExternalLink size={14} />
                </a>
              </div>
            )}
          </div>

          {/* Description */}
          {event.description && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">Descrição</h3>
              <p className="text-sm text-text-primary whitespace-pre-wrap">{event.description}</p>
            </div>
          )}

          {/* Linked Records */}
          {(event.lead || event.contact) && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">Vinculado a</h3>
              <div className="space-y-2">
                {event.lead && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-surface-raised rounded-lg border border-border">
                    <User size={16} className="text-text-muted" />
                    <div>
                      <div className="text-xs text-text-muted">Lead</div>
                      <div className="text-sm font-medium text-text-primary">{event.lead.title}</div>
                    </div>
                  </div>
                )}
                {event.contact && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-surface-raised rounded-lg border border-border">
                    <User size={16} className="text-text-muted" />
                    <div>
                      <div className="text-xs text-text-muted">Contato</div>
                      <div className="text-sm font-medium text-text-primary">
                        {`${event.contact.firstName ?? ""} ${event.contact.lastName ?? ""}`.trim() ||
                          "Contato"}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Assignee */}
          {event.assignee && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">Responsável</h3>
              <div className="flex items-center gap-2">
                <Avatar name={event.assignee.name} type={event.assignee.type} size="sm" />
                <span className="text-sm text-text-primary">{event.assignee.name}</span>
              </div>
            </div>
          )}

          {/* Attendees */}
          {event.attendeesResolved && event.attendeesResolved.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2 flex items-center gap-2">
                <Users size={16} />
                Participantes
              </h3>
              <div className="space-y-2">
                {event.attendeesResolved.map((attendee) => (
                  <div key={attendee._id} className="flex items-center gap-2">
                    <Avatar name={attendee.name} type={attendee.type} size="sm" />
                    <span className="text-sm text-text-primary">{attendee.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {event.notes && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2 flex items-center gap-2">
                <FileText size={16} />
                Notas
              </h3>
              <p className="text-sm text-text-primary whitespace-pre-wrap">{event.notes}</p>
            </div>
          )}

          {/* Actions */}
          <div className="space-y-2 pt-4 border-t border-border">
            {event.status === "scheduled" && (
              <>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={handleComplete}
                >
                  <CheckCircle2 size={16} />
                  Concluir
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={handleCancel}
                >
                  <XCircle size={16} />
                  Cancelar
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                onEdit(eventId!);
                onClose();
              }}
            >
              <Edit size={16} />
              Editar
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start text-semantic-error hover:text-semantic-error hover:bg-semantic-error/10"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 size={16} />
              Excluir
            </Button>
          </div>
        </div>
      </SlideOver>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Excluir Evento"
        description="Tem certeza que deseja excluir este evento? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />
    </>
  );
}
