import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

export function registerCalendarTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "calendar_list_events",
    "List calendar events in a date range with optional filters by assignee, event type, status, lead, or contact. Returns events sorted by start time.",
    {
      startDate: z
        .number()
        .describe("Start of date range (unix milliseconds)"),
      endDate: z
        .number()
        .describe("End of date range (unix milliseconds)"),
      assignedTo: z
        .string()
        .optional()
        .describe("Filter by assigned team member ID"),
      eventType: z
        .enum(["call", "meeting", "follow_up", "demo", "task", "reminder", "other"])
        .optional()
        .describe("Filter by event type"),
      status: z
        .enum(["scheduled", "completed", "cancelled"])
        .optional()
        .describe("Filter by event status"),
      leadId: z.string().optional().describe("Filter by linked lead ID"),
      contactId: z.string().optional().describe("Filter by linked contact ID"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of results to return"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = {
          startDate: String(args.startDate),
          endDate: String(args.endDate),
        };
        if (args.assignedTo) params.assignedTo = args.assignedTo;
        if (args.eventType) params.eventType = args.eventType;
        if (args.status) params.status = args.status;
        if (args.leadId) params.leadId = args.leadId;
        if (args.contactId) params.contactId = args.contactId;
        if (args.limit) params.limit = String(args.limit);
        if (args.cursor) params.cursor = args.cursor;
        const result = await client.get("/api/v1/calendar/events", params);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "calendar_create_event",
    "Create a new calendar event. Events can be linked to leads or contacts, assigned to team members, and include attendees, location, and meeting URL.",
    {
      title: z.string().describe("Event title"),
      eventType: z
        .enum(["call", "meeting", "follow_up", "demo", "task", "reminder", "other"])
        .describe("Type of event"),
      startTime: z
        .number()
        .describe("Event start time (unix milliseconds)"),
      endTime: z
        .number()
        .describe("Event end time (unix milliseconds)"),
      description: z.string().optional().describe("Event description"),
      allDay: z.boolean().optional().describe("Whether this is an all-day event"),
      leadId: z.string().optional().describe("Link event to a lead"),
      contactId: z.string().optional().describe("Link event to a contact"),
      assignedTo: z
        .string()
        .optional()
        .describe("Team member ID to assign the event to"),
      attendees: z
        .array(z.string())
        .optional()
        .describe("Array of team member IDs as attendees"),
      location: z.string().optional().describe("Event location"),
      meetingUrl: z.string().optional().describe("Video/meeting URL"),
      recurrence: z
        .object({
          pattern: z.enum(["daily", "weekly", "biweekly", "monthly"]).describe("Recurrence pattern"),
          endDate: z.number().optional().describe("End date for recurrence (unix ms)"),
        })
        .optional()
        .describe("Recurrence settings"),
      notes: z.string().optional().describe("Additional notes"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.post("/api/v1/calendar/events/create", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "calendar_get_event",
    "Get full details of a specific calendar event by its ID, including attendees, linked lead/contact, and recurrence info.",
    {
      id: z.string().describe("The event ID to retrieve"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const result = await client.get("/api/v1/calendar/events/get", { id: args.id });
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "calendar_update_event",
    "Update properties of an existing calendar event such as title, description, time, type, location, or meeting URL.",
    {
      eventId: z.string().describe("ID of the event to update"),
      title: z.string().optional().describe("New event title"),
      description: z.string().optional().describe("New event description"),
      eventType: z
        .enum(["call", "meeting", "follow_up", "demo", "task", "reminder", "other"])
        .optional()
        .describe("New event type"),
      startTime: z.number().optional().describe("New start time (unix ms)"),
      endTime: z.number().optional().describe("New end time (unix ms)"),
      allDay: z.boolean().optional().describe("Whether all-day"),
      location: z.string().optional().describe("New location"),
      meetingUrl: z.string().optional().describe("New meeting URL"),
      notes: z.string().optional().describe("New notes"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.post("/api/v1/calendar/events/update", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "calendar_delete_event",
    "Permanently delete a calendar event. This also deletes any child recurring events. This action cannot be undone.",
    {
      eventId: z.string().describe("ID of the event to delete"),
    },
    { destructiveHint: true },
    async (args) => {
      try {
        const result = await client.post("/api/v1/calendar/events/delete", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "calendar_reschedule_event",
    "Quickly reschedule a calendar event to a new time. Duration is preserved if only the start time is provided.",
    {
      eventId: z.string().describe("ID of the event to reschedule"),
      newStartTime: z
        .number()
        .describe("New start time (unix milliseconds)"),
      newEndTime: z
        .number()
        .optional()
        .describe("New end time (unix ms). If omitted, duration is preserved."),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.post("/api/v1/calendar/events/reschedule", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "calendar_complete_event",
    "Mark a scheduled calendar event as completed. A recurring event generates its next occurrence automatically. Only a scheduled event can be completed. Needs agenda: edit.",
    {
      eventId: z.string().describe("ID of the event to complete"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.post("/api/v1/calendar/events/complete", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "calendar_cancel_event",
    "Mark a scheduled calendar event as cancelled (the event stays in the calendar with status cancelled; use calendar_delete_event to remove it). Needs agenda: edit.",
    {
      eventId: z.string().describe("ID of the event to cancel"),
    },
    { destructiveHint: true },
    async (args) => {
      try {
        const result = await client.post("/api/v1/calendar/events/cancel", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
