import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";

function buildTaskSearchText(task: { title: string; description?: string; tags?: string[] }): string {
  return [task.title, task.description, ...(task.tags || [])].filter(Boolean).join(" ");
}

// Shared validators
const taskTypeValidator = v.union(v.literal("task"), v.literal("reminder"));
const taskStatusValidator = v.union(v.literal("pending"), v.literal("in_progress"), v.literal("completed"), v.literal("cancelled"));
const taskPriorityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"));
const activityTypeValidator = v.union(
  v.literal("todo"), v.literal("call"), v.literal("email"),
  v.literal("follow_up"), v.literal("meeting"), v.literal("research")
);
const recurrenceValidator = v.object({
  pattern: v.union(v.literal("daily"), v.literal("weekly"), v.literal("biweekly"), v.literal("monthly")),
  endDate: v.optional(v.number()),
  lastGeneratedAt: v.optional(v.number()),
});
const checklistItemValidator = v.object({
  id: v.string(),
  title: v.string(),
  completed: v.boolean(),
});

// Priority order for sorting
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

// ===== Public Queries =====

// Get tasks with filters
export const getTasks = query({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(taskStatusValidator),
    priority: v.optional(taskPriorityValidator),
    assignedTo: v.optional(v.id("teamMembers")),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    type: v.optional(taskTypeValidator),
    activityType: v.optional(activityTypeValidator),
    dueBefore: v.optional(v.number()),
    dueAfter: v.optional(v.number()),
    search: v.optional(v.string()),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const limit = args.limit ?? 200;

    // Full-text search path
    if (args.search) {
      let results = await ctx.db
        .query("tasks")
        .withSearchIndex("search_tasks", (q) =>
          q.search("searchText", args.search!).eq("organizationId", args.organizationId)
        )
        .take(limit);

      // Apply JS filters on search results
      if (args.status) results = results.filter(t => t.status === args.status);
      if (args.priority) results = results.filter(t => t.priority === args.priority);
      if (args.assignedTo) results = results.filter(t => t.assignedTo === args.assignedTo);
      if (args.type) results = results.filter(t => t.type === args.type);
      if (args.activityType) results = results.filter(t => t.activityType === args.activityType);
      if (args.leadId) results = results.filter(t => t.leadId === args.leadId);
      if (args.contactId) results = results.filter(t => t.contactId === args.contactId);

      const [assigneeMap, leadMap, contactMap] = await Promise.all([
        batchGet(ctx.db, results.map(t => t.assignedTo)),
        batchGet(ctx.db, results.map(t => t.leadId)),
        batchGet(ctx.db, results.map(t => t.contactId)),
      ]);

      return results.map(task => ({
        ...task,
        assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
        lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
        contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
      }));
    }

    // Index-based query path — pick best index
    let q;
    if (args.assignedTo && args.status) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_assigned_and_status", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!).eq("status", args.status!)
      );
    } else if (args.assignedTo) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_assigned", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!)
      );
    } else if (args.status) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_status", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    } else if (args.type) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_type", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("type", args.type!)
      );
    } else if (args.leadId) {
      q = ctx.db.query("tasks").withIndex("by_lead", (idx) =>
        idx.eq("leadId", args.leadId!)
      );
    } else if (args.contactId) {
      q = ctx.db.query("tasks").withIndex("by_contact", (idx) =>
        idx.eq("contactId", args.contactId!)
      );
    } else {
      q = ctx.db.query("tasks").withIndex("by_organization", (idx) =>
        idx.eq("organizationId", args.organizationId)
      );
    }

    let tasks = await q.order("desc").take(limit * 3);

    // Apply remaining JS filters
    if (args.priority) tasks = tasks.filter(t => t.priority === args.priority);
    if (args.activityType) tasks = tasks.filter(t => t.activityType === args.activityType);
    if (args.dueBefore) tasks = tasks.filter(t => t.dueDate != null && t.dueDate <= args.dueBefore!);
    if (args.dueAfter) tasks = tasks.filter(t => t.dueDate != null && t.dueDate >= args.dueAfter!);
    // Apply filters not covered by the chosen index
    if (args.status && !args.assignedTo) {
      // already handled by index
    }
    if (args.leadId && !(args.leadId && !args.assignedTo && !args.status && !args.type && !args.contactId)) {
      tasks = tasks.filter(t => t.leadId === args.leadId);
    }
    if (args.contactId && !(args.contactId && !args.assignedTo && !args.status && !args.type && !args.leadId)) {
      tasks = tasks.filter(t => t.contactId === args.contactId);
    }
    if (args.type && !(args.type && !args.assignedTo && !args.status)) {
      tasks = tasks.filter(t => t.type === args.type);
    }

    // Sort
    if (args.sortBy === "dueDate") {
      tasks.sort((a, b) => {
        const da = a.dueDate ?? Infinity;
        const db = b.dueDate ?? Infinity;
        return args.sortOrder === "desc" ? db - da : da - db;
      });
    } else if (args.sortBy === "priority") {
      tasks.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority] ?? 99;
        const pb = PRIORITY_ORDER[b.priority] ?? 99;
        return args.sortOrder === "desc" ? pb - pa : pa - pb;
      });
    }

    tasks = tasks.slice(0, limit);

    // Resolve relations
    const [assigneeMap, leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, tasks.map(t => t.assignedTo)),
      batchGet(ctx.db, tasks.map(t => t.leadId)),
      batchGet(ctx.db, tasks.map(t => t.contactId)),
    ]);

    return tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));
  },
});

