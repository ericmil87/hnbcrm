import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmApiError, HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

/**
 * Agenda v2: appointments for services that use resources (people, rooms, equipment). Every tool calls
 * `/api/v1/scheduling/*`, which applies the SAME rules as the app screens. Dates are LOCAL
 * (`YYYY-MM-DDTHH:mm` in the organization's timezone); responses also carry ISO with offset and `timezone`.
 */

const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const day = (what: string) => z.string().regex(LOCAL_DAY, "Use YYYY-MM-DD").describe(what);
const localTime = (what: string) =>
  z
    .string()
    .regex(LOCAL_TIME, "Use YYYY-MM-DDTHH:mm (organization timezone)")
    .describe(`${what} Local time YYYY-MM-DDTHH:mm in the organization's timezone, e.g. 2026-11-27T14:30. Use a start returned by crm_find_slots (its startsAtLocal); never invent one.`);
const resourceIds = z
  .array(z.string())
  .max(10)
  .describe("Resource IDs of the plan (copy the resourceIds of the chosen crm_find_slots slot or 409 alternative)");
const force = z
  .array(z.string())
  .max(10)
  .describe(
    'Warning codes (severity "warn", e.g. OUTSIDE_HOURS) that a HUMAN decided to accept. Only warnings can be forced: block codes such as CAPACITY_EXCEEDED are always refused. Never force on your own.'
  );

/** Shown to the agent on every 409 so it recovers instead of guessing. */
const CONFLICT_HELP =
  "The scheduling rules refused this. Do NOT retry the same time: offer the customer one of `alternatives` (or call crm_find_slots again) and book that one. `force` only accepts violations with severity warn, and only when a human decided.";

/**
 * 409 `sched_rules` and `idempotency_key_reused` come back as a readable result WITH the structured body
 * (`violations`, `alternatives`) so the agent can act on it; every other error is the plain message.
 */
export function schedulingError(error: unknown) {
  if (error instanceof HnbCrmApiError && error.status === 409 && (error.body?.code === "sched_rules" || error.body?.code === "idempotency_key_reused")) {
    const hint =
      error.body.code === "sched_rules"
        ? CONFLICT_HELP
        : "This idempotencyKey was already used with different data. Use a NEW key for a different booking; reuse the SAME key only to retry the identical request.";
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: 409, hint, ...error.body }, null, 2) }],
      isError: true,
    };
  }
  return errorResult(error);
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== ""));
}

