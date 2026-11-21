/**
 * Leitura tolerante dos campos de permissão que o backend da Agenda devolve por item
 * (`canEdit`, calculado no servidor para quem chama). Campo ausente (backend antigo) = pode:
 * o servidor continua sendo a barreira, a tela só evita oferecer o que vai falhar.
 * Os helpers aceitam `object`: o item chega com tipos diferentes conforme a versão do backend
 * (sem o campo, ou como `Record<string, any>`), e um tipo só de campos opcionais recusaria ambos.
 */
export interface EditableCalendarItem {
  canEdit?: boolean | null;
  status?: string | null;
}

export const CALENDAR_READONLY_NOTE = "Você só pode alterar os eventos que criou ou que estão com você.";

/** `false` só quando o servidor disse explicitamente que não. */
export function canEditCalendarItem(item: object | null | undefined): boolean {
  return (item as EditableCalendarItem | null | undefined)?.canEdit !== false;
}

/** Arrastar reagenda: precisa poder editar e o evento não pode estar concluído/cancelado. */
export function isCalendarItemDraggable(item: object | null | undefined): boolean {
  if (!canEditCalendarItem(item)) return false;
  const status = (item as EditableCalendarItem | null | undefined)?.status;
  return status !== "completed" && status !== "cancelled";
}