// Get single task by ID
export const getTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;

    await requireAuth(ctx, task.organizationId);

    const [assignee, lead, contact, creator, commentsCount] = await Promise.all([
      task.assignedTo ? ctx.db.get(task.assignedTo) : null,
      task.leadId ? ctx.db.get(task.leadId) : null,
      task.contactId ? ctx.db.get(task.contactId) : null,
      ctx.db.get(task.createdBy),
      ctx.db.query("taskComments")
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
        .collect()
        .then(c => c.length),
    ]);

    return {
      ...task,
      assignee,
      lead,
      contact,
      creator,
      commentsCount,
    };
  },
});

// Get my tasks (assigned to current user)
export const getMyTasks = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const pendingTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_assigned_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("assignedTo", userMember._id).eq("status", "pending")
      )
      .take(200);

    const inProgressTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_assigned_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("assignedTo", userMember._id).eq("status", "in_progress")
      )
      .take(200);

    const allTasks = [...pendingTasks, ...inProgressTasks];

    // Sort: overdue first, then due today, then by priority
    const now = Date.now();
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const endOfDay = new Date().setHours(23, 59, 59, 999);

    allTasks.sort((a, b) => {
      const aOverdue = a.dueDate != null && a.dueDate < now ? 1 : 0;
      const bOverdue = b.dueDate != null && b.dueDate < now ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue; // overdue first

      const aDueToday = a.dueDate != null && a.dueDate >= startOfDay && a.dueDate <= endOfDay ? 1 : 0;
      const bDueToday = b.dueDate != null && b.dueDate >= startOfDay && b.dueDate <= endOfDay ? 1 : 0;
      if (aDueToday !== bDueToday) return bDueToday - aDueToday; // due today second

      return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    });

    // Resolve relations
    const [leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, allTasks.map(t => t.leadId)),
      batchGet(ctx.db, allTasks.map(t => t.contactId)),
    ]);

    return allTasks.map(task => ({
      ...task,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));
  },
});

// Get tasks by lead
export const getTasksByLead = query({
  args: { leadId: v.id("leads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return [];

    await requireAuth(ctx, lead.organizationId);

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .order("desc")
      .take(200);

    const assigneeMap = await batchGet(ctx.db, tasks.map(t => t.assignedTo));

    return tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
    }));
  },
});

// Get tasks by contact
export const getTasksByContact = query({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return [];

    await requireAuth(ctx, contact.organizationId);

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .take(200);

    const assigneeMap = await batchGet(ctx.db, tasks.map(t => t.assignedTo));

    return tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
    }));
  },
});

// Get task counts for sidebar badges / dashboard
export const getTaskCounts = query({
  args: {
    organizationId: v.id("organizations"),
    now: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const startOfDay = new Date(args.now).setHours(0, 0, 0, 0);
    const endOfDay = new Date(args.now).setHours(23, 59, 59, 999);

    // Fetch pending+in_progress tasks for the org
    const pendingTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending")
      )
      .take(1000);

    const inProgressTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "in_progress")
      )
      .take(1000);

    const allActive = [...pendingTasks, ...inProgressTasks];

    let overdue = 0;
    let dueToday = 0;
    let myPending = 0;
    let unassigned = 0;

    for (const task of allActive) {
      if (task.dueDate != null && task.dueDate < args.now && task.status !== "completed") {
        overdue++;
      }
      if (task.dueDate != null && task.dueDate >= startOfDay && task.dueDate <= endOfDay) {
        dueToday++;
      }
      if (task.assignedTo === userMember._id) {
        myPending++;
      }
      if (!task.assignedTo) {
        unassigned++;
      }
    }

    return { overdue, dueToday, myPending, unassigned };
  },
});