export function registerSchedulingTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_list_scheduling_services",
    "List the active services that can be booked (name, duration, variants, buffers, required resources, price). Use the returned `_id` as serviceId. Needs agenda: view_own and the Scheduling module on.",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        return successResult(await client.get("/api/v1/scheduling/services"));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_list_scheduling_resources",
    "List the active resources (people, rooms, equipment) with their weekly hours and capacity. Use the returned `_id` values as resourceIds.",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        return successResult(await client.get("/api/v1/scheduling/resources"));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_find_slots",
    "Find free times for a service in a window of up to 7 days. This is the ONLY valid source of times: never invent, round or guess a time; offer and book only times returned here (use the slot's startsAtLocal and resourceIds). A slot is a hint, not a lock: it can be taken before you book, so handle the 409. `reason` other than `ok` explains an empty list (service_unavailable, no_matching_resource, unverifiable = could not be checked safely, so nothing is offered). Keys with agenda: edit or higher also get resourceNames and reasonCodes.",
    {
      serviceId: z.string().describe("Service ID (from crm_list_scheduling_services)"),
      from: day("First day to search"),
      to: day("Last day to search (at most 7 days after `from`; defaults to `from`)").optional(),
      period: z.enum(["manha", "tarde", "noite", "qualquer"]).optional().describe("Part of the day: manha (morning), tarde (afternoon), noite (evening), qualquer (any)"),
      resourceIds: z.array(z.string()).max(10).optional().describe("Restrict the search to these resources (e.g. a preferred professional)"),
      partySize: z.number().int().min(1).max(4).optional().describe("People at the same time (1-4)"),
      rescheduleAppointmentId: z.string().optional().describe("When rescheduling: the appointment being moved (its own slot does not count as taken)"),
      variantKey: z.string().optional().describe("Service variant key, when the service has variants"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of slots (default 3)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const result = await client.get(
          "/api/v1/scheduling/slots",
          compact({
            serviceId: args.serviceId,
            from: args.from,
            to: args.to,
            period: args.period,
            resourceIds: args.resourceIds?.join(","),
            partySize: args.partySize === undefined ? undefined : String(args.partySize),
            rescheduleAppointmentId: args.rescheduleAppointmentId,
            variantKey: args.variantKey,
            limit: args.limit === undefined ? undefined : String(args.limit),
          }) as Record<string, string>
        );
        return successResult(result);
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_list_agenda",
    "List appointments of a day or a date range, in chronological order, with a stable cursor. A key with agenda: view_own only sees the appointments where its member is the professional or the creator.",
    {
      from: day("First day"),
      to: day("Last day (defaults to `from`)").optional(),
      status: z
        .enum(["pending_approval", "scheduled", "confirmed", "checked_in", "completed", "no_show", "cancelled", "rescheduled"])
        .optional()
        .describe("Filter by status"),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)"),
      cursor: z.string().optional().describe("nextCursor from the previous page"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(
          await client.get(
            "/api/v1/scheduling/appointments",
            compact({ from: args.from, to: args.to, status: args.status, limit: args.limit === undefined ? undefined : String(args.limit), cursor: args.cursor }) as Record<string, string>
          )
        );
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_get_appointment",
    "Get one appointment with its open conflicts, who booked it and its status history. 404 means it does not exist or the key cannot see it.",
    { appointmentId: z.string().describe("Appointment ID") },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.get("/api/v1/scheduling/appointments/get", { id: args.appointmentId }));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_list_scheduling_pending",
    "List what needs a human decision: proposals waiting for approval, open conflicts (e.g. after closing a resource), appointments without an outcome and one-tap suggestions. Up to 50 each; `capped` says there are more.",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        return successResult(await client.get("/api/v1/scheduling/pending"));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  const bookFields = {
    serviceId: z.string().describe("Service ID"),
    startsAtLocal: localTime("Start of the appointment."),
    contactId: z.string().optional().describe("Customer contact ID"),
    leadId: z.string().optional().describe("Customer lead ID (adds the booking to the lead timeline)"),
    conversationId: z.string().optional().describe("Conversation the booking came from"),
    resourceIds: resourceIds.optional(),
    variantKey: z.string().optional().describe("Service variant key"),
    force: force.optional(),
    notes: z.string().max(500).optional().describe("Internal note (never shown to the customer)"),
  };

  server.tool(
    "crm_preview_appointment",
    "Dry run of a booking: returns the resource plan and warnings WITHOUT writing anything. ALWAYS call this before crm_book_appointment, and again after any change of time or resources. A 409 here carries `violations` and up to 3 `alternatives` (Slot format): offer one of them. With rescheduleAppointmentId it simulates moving that appointment.",
    { ...bookFields, rescheduleAppointmentId: z.string().optional().describe("Simulate rescheduling this appointment instead of a new booking") },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/appointments/preview", compact(args)));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_book_appointment",
    "Book an appointment (same rules as the app). Only after crm_preview_appointment succeeded and the customer agreed to that exact time. `idempotencyKey` is REQUIRED: generate a unique key per booking intent and reuse the SAME key only when retrying the identical request (the same key + same data returns the same appointment; the same key with other data is a 409 idempotency_key_reused). On a 409 sched_rules the result has `violations` and `alternatives`: offer one of them, never retry the same time and never force a block code.",
    {
      ...bookFields,
      idempotencyKey: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/, "Letters, digits and . _ : - only")
        .describe("Required. Unique per booking intent (e.g. a UUID); reuse only to retry the identical request"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ idempotencyKey, ...rest }) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/appointments/book", compact({ ...rest, requestId: idempotencyKey })));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_reschedule_appointment",
    "Move an appointment to a new time: creates the new appointment and closes the old one (rescheduled) atomically. Get the new time from crm_find_slots (with rescheduleAppointmentId) and preview it first (crm_preview_appointment with rescheduleAppointmentId). A 409 carries alternatives. Send an idempotencyKey to make a retry safe.",
    {
      appointmentId: z.string().describe("Appointment to move"),
      startsAtLocal: localTime("New start."),
      resourceIds: resourceIds.optional(),
      force: force.optional(),
      idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional().describe("Recommended: makes a retry return the same result"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ idempotencyKey, ...rest }) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/appointments/reschedule", compact({ ...rest, requestId: idempotencyKey })));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_cancel_appointment",
    "Cancel an appointment (frees the resources and fires the appointment.cancelled webhook). `lateCancel` in the result says it was inside the late-cancellation window. Confirm with the user first.",
    {
      appointmentId: z.string().describe("Appointment to cancel"),
      reason: z.string().max(200).optional().describe("Why it was cancelled"),
      cancelledBy: z.enum(["staff", "client"]).optional().describe("Who asked for the cancellation (default staff)"),
    },
    { destructiveHint: true },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/appointments/cancel", compact(args)));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  const ACTIONS: Record<string, Record<string, string>> = {
    approve: { action: "approve" },
    reject: { action: "reject" },
    confirm: { to: "confirmed" },
    check_in: { to: "checked_in" },
    complete: { to: "completed" },
    no_show: { to: "no_show" },
  };
  server.tool(
    "crm_set_appointment_status",
    "Change an appointment's status: approve (accept a proposal waiting for approval), reject (refuse that proposal = cancel), confirm, check_in (customer arrived), complete (attended), no_show. An invalid transition is a 400 with the reason. Use crm_undo_appointment_status to revert the last change.",
    {
      appointmentId: z.string().describe("Appointment ID"),
      action: z.enum(["approve", "reject", "confirm", "check_in", "complete", "no_show"]).describe("What happened"),
      reason: z.string().max(200).optional().describe("Reason (used with reject)"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(
          await client.post("/api/v1/scheduling/appointments/status", compact({ appointmentId: args.appointmentId, ...ACTIONS[args.action], reason: args.reason }))
        );
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_undo_appointment_status",
    "Undo the last status change of an appointment (e.g. a wrong check-in). Returns `restoredTo`. A 409 means the slot was taken in the meantime.",
    { appointmentId: z.string().describe("Appointment ID") },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/appointments/undo-status", args));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_change_appointment_resources",
    "Change the room, professional or equipment of an appointment without changing its time. Same capacity rules as booking: a 409 carries alternatives.",
    {
      appointmentId: z.string().describe("Appointment ID"),
      resourceIds: resourceIds.describe("The full new set of resources"),
      force: force.optional(),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/appointments/resources", compact(args)));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  const scope = {
    resourceId: z.string().optional().describe("The resource to act on. Omit to act on the WHOLE agenda or, with resourceKind, on every resource of that kind (needs agenda: manage)"),
    resourceKind: z.enum(["person", "room", "equipment"]).optional().describe("With no resourceId: every resource of this kind"),
    fromLocalDate: day("First day"),
    toLocalDate: day("Last day (up to 60 days; defaults to the first day)").optional(),
    mode: z.enum(["preview", "commit"]).optional().describe("preview (default) writes nothing; commit applies"),
    acceptAffected: z.boolean().optional().describe("Required on commit when appointments are affected: a human accepted the impact"),
    expectedAffected: z.number().optional().describe("On commit: the `affected` count the preview showed; a different count is refused"),
  };

  server.tool(
    "crm_close_resource",
    "Close a resource on a date range (or set special hours / extra hours / a block). SAFE FLOW: call with mode preview (the default) and read `affected` and `items` (each appointment is reallocated or becomes a conflict); show the impact to a human; only then call again with mode commit, acceptAffected true and expectedAffected equal to the preview's `affected`. Rooms and equipment are reallocated; people become conflicts to resolve (crm_list_scheduling_pending, crm_resolve_conflict). Above 40 affected the work continues in batches: poll crm_get_closure_run with the returned runId. Closing the whole agenda needs agenda: manage.",
    {
      ...scope,
      kind: z.enum(["closed", "custom", "extra", "block"]).optional().describe("closed (whole day, default), custom (special hours), extra (extra hours), block (block an interval)"),
      intervals: z
        .array(z.object({ startMin: z.number().int(), endMin: z.number().int() }))
        .max(6)
        .optional()
        .describe("Minutes since midnight; required for custom, extra and block"),
      reasonCode: z.enum(["no_staff", "maintenance", "day_off", "holiday", "other"]).optional().describe("Reason category"),
      reason: z.string().max(120).optional().describe("Free-text reason"),
    },
    { destructiveHint: true },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/resources/day", compact(args)));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_reopen_resource",
    "Reopen a resource: removes the MANUAL exceptions of the chosen kind (default closed) on the date range; it does not undo reallocations already made. Same preview then commit flow as crm_close_resource (mode preview is the default).",
    {
      ...scope,
      kind: z.enum(["closed", "custom", "extra", "block"]).optional().describe("Which kind of exception to remove (default closed)"),
    },
    { destructiveHint: true },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/resources/reopen", compact(args)));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_get_closure_run",
    "Progress and result of a closure that runs in batches (the runId comes from crm_close_resource). Needs agenda: view_all.",
    { runId: z.string().describe("Closure run ID") },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.get("/api/v1/scheduling/closures/get", { runId: args.runId }));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );

  server.tool(
    "crm_resolve_conflict",
    "Resolve an open scheduling conflict (from crm_list_scheduling_pending) by one of four ways: resource (use other resources), reschedule (a new time from crm_find_slots), cancel, or manual (mark as handled, with a note). A 409 carries alternatives.",
    {
      conflictId: z.string().describe("Conflict ID"),
      action: z.enum(["resource", "reschedule", "cancel", "manual"]).describe("How to resolve"),
      resourceIds: z.array(z.string()).max(10).optional().describe("For resource (required) and reschedule (optional): the resources to use"),
      startsAtLocal: z
        .string()
        .regex(LOCAL_TIME, "Use YYYY-MM-DDTHH:mm")
        .optional()
        .describe("For reschedule (required): new start, local time YYYY-MM-DDTHH:mm, taken from crm_find_slots"),
      reason: z.string().max(200).optional().describe("For cancel"),
      note: z.string().max(200).optional().describe("For manual"),
      force: force.optional(),
    },
    { destructiveHint: true },
    async ({ conflictId, action, ...rest }) => {
      try {
        return successResult(await client.post("/api/v1/scheduling/conflicts/resolve", { conflictId, action: compact({ type: action, ...rest }) }));
      } catch (error) {
        return schedulingError(error);
      }
    }
  );
}
