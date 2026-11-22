import type { DayInput, DayResource, GridAppointment } from "@/lib/agendaGrid";

export const TZ = "America/Sao_Paulo";
export const DATE = "2026-11-23";
/** HH:MM local (UTC-3) do dia de teste. */
export const at = (h: number, m = 0) => Date.UTC(2026, 10, 23, h + 3, m);

export const res = (id: string, kind: DayResource["kind"], over: Partial<DayResource> = {}): DayResource => ({
  _id: id,
  kind,
  name: id.replace(/^./, (c) => c.toUpperCase()),
  capacity: 1,
  sortOrder: 0,
  open: [{ start: at(8), end: at(18) }],
  closed: false,
  blocks: [],
  ...over,
});

let seq = 0;
export function appt(rooms: string[], start: number, end: number, over: Partial<GridAppointment> = {}, conflict: string[] = []): GridAppointment {
  seq++;
  return {
    _id: `a${seq}` as never,
    serviceName: "Sessão",
    startTime: start,
    endTime: end,
    status: "scheduled",
    origin: "staff",
    localDate: DATE,
    contactName: `Cliente ${seq}`,
    resources: [
      ...rooms.map((id) => ({ resourceId: id as never, role: "room", name: id.replace(/^./, (c) => c.toUpperCase()), allocated: true })),
      ...conflict.map((id) => ({ resourceId: id as never, role: "room", name: id, allocated: false })),
    ],
    ...over,
  };
}

export const dayInput = (over: Partial<DayInput> = {}): DayInput => ({
  timezone: TZ,
  localDate: DATE,
  resources: [res("sala1", "room"), res("sala2", "room", { capacity: 2 })],
  appointments: [],
  busy: [],
  exceptions: [],
  ...over,
});

export const NOW = at(9, 30);