// Search tasks (full-text)
export const searchTasks = query({
  args: {
    organizationId: v.id("organizations"),
    searchText: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const results = await ctx.db
      .query("tasks")
      .withSearchIndex("search_tasks", (q) =>
        q.search("searchText", args.searchText).eq("organizationId", args.organizationId)
      )
      .take(args.limit ?? 50);

    const [assigneeMap, leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, results.map(t => t.assignedTo)),
      batchGet(ctx.db, results.map(t => t.leadId)),
      batchGet(ctx.db, results.map(t => t.contactId)),
    ]);

    return results.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));
  },
});

// ===== Public Mutations =====

// Create task
export const createTask = mutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(),
    type: taskTypeValidator,
    priority: taskPriorityValidator,
    activityType: v.optional(activityTypeValidator),
    description: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    assignedTo: v.optional(v.id("teamMembers")),
    recurrence: v.optional(recurrenceValidator),
    checklist: v.optional(v.array(checklistItemValidator)),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const now = Date.now();

    const taskId = await ctx.db.insert("tasks", {
      organizationId: args.organizationId,
      title: args.title,
      description: args.description,
      type: args.type,
      status: "pending",
      priority: args.priority,
      activityType: args.activityType,
      dueDate: args.dueDate,
      leadId: args.leadId,
      contactId: args.contactId,
      assignedTo: args.assignedTo,
      createdBy: userMember._id,
      recurrence: args.recurrence,
      checklist: args.checklist,
      tags: args.tags,
      searchText: buildTaskSearchText({ title: args.title, description: args.description, tags: args.tags }),
      createdAt: now,
      updatedAt: now,
    });

    // Schedule reminder if type=reminder and dueDate
    if (args.type === "reminder" && args.dueDate) {
      const delay = Math.max(0, args.dueDate - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "task",
      entityId: taskId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { title: args.title, type: args.type },
      description: buildAuditDescription({ action: "create", entityType: "task", metadata: { title: args.title } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity if task is linked to a lead
    if (args.leadId) {
      await ctx.db.insert("activities", {
        organizationId: args.organizationId,
        leadId: args.leadId,
        type: "task_created",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: `Task "${args.title}" created`,
        metadata: { taskId, type: args.type },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "task.created",
      payload: { taskId, title: args.title, type: args.type, priority: args.priority, dueDate: args.dueDate, assignedTo: args.assignedTo },
    });

    // Email notification
    if (args.assignedTo && args.assignedTo !== userMember._id) {
      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: args.organizationId,
        recipientMemberId: args.assignedTo,
        eventType: "taskAssigned",
        templateData: {
          taskTitle: args.title,
          dueDate: args.dueDate ? new Date(args.dueDate).toLocaleDateString("pt-BR") : undefined,
          assignedByName: userMember.name,
          leadTitle: undefined,
          taskUrl: `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/app/tarefas`,
        },
      });
    }

    return taskId;
  },
});

// Update task
export const updateTask = mutation({
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(taskPriorityValidator),
    activityType: v.optional(activityTypeValidator),
    dueDate: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    status: v.optional(taskStatusValidator),
    tags: v.optional(v.array(v.string())),
    recurrence: v.optional(recurrenceValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    const fields = ["title", "description", "priority", "activityType", "dueDate", "leadId", "contactId", "status", "tags", "recurrence"] as const;
    for (const field of fields) {
      if (args[field] !== undefined && JSON.stringify(args[field]) !== JSON.stringify((task as any)[field])) {
        changes[field] = args[field];
        before[field] = (task as any)[field];
      }
    }

    if (Object.keys(changes).length === 0) return null;

    // Rebuild searchText if title/description/tags changed
    if (changes.title || changes.description || changes.tags) {
      changes.searchText = buildTaskSearchText({
        title: changes.title ?? task.title,
        description: changes.description ?? task.description,
        tags: changes.tags ?? task.tags,
      });
    }

    await ctx.db.patch(args.taskId, {
      ...changes,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.updated",
      payload: { taskId: args.taskId, changes },
    });

    return null;
  },
});

// Complete task
export const completeTask = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.taskId, {
      status: "completed",
      completedAt: now,
      updatedAt: now,
    });

    // If recurring parent: schedule next instance generation
    if (task.recurrence) {
      await ctx.scheduler.runAfter(0, internal.tasks.processRecurringTasks);
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: task.status }, after: { status: "completed" } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { status: task.status }, after: { status: "completed" } } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity if linked to a lead
    if (task.leadId) {
      await ctx.db.insert("activities", {
        organizationId: task.organizationId,
        leadId: task.leadId,
        type: "task_completed",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: `Task "${task.title}" completed`,
        metadata: { taskId: args.taskId },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.completed",
      payload: { taskId: args.taskId, title: task.title },
    });

    return null;
  },
});

// Cancel task
export const cancelTask = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.taskId, {
      status: "cancelled",
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: task.status }, after: { status: "cancelled" } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { status: task.status }, after: { status: "cancelled" } } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.cancelled",
      payload: { taskId: args.taskId, title: task.title },
    });

    return null;
  },
});

// Assign task
export const assignTask = mutation({
  args: {
    taskId: v.id("tasks"),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const oldAssignedTo = task.assignedTo;
    const now = Date.now();

    const newAssignee = args.assignedTo ? await ctx.db.get(args.assignedTo) : null;

    await ctx.db.patch(args.taskId, {
      assignedTo: args.assignedTo,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "assign",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        before: { assignedTo: oldAssignedTo },
        after: { assignedTo: args.assignedTo },
      },
      metadata: { title: task.title, assigneeName: newAssignee?.name },
      description: buildAuditDescription({ action: "assign", entityType: "task", metadata: { title: task.title, assigneeName: newAssignee?.name }, changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } } }),
      severity: "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.assigned",
      payload: { taskId: args.taskId, oldAssignedTo, newAssignedTo: args.assignedTo },
    });

    // Email notification
    if (args.assignedTo) {
      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: task.organizationId,
        recipientMemberId: args.assignedTo,
        eventType: "taskAssigned",
        templateData: {
          taskTitle: task.title,
          dueDate: task.dueDate ? new Date(task.dueDate).toLocaleDateString("pt-BR") : undefined,
          assignedByName: userMember.name,
          leadTitle: undefined,
          taskUrl: `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/app/tarefas`,
        },
      });
    }

    return null;
  },
});

// Snooze task
export const snoozeTask = mutation({
  args: {
    taskId: v.id("tasks"),
    snoozedUntil: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.taskId, {
      snoozedUntil: args.snoozedUntil,
      reminderTriggered: false,
      updatedAt: now,
    });

    // Reschedule reminder
    if (task.type === "reminder") {
      const delay = Math.max(0, args.snoozedUntil - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId: args.taskId });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.snoozed",
      payload: { taskId: args.taskId, snoozedUntil: args.snoozedUntil },
    });

    return null;
  },
});

// Delete task
export const deleteTask = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();

    // Log audit entry before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "delete",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "delete", entityType: "task", metadata: { title: task.title } }),
      severity: "high",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.deleted",
      payload: { taskId: args.taskId, title: task.title },
    });

    // Cascade delete comments
    const comments = await ctx.db
      .query("taskComments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const comment of comments) {
      await ctx.db.delete(comment._id);
    }

    await ctx.db.delete(args.taskId);

    return null;
  },
});

// Update checklist
export const updateChecklist = mutation({
  args: {
    taskId: v.id("tasks"),
    checklist: v.array(checklistItemValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    await requireAuth(ctx, task.organizationId);

    await ctx.db.patch(args.taskId, {
      checklist: args.checklist,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Toggle checklist item
export const toggleChecklistItem = mutation({
  args: {
    taskId: v.id("tasks"),
    itemId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    await requireAuth(ctx, task.organizationId);

    const checklist = (task.checklist || []).map(item =>
      item.id === args.itemId ? { ...item, completed: !item.completed } : item
    );

    await ctx.db.patch(args.taskId, {
      checklist,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Bulk update tasks
export const bulkUpdateTasks = mutation({
  args: {
    taskIds: v.array(v.id("tasks")),
    action: v.union(v.literal("complete"), v.literal("cancel"), v.literal("assign"), v.literal("delete")),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.taskIds.length === 0) return null;

    // Auth from first task
    const firstTask = await ctx.db.get(args.taskIds[0]);
    if (!firstTask) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, firstTask.organizationId);
    const now = Date.now();

    for (const taskId of args.taskIds) {
      const task = await ctx.db.get(taskId);
      if (!task) continue;

      if (args.action === "complete") {
        await ctx.db.patch(taskId, { status: "completed", completedAt: now, updatedAt: now });
        if (task.leadId) {
          await ctx.db.insert("activities", {
            organizationId: task.organizationId,
            leadId: task.leadId,
            type: "task_completed",
            actorId: userMember._id,
            actorType: userMember.type === "ai" ? "ai" : "human",
            content: `Task "${task.title}" completed`,
            metadata: { taskId },
            createdAt: now,
          });
        }
      } else if (args.action === "cancel") {
        await ctx.db.patch(taskId, { status: "cancelled", updatedAt: now });
      } else if (args.action === "assign") {
        await ctx.db.patch(taskId, { assignedTo: args.assignedTo, updatedAt: now });
      } else if (args.action === "delete") {
        const comments = await ctx.db.query("taskComments")
          .withIndex("by_task", (q) => q.eq("taskId", taskId))
          .collect();
        for (const comment of comments) {
          await ctx.db.delete(comment._id);
        }
        await ctx.db.delete(taskId);
      }
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: firstTask.organizationId,
      entityType: "task",
      entityId: args.taskIds[0],
      action: args.action === "delete" ? "delete" : "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { bulkAction: args.action, count: args.taskIds.length },
      description: `Bulk ${args.action} on ${args.taskIds.length} tasks`,
      severity: args.action === "delete" ? "high" : "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: firstTask.organizationId,
      event: `task.bulk_${args.action}`,
      payload: { taskIds: args.taskIds, action: args.action },
    });

    return null;
  },
});

// ===== Internal Functions (for HTTP API) =====

// Internal: Get tasks (paginated)
export const internalGetTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(taskStatusValidator),
    priority: v.optional(taskPriorityValidator),
    assignedTo: v.optional(v.id("teamMembers")),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    type: v.optional(taskTypeValidator),
    activityType: v.optional(activityTypeValidator),
    dueBefore: v.optional(v.number()),
    dueAfter: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);

    let q;
    if (args.assignedTo && args.status) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_assigned_and_status", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!).eq("status", args.status!)
      );
    } else if (args.assignedTo) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_assigned", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!)
      );
    } else if (args.status) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_status", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    } else if (args.type) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_type", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("type", args.type!)
      );
    } else if (args.leadId) {
      q = ctx.db.query("tasks").withIndex("by_lead", (idx) =>
        idx.eq("leadId", args.leadId!)
      );
    } else if (args.contactId) {
      q = ctx.db.query("tasks").withIndex("by_contact", (idx) =>
        idx.eq("contactId", args.contactId!)
      );
    } else {
      q = ctx.db.query("tasks").withIndex("by_organization", (idx) =>
        idx.eq("organizationId", args.organizationId)
      );
    }

    const rawTasks = await q.order("desc").take(limit + 1 + (cursor ? limit * 3 : 0));

    // Apply cursor filter
    let filtered = rawTasks;
    if (cursor) {
      filtered = rawTasks.filter(
        (t) =>
          t._creationTime < cursor.ts ||
          (t._creationTime === cursor.ts && t._id < cursor.id)
      );
    }

    // Apply remaining JS filters
    if (args.priority) filtered = filtered.filter(t => t.priority === args.priority);
    if (args.activityType) filtered = filtered.filter(t => t.activityType === args.activityType);
    if (args.dueBefore) filtered = filtered.filter(t => t.dueDate != null && t.dueDate <= args.dueBefore!);
    if (args.dueAfter) filtered = filtered.filter(t => t.dueDate != null && t.dueDate >= args.dueAfter!);

    const { items: tasks, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    // Resolve relations
    const [assigneeMap, leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, tasks.map(t => t.assignedTo)),
      batchGet(ctx.db, tasks.map(t => t.leadId)),
      batchGet(ctx.db, tasks.map(t => t.contactId)),
    ]);

    const tasksWithData = tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));

    return { tasks: tasksWithData, nextCursor, hasMore };
  },
});

// Internal: Get single task
export const internalGetTask = internalQuery({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;

    const [assignee, lead, contact, creator] = await Promise.all([
      task.assignedTo ? ctx.db.get(task.assignedTo) : null,
      task.leadId ? ctx.db.get(task.leadId) : null,
      task.contactId ? ctx.db.get(task.contactId) : null,
      ctx.db.get(task.createdBy),
    ]);

    return { ...task, assignee, lead, contact, creator };
  },
});

// Internal: Get my tasks (for API — uses teamMemberId)
export const internalGetMyTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const pendingTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_assigned_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("assignedTo", args.teamMemberId).eq("status", "pending")
      )
      .take(200);

    const inProgressTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_assigned_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("assignedTo", args.teamMemberId).eq("status", "in_progress")
      )
      .take(200);

    const allTasks = [...pendingTasks, ...inProgressTasks];

    const now = Date.now();
    allTasks.sort((a, b) => {
      const aOverdue = a.dueDate != null && a.dueDate < now ? 1 : 0;
      const bOverdue = b.dueDate != null && b.dueDate < now ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    });

    const [leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, allTasks.map(t => t.leadId)),
      batchGet(ctx.db, allTasks.map(t => t.contactId)),
    ]);

    return allTasks.map(task => ({
      ...task,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));
  },
});

// Internal: Get overdue tasks
export const internalGetOverdueTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);
    const now = Date.now();

    const rawTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_due_date", (q) =>
        q.eq("organizationId", args.organizationId).lt("dueDate", now)
      )
      .order("desc")
      .take(limit + 1 + (cursor ? limit * 3 : 0));

    // Only pending/in_progress
    let filtered = rawTasks.filter(t => t.status === "pending" || t.status === "in_progress");

    if (cursor) {
      filtered = filtered.filter(
        (t) =>
          t._creationTime < cursor.ts ||
          (t._creationTime === cursor.ts && t._id < cursor.id)
      );
    }

    const { items: tasks, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    const [assigneeMap, leadMap] = await Promise.all([
      batchGet(ctx.db, tasks.map(t => t.assignedTo)),
      batchGet(ctx.db, tasks.map(t => t.leadId)),
    ]);

    const tasksWithData = tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
    }));

    return { tasks: tasksWithData, nextCursor, hasMore };
  },
});

// Internal: Search tasks
export const internalSearchTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    searchText: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("tasks")
      .withSearchIndex("search_tasks", (q) =>
        q.search("searchText", args.searchText).eq("organizationId", args.organizationId)
      )
      .take(args.limit ?? 50);

    const [assigneeMap, leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, results.map(t => t.assignedTo)),
      batchGet(ctx.db, results.map(t => t.leadId)),
      batchGet(ctx.db, results.map(t => t.contactId)),
    ]);

    return results.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));
  },
});

// Internal: Create task
export const internalCreateTask = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(),
    type: taskTypeValidator,
    priority: taskPriorityValidator,
    activityType: v.optional(activityTypeValidator),
    description: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    assignedTo: v.optional(v.id("teamMembers")),
    recurrence: v.optional(recurrenceValidator),
    checklist: v.optional(v.array(checklistItemValidator)),
    tags: v.optional(v.array(v.string())),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const now = Date.now();

    const taskId = await ctx.db.insert("tasks", {
      organizationId: args.organizationId,
      title: args.title,
      description: args.description,
      type: args.type,
      status: "pending",
      priority: args.priority,
      activityType: args.activityType,
      dueDate: args.dueDate,
      leadId: args.leadId,
      contactId: args.contactId,
      assignedTo: args.assignedTo,
      createdBy: args.teamMemberId,
      recurrence: args.recurrence,
      checklist: args.checklist,
      tags: args.tags,
      searchText: buildTaskSearchText({ title: args.title, description: args.description, tags: args.tags }),
      createdAt: now,
      updatedAt: now,
    });

    // Schedule reminder
    if (args.type === "reminder" && args.dueDate) {
      const delay = Math.max(0, args.dueDate - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "task",
      entityId: taskId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: { title: args.title, type: args.type },
      description: buildAuditDescription({ action: "create", entityType: "task", metadata: { title: args.title } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity if linked to lead
    if (args.leadId) {
      await ctx.db.insert("activities", {
        organizationId: args.organizationId,
        leadId: args.leadId,
        type: "task_created",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        content: `Task "${args.title}" created`,
        metadata: { taskId, type: args.type },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "task.created",
      payload: { taskId, title: args.title, type: args.type, priority: args.priority, dueDate: args.dueDate, assignedTo: args.assignedTo },
    });

    // Email notification
    if (args.assignedTo && args.assignedTo !== args.teamMemberId) {
      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: args.organizationId,
        recipientMemberId: args.assignedTo,
        eventType: "taskAssigned",
        templateData: {
          taskTitle: args.title,
          dueDate: args.dueDate ? new Date(args.dueDate).toLocaleDateString("pt-BR") : undefined,
          assignedByName: teamMember.name,
          leadTitle: undefined,
          taskUrl: `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/app/tarefas`,
        },
      });
    }

    return taskId;
  },
});

// Internal: Update task
export const internalUpdateTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(taskPriorityValidator),
    activityType: v.optional(activityTypeValidator),
    dueDate: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    const fields = ["title", "description", "priority", "activityType", "dueDate", "tags"] as const;
    for (const field of fields) {
      if (args[field] !== undefined && JSON.stringify(args[field]) !== JSON.stringify((task as any)[field])) {
        changes[field] = args[field];
        before[field] = (task as any)[field];
      }
    }

    if (Object.keys(changes).length === 0) return null;

    if (changes.title || changes.description || changes.tags) {
      changes.searchText = buildTaskSearchText({
        title: changes.title ?? task.title,
        description: changes.description ?? task.description,
        tags: changes.tags ?? task.tags,
      });
    }

    await ctx.db.patch(args.taskId, { ...changes, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.updated",
      payload: { taskId: args.taskId, changes },
    });

    return null;
  },
});

// Internal: Complete task
export const internalCompleteTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const now = Date.now();

    await ctx.db.patch(args.taskId, { status: "completed", completedAt: now, updatedAt: now });

    if (task.recurrence) {
      await ctx.scheduler.runAfter(0, internal.tasks.processRecurringTasks);
    }

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: task.status }, after: { status: "completed" } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { status: task.status }, after: { status: "completed" } } }),
      severity: "medium",
      createdAt: now,
    });

    if (task.leadId) {
      await ctx.db.insert("activities", {
        organizationId: task.organizationId,
        leadId: task.leadId,
        type: "task_completed",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        content: `Task "${task.title}" completed`,
        metadata: { taskId: args.taskId },
        createdAt: now,
      });
    }

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.completed",
      payload: { taskId: args.taskId, title: task.title },
    });

    return null;
  },
});

// Internal: Delete task
export const internalDeleteTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const now = Date.now();

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "delete",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "delete", entityType: "task", metadata: { title: task.title } }),
      severity: "high",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.deleted",
      payload: { taskId: args.taskId, title: task.title },
    });

    const comments = await ctx.db.query("taskComments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const comment of comments) {
      await ctx.db.delete(comment._id);
    }

    await ctx.db.delete(args.taskId);

    return null;
  },
});

// Internal: Assign task
export const internalAssignTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    assignedTo: v.optional(v.id("teamMembers")),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const oldAssignedTo = task.assignedTo;
    const now = Date.now();
    const newAssignee = args.assignedTo ? await ctx.db.get(args.assignedTo) : null;

    await ctx.db.patch(args.taskId, { assignedTo: args.assignedTo, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "assign",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } },
      metadata: { title: task.title, assigneeName: newAssignee?.name },
      description: buildAuditDescription({ action: "assign", entityType: "task", metadata: { title: task.title, assigneeName: newAssignee?.name }, changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } } }),
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.assigned",
      payload: { taskId: args.taskId, oldAssignedTo, newAssignedTo: args.assignedTo },
    });

    // Email notification
    if (args.assignedTo) {
      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: task.organizationId,
        recipientMemberId: args.assignedTo,
        eventType: "taskAssigned",
        templateData: {
          taskTitle: task.title,
          dueDate: task.dueDate ? new Date(task.dueDate).toLocaleDateString("pt-BR") : undefined,
          assignedByName: teamMember.name,
          leadTitle: undefined,
          taskUrl: `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/app/tarefas`,
        },
      });
    }

    return null;
  },
});

// Internal: Snooze task
export const internalSnoozeTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    snoozedUntil: v.number(),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const now = Date.now();

    await ctx.db.patch(args.taskId, {
      snoozedUntil: args.snoozedUntil,
      reminderTriggered: false,
      updatedAt: now,
    });

    if (task.type === "reminder") {
      const delay = Math.max(0, args.snoozedUntil - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId: args.taskId });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.snoozed",
      payload: { taskId: args.taskId, snoozedUntil: args.snoozedUntil },
    });

    return null;
  },
});

// Internal: Bulk update
export const internalBulkUpdate = internalMutation({
  args: {
    taskIds: v.array(v.id("tasks")),
    action: v.union(v.literal("complete"), v.literal("cancel"), v.literal("assign"), v.literal("delete")),
    assignedTo: v.optional(v.id("teamMembers")),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    if (args.taskIds.length === 0) return null;

    const now = Date.now();
    let organizationId: string | null = null;

    for (const taskId of args.taskIds) {
      const task = await ctx.db.get(taskId);
      if (!task) continue;
      if (!organizationId) organizationId = task.organizationId;

      if (args.action === "complete") {
        await ctx.db.patch(taskId, { status: "completed", completedAt: now, updatedAt: now });
        if (task.leadId) {
          await ctx.db.insert("activities", {
            organizationId: task.organizationId,
            leadId: task.leadId,
            type: "task_completed",
            actorId: teamMember._id,
            actorType: teamMember.type === "ai" ? "ai" : "human",
            content: `Task "${task.title}" completed`,
            metadata: { taskId },
            createdAt: now,
          });
        }
      } else if (args.action === "cancel") {
        await ctx.db.patch(taskId, { status: "cancelled", updatedAt: now });
      } else if (args.action === "assign") {
        await ctx.db.patch(taskId, { assignedTo: args.assignedTo, updatedAt: now });
      } else if (args.action === "delete") {
        const comments = await ctx.db.query("taskComments")
          .withIndex("by_task", (q) => q.eq("taskId", taskId))
          .collect();
        for (const comment of comments) {
          await ctx.db.delete(comment._id);
        }
        await ctx.db.delete(taskId);
      }
    }

    if (organizationId) {
      await ctx.db.insert("auditLogs", {
        organizationId: organizationId as any,
        entityType: "task",
        entityId: args.taskIds[0],
        action: args.action === "delete" ? "delete" : "update",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        metadata: { bulkAction: args.action, count: args.taskIds.length },
        description: `Bulk ${args.action} on ${args.taskIds.length} tasks`,
        severity: args.action === "delete" ? "high" : "medium",
        createdAt: now,
      });

      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: organizationId as any,
        event: `task.bulk_${args.action}`,
        payload: { taskIds: args.taskIds, action: args.action },
      });
    }

    return null;
  },
});

// Internal: Trigger reminder (idempotent)
export const triggerReminder = internalMutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;

    // Idempotent checks
    if (task.status !== "pending" && task.status !== "in_progress") return null;
    if (task.reminderTriggered) return null;

    // Check snooze
    const now = Date.now();
    if (task.snoozedUntil && task.snoozedUntil > now) return null;

    await ctx.db.patch(args.taskId, {
      reminderTriggered: true,
      updatedAt: now,
    });

    // Log activity if linked to lead
    if (task.leadId) {
      await ctx.db.insert("activities", {
        organizationId: task.organizationId,
        leadId: task.leadId,
        type: "task_created",
        actorId: task.createdBy,
        actorType: "system",
        content: `Reminder triggered: "${task.title}"`,
        metadata: { taskId: args.taskId },
        createdAt: now,
      });
    }

    // Fire webhook
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.reminder_triggered",
      payload: { taskId: args.taskId, title: task.title, dueDate: task.dueDate, assignedTo: task.assignedTo },
    });

    return null;
  },
});

// Internal: Process overdue reminders (cron sweep)
export const processOverdueReminders = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    // Find reminders that are overdue and not yet triggered
    const overdueTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_type")
      .order("asc")
      .take(500);

    for (const task of overdueTasks) {
      if (
        task.type === "reminder" &&
        (task.status === "pending" || task.status === "in_progress") &&
        task.dueDate != null &&
        task.dueDate <= now &&
        !task.reminderTriggered
      ) {
        // Check snooze
        if (task.snoozedUntil && task.snoozedUntil > now) continue;

        await ctx.db.patch(task._id, {
          reminderTriggered: true,
          updatedAt: now,
        });

        await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
          organizationId: task.organizationId,
          event: "task.reminder_triggered",
          payload: { taskId: task._id, title: task.title, dueDate: task.dueDate, assignedTo: task.assignedTo },
        });

        // Email notification
        if (task.assignedTo) {
          await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
            organizationId: task.organizationId,
            recipientMemberId: task.assignedTo,
            eventType: "taskOverdue",
            templateData: {
              taskTitle: task.title,
              dueDate: task.dueDate ? new Date(task.dueDate).toLocaleDateString("pt-BR") : "N/A",
              taskUrl: `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/app/tarefas`,
            },
          });
        }
      }
    }

    return null;
  },
});

// Internal: Process recurring tasks
export const processRecurringTasks = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    // Find completed tasks with recurrence
    const completedTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_status")
      .order("asc")
      .take(500);

    for (const task of completedTasks) {
      if (task.status !== "completed" || !task.recurrence) continue;

      // Check if already generated child after this completion
      if (task.recurrence.lastGeneratedAt && task.recurrence.lastGeneratedAt >= (task.completedAt || 0)) continue;

      // Check end date
      if (task.recurrence.endDate && now > task.recurrence.endDate) continue;

      // Calculate next due date
      let nextDueDate: number | undefined;
      if (task.dueDate) {
        const d = new Date(task.dueDate);
        switch (task.recurrence.pattern) {
          case "daily": d.setDate(d.getDate() + 1); break;
          case "weekly": d.setDate(d.getDate() + 7); break;
          case "biweekly": d.setDate(d.getDate() + 14); break;
          case "monthly": d.setMonth(d.getMonth() + 1); break;
        }
        nextDueDate = d.getTime();
      }

      // Create child task
      await ctx.db.insert("tasks", {
        organizationId: task.organizationId,
        title: task.title,
        description: task.description,
        type: task.type,
        status: "pending",
        priority: task.priority,
        activityType: task.activityType,
        dueDate: nextDueDate,
        leadId: task.leadId,
        contactId: task.contactId,
        assignedTo: task.assignedTo,
        createdBy: task.createdBy,
        recurrence: task.recurrence,
        parentTaskId: task._id,
        checklist: task.checklist?.map(item => ({ ...item, completed: false })),
        tags: task.tags,
        searchText: task.searchText,
        createdAt: now,
        updatedAt: now,
      });

      // Update parent to mark as generated
      await ctx.db.patch(task._id, {
        recurrence: { ...task.recurrence, lastGeneratedAt: now },
        updatedAt: now,
      });
    }

    return null;
  },
});
