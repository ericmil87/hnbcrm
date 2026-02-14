import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Helper: generate a timestamp N days + hours ago
function daysAgo(days: number, hours = 0): number {
  return Date.now() - (days * 24 + hours) * 60 * 60 * 1000;
}

export const seedMockData = mutation({
  args: {
    organizationId: v.id("organizations"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { organizationId } = args;

    // Validate org exists
    const org = await ctx.db.get(organizationId);
    if (!org) throw new Error("Organization not found");

    // Fetch existing board
    const board = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .first();
    if (!board) throw new Error("No board found — run createOrganization first");
    const boardId = board._id;

    // Fetch stages by order
    const allStages = await ctx.db
      .query("stages")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .collect();
    const stagesByName: Record<string, Id<"stages">> = {};
    for (const s of allStages) {
      stagesByName[s.name] = s._id;
    }
    const requiredStages = ["New Lead", "Qualified", "Proposal", "Negotiation", "Closed Won", "Closed Lost"];
    for (const name of requiredStages) {
      if (!stagesByName[name]) throw new Error(`Missing stage: ${name}`);
    }

    // Fetch lead sources
    const allSources = await ctx.db
      .query("leadSources")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect();
    const sourcesByName: Record<string, Id<"leadSources">> = {};
    for (const s of allSources) {
      sourcesByName[s.name] = s._id;
    }

    const now = Date.now();

    // ─── 1. TEAM MEMBERS ────────────────────────────────────────────
    const teamMemberData = [
      { name: "Sarah Chen", email: "sarah.chen@clawcrm.io", role: "manager" as const, type: "human" as const, status: "active" as const },
      { name: "Marcus Johnson", email: "marcus.j@clawcrm.io", role: "agent" as const, type: "human" as const, status: "active" as const },
      { name: "Emily Rodriguez", email: "emily.r@clawcrm.io", role: "agent" as const, type: "human" as const, status: "busy" as const },
      { name: "Alex Kim", email: "alex.kim@clawcrm.io", role: "agent" as const, type: "human" as const, status: "active" as const },
      { name: "Claw AI", email: undefined, role: "ai" as const, type: "ai" as const, status: "active" as const,
        capabilities: ["auto-reply", "qualification", "sentiment-analysis", "summarization", "handoff-detection"] },
    ];

    const teamMemberIds: Id<"teamMembers">[] = [];
    for (const m of teamMemberData) {
      const id = await ctx.db.insert("teamMembers", {
        organizationId,
        name: m.name,
        email: m.email,
        role: m.role,
        type: m.type,
        status: m.status,
        capabilities: m.capabilities,
        createdAt: daysAgo(7),
        updatedAt: daysAgo(7),
      });
      teamMemberIds.push(id);
    }

    const [sarah, marcus, emily, alex, clawAI] = teamMemberIds;

    // ─── 2. CONTACTS ────────────────────────────────────────────────
    const contactData = [
      { firstName: "James", lastName: "Wilson", email: "james.wilson@techcorp.com", phone: "+1-555-0101", company: "TechCorp Solutions", title: "VP of Engineering", whatsappNumber: "+15550101", tags: ["enterprise", "tech"] },
      { firstName: "Maria", lastName: "Garcia", email: "maria.garcia@globalretail.com", phone: "+1-555-0102", company: "Global Retail Inc", title: "Head of Operations", tags: ["retail", "enterprise"] },
      { firstName: "David", lastName: "Lee", email: "david.lee@startupxyz.io", phone: "+1-555-0103", company: "StartupXYZ", title: "CEO", whatsappNumber: "+15550103", tags: ["startup", "saas"] },
      { firstName: "Priya", lastName: "Patel", email: "priya.patel@financeplus.com", phone: "+1-555-0104", company: "FinancePlus", title: "Director of IT", tags: ["finance", "mid-market"] },
      { firstName: "Robert", lastName: "Chen", email: "robert.chen@megahealth.org", phone: "+1-555-0105", company: "MegaHealth Systems", title: "CTO", tags: ["healthcare", "enterprise"] },
      { firstName: "Sophie", lastName: "Martin", email: "sophie.m@creativestudio.co", phone: "+1-555-0106", company: "Creative Studio Co", title: "Founder", whatsappNumber: "+15550106", tags: ["agency", "startup"] },
      { firstName: "Ahmed", lastName: "Hassan", email: "ahmed.h@logisticspro.com", phone: "+1-555-0107", company: "LogisticsPro", title: "Supply Chain Manager", tags: ["logistics"] },
      { firstName: "Lisa", lastName: "Thompson", email: "lisa.t@edulearn.edu", phone: "+1-555-0108", company: "EduLearn Academy", title: "Dean of Technology", tags: ["education"] },
      { firstName: "Michael", lastName: "Brown", email: "michael.b@realestateco.com", phone: "+1-555-0109", company: "RealEstate Co", title: "Managing Director", tags: ["real-estate", "enterprise"] },
      { firstName: "Yuki", lastName: "Tanaka", email: "yuki.t@japantech.jp", phone: "+81-555-0110", company: "JapanTech Inc", title: "International Sales Director", tags: ["international", "tech"] },
      { firstName: "Carlos", lastName: "Rivera", email: "carlos.r@latamgrowth.com", phone: "+52-555-0111", company: "LatAm Growth Partners", title: "Partner", whatsappNumber: "+525550111", tags: ["consulting", "latam"] },
      { firstName: "Emma", lastName: "Johansson", email: "emma.j@nordicdesign.se", phone: "+46-555-0112", company: "Nordic Design AB", title: "Creative Director", tags: ["design", "nordic"] },
    ];

    const contactIds: Id<"contacts">[] = [];
    for (const c of contactData) {
      const id = await ctx.db.insert("contacts", {
        organizationId,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        company: c.company,
        title: c.title,
        whatsappNumber: c.whatsappNumber,
        tags: c.tags,
        createdAt: daysAgo(7, Math.floor(Math.random() * 48)),
        updatedAt: daysAgo(3, Math.floor(Math.random() * 24)),
      });
      contactIds.push(id);
    }

    // ─── 3. LEADS ───────────────────────────────────────────────────
    const leadDefs = [
      // New Lead (2)
      { title: "TechCorp CRM Migration", contactIdx: 0, stage: "New Lead", assignedTo: clawAI, value: 15000, priority: "low" as const, temp: "cold" as const, source: "Website", tags: ["inbound", "migration"], convStatus: "new" as const, created: daysAgo(1, 3) },
      { title: "Nordic Design Collaboration Tool", contactIdx: 11, stage: "New Lead", assignedTo: clawAI, value: 8000, priority: "low" as const, temp: "cold" as const, source: "Social Media", tags: ["inbound"], convStatus: "new" as const, created: daysAgo(0, 6) },
      // Qualified (3)
      { title: "Global Retail Omnichannel CRM", contactIdx: 1, stage: "Qualified", assignedTo: marcus, value: 45000, priority: "medium" as const, temp: "warm" as const, source: "Email Campaign", tags: ["enterprise", "omnichannel"], convStatus: "active" as const, created: daysAgo(5, 10),
        qualification: { budget: true, authority: true, need: true, timeline: false, score: 75 } },
      { title: "StartupXYZ Growth Platform", contactIdx: 2, stage: "Qualified", assignedTo: emily, value: 12000, priority: "medium" as const, temp: "warm" as const, source: "Referral", tags: ["startup", "growth"], convStatus: "active" as const, created: daysAgo(4, 8),
        qualification: { budget: false, authority: true, need: true, timeline: true, score: 65 } },
      { title: "FinancePlus Compliance Suite", contactIdx: 3, stage: "Qualified", assignedTo: alex, value: 55000, priority: "high" as const, temp: "warm" as const, source: "Phone Call", tags: ["finance", "compliance"], convStatus: "active" as const, created: daysAgo(5, 2),
        qualification: { budget: true, authority: false, need: true, timeline: true, score: 70 } },
      // Proposal (2)
      { title: "MegaHealth Patient Portal", contactIdx: 4, stage: "Proposal", assignedTo: sarah, value: 120000, priority: "high" as const, temp: "hot" as const, source: "Referral", tags: ["healthcare", "enterprise", "portal"], convStatus: "active" as const, created: daysAgo(6, 5),
        qualification: { budget: true, authority: true, need: true, timeline: true, score: 95 } },
      { title: "LatAm Growth Consulting CRM", contactIdx: 10, stage: "Proposal", assignedTo: marcus, value: 35000, priority: "medium" as const, temp: "hot" as const, source: "Referral", tags: ["consulting"], convStatus: "active" as const, created: daysAgo(6, 12),
        qualification: { budget: true, authority: true, need: true, timeline: false, score: 80 } },
      // Negotiation (1)
      { title: "LogisticsPro Fleet Management", contactIdx: 6, stage: "Negotiation", assignedTo: sarah, value: 85000, priority: "urgent" as const, temp: "hot" as const, source: "Website", tags: ["logistics", "fleet", "enterprise"], convStatus: "active" as const, created: daysAgo(7, 0),
        qualification: { budget: true, authority: true, need: true, timeline: true, score: 90 } },
      // Closed Won (1)
      { title: "EduLearn LMS Integration", contactIdx: 7, stage: "Closed Won", assignedTo: alex, value: 28000, priority: "medium" as const, temp: "hot" as const, source: "Email Campaign", tags: ["education", "integration"], convStatus: "closed" as const, created: daysAgo(7, 12),
        qualification: { budget: true, authority: true, need: true, timeline: true, score: 100 } },
      // Closed Lost (1)
      { title: "RealEstate Portfolio Tool", contactIdx: 8, stage: "Closed Lost", assignedTo: emily, value: 42000, priority: "medium" as const, temp: "cold" as const, source: "Social Media", tags: ["real-estate"], convStatus: "closed" as const, created: daysAgo(6, 18),
        qualification: { budget: false, authority: true, need: false, timeline: false, score: 25 } },
    ];

    const leadIds: Id<"leads">[] = [];
    for (const l of leadDefs) {
      const id = await ctx.db.insert("leads", {
        organizationId,
        title: l.title,
        contactId: contactIds[l.contactIdx],
        boardId,
        stageId: stagesByName[l.stage],
        assignedTo: l.assignedTo,
        value: l.value,
        currency: "USD",
        priority: l.priority,
        temperature: l.temp,
        sourceId: sourcesByName[l.source],
        tags: l.tags,
        customFields: {},
        qualification: l.qualification,
        conversationStatus: l.convStatus,
        lastActivityAt: l.created + 3 * 60 * 60 * 1000, // a few hours after creation
        createdAt: l.created,
        updatedAt: l.created + 2 * 60 * 60 * 1000,
      });
      leadIds.push(id);
    }

    // ─── 4. CONVERSATIONS & MESSAGES ────────────────────────────────
    let totalMessages = 0;

    // Helper to create a conversation + its messages
    async function createConvo(
      leadIdx: number,
      channel: "whatsapp" | "email" | "webchat" | "internal",
      msgs: Array<{
        direction: "inbound" | "outbound" | "internal";
        senderType: "contact" | "human" | "ai";
        senderId?: Id<"teamMembers">;
        content: string;
        minutesAfterConvoStart: number;
        isInternal?: boolean;
      }>
    ) {
      const convoStart = daysAgo(5, 0) + leadIdx * 2 * 60 * 60 * 1000;
      const lastMsgTime = convoStart + msgs[msgs.length - 1].minutesAfterConvoStart * 60 * 1000;

      const convoId = await ctx.db.insert("conversations", {
        organizationId,
        leadId: leadIds[leadIdx],
        channel,
        status: "active",
        lastMessageAt: lastMsgTime,
        messageCount: msgs.length,
        createdAt: convoStart,
        updatedAt: lastMsgTime,
      });

      for (const m of msgs) {
        await ctx.db.insert("messages", {
          organizationId,
          conversationId: convoId,
          leadId: leadIds[leadIdx],
          direction: m.direction,
          senderId: m.senderId,
          senderType: m.senderType,
          content: m.content,
          contentType: "text",
          deliveryStatus: m.direction === "outbound" ? "delivered" : undefined,
          isInternal: m.isInternal ?? false,
          createdAt: convoStart + m.minutesAfterConvoStart * 60 * 1000,
        });
        totalMessages++;
      }

      return convoId;
    }

    // Conversation 1: TechCorp (WhatsApp) — AI initial engagement
    await createConvo(0, "whatsapp", [
      { direction: "inbound", senderType: "contact", content: "Hi, I saw your CRM platform online. We're looking to migrate from Salesforce. Can you help?", minutesAfterConvoStart: 0 },
      { direction: "outbound", senderType: "ai", senderId: clawAI, content: "Hello James! Thanks for reaching out. I'd love to help you explore our CRM migration solutions. Could you tell me a bit about your current Salesforce setup — how many users and what modules are you using?", minutesAfterConvoStart: 1 },
      { direction: "inbound", senderType: "contact", content: "We have about 50 users, mostly using Sales Cloud and Service Cloud. Looking for something more modern and cost-effective.", minutesAfterConvoStart: 15 },
      { direction: "outbound", senderType: "ai", senderId: clawAI, content: "That's a great fit for our Enterprise plan. We've helped several companies migrate from Salesforce with zero data loss. I'm flagging this for our team to discuss pricing and timeline with you. Someone will follow up shortly!", minutesAfterConvoStart: 16 },
    ]);

    // Conversation 2: Global Retail (Email) — Qualified lead, human engagement
    await createConvo(2, "email", [
      { direction: "inbound", senderType: "contact", content: "Following up on our conversation at the trade show. We need a CRM that handles our 200+ retail locations across the US.", minutesAfterConvoStart: 0 },
      { direction: "outbound", senderType: "human", senderId: marcus, content: "Hi Maria, great to connect after the show! I've put together a custom demo for your multi-location use case. Would Thursday at 2pm work for a 30-minute walkthrough?", minutesAfterConvoStart: 45 },
      { direction: "inbound", senderType: "contact", content: "Thursday works! Can you also include information about your API for integrating with our existing POS system?", minutesAfterConvoStart: 120 },
      { direction: "outbound", senderType: "human", senderId: marcus, content: "Absolutely. I'll include a live API demo showing POS integration. I'll send a calendar invite with the meeting link shortly.", minutesAfterConvoStart: 135 },
      { direction: "outbound", senderType: "human", senderId: marcus, content: "Calendar invite sent! Looking forward to Thursday. Let me know if you have any questions before then.", minutesAfterConvoStart: 150 },
    ]);

    // Conversation 3: StartupXYZ (WhatsApp) — warm lead, mixed AI + human
    await createConvo(3, "whatsapp", [
      { direction: "inbound", senderType: "contact", content: "Hey! David here from StartupXYZ. My friend at FinancePlus recommended you guys. We're growing fast and need a CRM ASAP.", minutesAfterConvoStart: 0 },
      { direction: "outbound", senderType: "ai", senderId: clawAI, content: "Hi David! Great to hear about the referral from FinancePlus — they're a valued customer. Let me quickly understand your needs. How many team members will be using the CRM, and what's your primary use case — sales, support, or both?", minutesAfterConvoStart: 1 },
      { direction: "inbound", senderType: "contact", content: "About 15 people, mainly sales. We need pipeline management, email integration, and reporting. Budget is tight though since we're Series A.", minutesAfterConvoStart: 8 },
      { direction: "outbound", senderType: "ai", senderId: clawAI, content: "Totally understand the budget constraints at Series A! Our Startup plan might be perfect — it includes pipeline management and reporting at a fraction of enterprise pricing. Let me connect you with Emily who specializes in startup accounts.", minutesAfterConvoStart: 9 },
      { direction: "outbound", senderType: "human", senderId: emily, content: "Hi David! Emily here. I've helped several Series A companies get set up. Let's find a plan that works for your budget. Can we do a quick 15-min call tomorrow?", minutesAfterConvoStart: 35 },
      { direction: "inbound", senderType: "contact", content: "Tomorrow afternoon works. Say 3pm?", minutesAfterConvoStart: 60 },
      { direction: "outbound", senderType: "human", senderId: emily, content: "3pm it is! I'll send over a Zoom link. Talk soon 👋", minutesAfterConvoStart: 62 },
    ]);

    // Conversation 4: MegaHealth (Email) — enterprise proposal stage
    await createConvo(5, "email", [
      { direction: "outbound", senderType: "human", senderId: sarah, content: "Hi Robert, as discussed, I've attached the formal proposal for the MegaHealth Patient Portal integration. The $120K package includes full HIPAA-compliant setup, data migration, training, and 12 months premium support.", minutesAfterConvoStart: 0 },
      { direction: "inbound", senderType: "contact", content: "Thanks Sarah. The proposal looks comprehensive. Our legal team has a few questions about the BAA and data handling procedures. Can we schedule a call with your compliance team?", minutesAfterConvoStart: 180 },
      { direction: "outbound", senderType: "human", senderId: sarah, content: "Of course! I've looped in our compliance officer. How does next Monday at 10am work? We can address all BAA questions and walk through our SOC 2 documentation.", minutesAfterConvoStart: 200 },
      { direction: "inbound", senderType: "contact", content: "Monday 10am works. Please send the BAA template ahead of time so legal can review.", minutesAfterConvoStart: 360 },
      { direction: "outbound", senderType: "human", senderId: sarah, content: "BAA template and SOC 2 report sent via secure link. See you Monday!", minutesAfterConvoStart: 380 },
    ]);

    // Conversation 5: LogisticsPro (Webchat) — negotiation stage
    await createConvo(7, "webchat", [
      { direction: "inbound", senderType: "contact", content: "We've reviewed the proposal with our board. The features look great but we need to discuss the pricing structure for the fleet management module.", minutesAfterConvoStart: 0 },
      { direction: "outbound", senderType: "human", senderId: sarah, content: "Thanks Ahmed! I appreciate the board taking the time to review. What aspects of the pricing would you like to discuss? We have some flexibility on annual vs monthly billing and can explore volume discounts for your fleet size.", minutesAfterConvoStart: 20 },
      { direction: "inbound", senderType: "contact", content: "We'd prefer annual billing. With 500+ vehicles to track, we're looking at a 15% discount from the quoted price. Also need a guarantee on 99.9% uptime.", minutesAfterConvoStart: 45 },
      { direction: "outbound", senderType: "human", senderId: sarah, content: "I can offer 12% on annual billing for a 2-year commitment, which brings it to $85K/year. Our SLA includes 99.95% uptime guarantee with credits if we miss it. Let me draft the updated terms.", minutesAfterConvoStart: 55 },
    ]);

    // Conversation 6: Internal note conversation on EduLearn (won deal)
    await createConvo(8, "internal", [
      { direction: "internal", senderType: "human", senderId: alex, content: "Closed the EduLearn deal! They signed the $28K contract for the LMS integration. Onboarding starts next week.", minutesAfterConvoStart: 0, isInternal: true },
      { direction: "internal", senderType: "human", senderId: sarah, content: "Great work Alex! 🎉 Make sure to schedule the kickoff call and loop in the implementation team.", minutesAfterConvoStart: 15, isInternal: true },
      { direction: "internal", senderType: "ai", senderId: clawAI, content: "Congrats on closing! I've automatically updated the deal status and generated a handoff summary for the implementation team.", minutesAfterConvoStart: 16, isInternal: true },
    ]);

    // ─── 5. ACTIVITIES ──────────────────────────────────────────────
    const activityDefs: Array<{
      leadIdx: number;
      type: "note" | "call" | "email_sent" | "stage_change" | "assignment" | "handoff" | "qualification_update" | "created" | "message_sent";
      actorId?: Id<"teamMembers">;
      actorType: "human" | "ai" | "system";
      content?: string;
      metadata?: Record<string, any>;
      hoursAgo: number;
    }> = [
      // Lead creation events
      { leadIdx: 0, type: "created", actorType: "system", content: "Lead created from website inquiry", hoursAgo: 27 },
      { leadIdx: 2, type: "created", actorType: "system", content: "Lead created from email campaign", hoursAgo: 130 },
      { leadIdx: 5, type: "created", actorType: "system", content: "Lead created from referral", hoursAgo: 149 },
      { leadIdx: 7, type: "created", actorType: "system", content: "Lead created from website", hoursAgo: 168 },

      // Assignments
      { leadIdx: 0, type: "assignment", actorType: "ai", actorId: clawAI, content: "Auto-assigned to Claw AI for initial triage", metadata: { assignedTo: "Claw AI" }, hoursAgo: 26 },
      { leadIdx: 2, type: "assignment", actorType: "human", actorId: sarah, content: "Assigned to Marcus Johnson", metadata: { assignedTo: "Marcus Johnson" }, hoursAgo: 125 },
      { leadIdx: 5, type: "assignment", actorType: "human", actorId: sarah, content: "Assigned to Sarah Chen — enterprise account", metadata: { assignedTo: "Sarah Chen" }, hoursAgo: 145 },

      // Stage changes
      { leadIdx: 2, type: "stage_change", actorType: "human", actorId: marcus, content: "Moved from New Lead to Qualified", metadata: { from: "New Lead", to: "Qualified" }, hoursAgo: 96 },
      { leadIdx: 5, type: "stage_change", actorType: "human", actorId: sarah, content: "Moved from Qualified to Proposal", metadata: { from: "Qualified", to: "Proposal" }, hoursAgo: 72 },
      { leadIdx: 7, type: "stage_change", actorType: "human", actorId: sarah, content: "Moved from Proposal to Negotiation", metadata: { from: "Proposal", to: "Negotiation" }, hoursAgo: 48 },
      { leadIdx: 8, type: "stage_change", actorType: "human", actorId: alex, content: "Moved to Closed Won — contract signed!", metadata: { from: "Negotiation", to: "Closed Won" }, hoursAgo: 24 },
      { leadIdx: 9, type: "stage_change", actorType: "human", actorId: emily, content: "Moved to Closed Lost — budget constraints", metadata: { from: "Qualified", to: "Closed Lost" }, hoursAgo: 36 },

      // Qualification updates
      { leadIdx: 2, type: "qualification_update", actorType: "human", actorId: marcus, content: "BANT updated: Budget confirmed, Authority confirmed, Need confirmed", metadata: { score: 75 }, hoursAgo: 90 },
      { leadIdx: 5, type: "qualification_update", actorType: "ai", actorId: clawAI, content: "AI qualification: All BANT criteria met, score 95", metadata: { score: 95 }, hoursAgo: 80 },

      // Messages sent
      { leadIdx: 0, type: "message_sent", actorType: "ai", actorId: clawAI, content: "AI sent initial response via WhatsApp", hoursAgo: 25 },
      { leadIdx: 2, type: "message_sent", actorType: "human", actorId: marcus, content: "Follow-up email sent to Maria Garcia", hoursAgo: 50 },

      // Handoff
      { leadIdx: 3, type: "handoff", actorType: "ai", actorId: clawAI, content: "AI handed off to Emily Rodriguez — startup account needs human touch", hoursAgo: 88 },

      // Notes
      { leadIdx: 7, type: "note", actorType: "human", actorId: sarah, content: "Ahmed is responsive and decision-maker. Board approved budget. Negotiate on pricing — they want 15% off. I think 12% on 2yr commit is our floor.", hoursAgo: 40 },
      { leadIdx: 8, type: "note", actorType: "human", actorId: alex, content: "Lisa is excited about the integration. Implementation team has capacity to start next week. Great reference customer potential.", hoursAgo: 20 },
    ];

    let totalActivities = 0;
    for (const a of activityDefs) {
      await ctx.db.insert("activities", {
        organizationId,
        leadId: leadIds[a.leadIdx],
        type: a.type,
        actorId: a.actorId,
        actorType: a.actorType,
        content: a.content,
        metadata: a.metadata,
        createdAt: now - a.hoursAgo * 60 * 60 * 1000,
      });
      totalActivities++;
    }

    // ─── 6. HANDOFFS ────────────────────────────────────────────────
    // Pending handoff: Claw AI → any human on TechCorp lead
    await ctx.db.insert("handoffs", {
      organizationId,
      leadId: leadIds[0],
      fromMemberId: clawAI,
      reason: "Customer is asking detailed pricing questions about enterprise migration — needs human specialist",
      summary: "James Wilson from TechCorp (50 Salesforce users) wants to migrate. Interested in Enterprise plan. Needs pricing discussion and migration timeline.",
      suggestedActions: ["Discuss enterprise pricing tiers", "Share migration case studies", "Schedule technical assessment call"],
      status: "pending",
      createdAt: daysAgo(1, 2),
    });

    // Update the TechCorp lead's handoffState to match
    await ctx.db.patch(leadIds[0], {
      handoffState: {
        status: "pending",
        fromMemberId: clawAI,
        reason: "Customer is asking detailed pricing questions about enterprise migration — needs human specialist",
        summary: "James Wilson from TechCorp (50 Salesforce users) wants to migrate. Interested in Enterprise plan. Needs pricing discussion and migration timeline.",
        suggestedActions: ["Discuss enterprise pricing tiers", "Share migration case studies", "Schedule technical assessment call"],
        requestedAt: daysAgo(1, 2),
      },
    });

    // Accepted handoff: Claw AI → Emily on StartupXYZ lead
    const handoffAcceptedAt = daysAgo(3, 16);
    await ctx.db.insert("handoffs", {
      organizationId,
      leadId: leadIds[3],
      fromMemberId: clawAI,
      toMemberId: emily,
      reason: "Startup lead needs personalized pricing discussion — budget-sensitive Series A company",
      summary: "David Lee from StartupXYZ, 15-person sales team, Series A. Interested in pipeline management and reporting. Budget-conscious but strong intent.",
      suggestedActions: ["Offer startup discount", "Emphasize ROI and quick setup", "Share case studies from similar-stage startups"],
      status: "accepted",
      acceptedBy: emily,
      notes: "Taking this one — I have experience with Series A companies. Will call David tomorrow at 3pm.",
      createdAt: daysAgo(4, 0),
      resolvedAt: handoffAcceptedAt,
    });

    // Update StartupXYZ lead's handoffState
    await ctx.db.patch(leadIds[3], {
      handoffState: {
        status: "completed",
        fromMemberId: clawAI,
        toMemberId: emily,
        reason: "Startup lead needs personalized pricing discussion — budget-sensitive Series A company",
        summary: "David Lee from StartupXYZ, 15-person sales team, Series A.",
        suggestedActions: ["Offer startup discount", "Emphasize ROI and quick setup"],
        requestedAt: daysAgo(4, 0),
        completedAt: handoffAcceptedAt,
      },
    });

    // ─── 7. AUDIT LOGS ──────────────────────────────────────────────
    const auditDefs: Array<{
      entityType: string;
      entityId: string;
      action: "create" | "update" | "delete" | "move" | "assign" | "handoff";
      actorId?: Id<"teamMembers">;
      actorType: "human" | "ai" | "system";
      changes?: { before?: Record<string, any>; after?: Record<string, any> };
      metadata?: Record<string, any>;
      severity: "low" | "medium" | "high" | "critical";
      hoursAgo: number;
    }> = [
      { entityType: "lead", entityId: leadIds[0] as string, action: "create", actorType: "system", severity: "low", hoursAgo: 27 },
      { entityType: "lead", entityId: leadIds[2] as string, action: "create", actorType: "system", severity: "low", hoursAgo: 130 },
      { entityType: "lead", entityId: leadIds[5] as string, action: "create", actorType: "system", severity: "low", hoursAgo: 149 },
      { entityType: "lead", entityId: leadIds[2] as string, action: "move", actorId: marcus, actorType: "human",
        changes: { before: { stage: "New Lead" }, after: { stage: "Qualified" } }, severity: "low", hoursAgo: 96 },
      { entityType: "lead", entityId: leadIds[5] as string, action: "move", actorId: sarah, actorType: "human",
        changes: { before: { stage: "Qualified" }, after: { stage: "Proposal" } }, severity: "low", hoursAgo: 72 },
      { entityType: "lead", entityId: leadIds[7] as string, action: "move", actorId: sarah, actorType: "human",
        changes: { before: { stage: "Proposal" }, after: { stage: "Negotiation" } }, severity: "medium", hoursAgo: 48 },
      { entityType: "lead", entityId: leadIds[8] as string, action: "move", actorId: alex, actorType: "human",
        changes: { before: { stage: "Negotiation" }, after: { stage: "Closed Won" } }, severity: "high", hoursAgo: 24,
        metadata: { value: 28000, currency: "USD" } },
      { entityType: "lead", entityId: leadIds[9] as string, action: "move", actorId: emily, actorType: "human",
        changes: { before: { stage: "Qualified" }, after: { stage: "Closed Lost" } }, severity: "medium", hoursAgo: 36,
        metadata: { reason: "Budget constraints" } },
      { entityType: "lead", entityId: leadIds[2] as string, action: "assign", actorId: sarah, actorType: "human",
        changes: { after: { assignedTo: "Marcus Johnson" } }, severity: "low", hoursAgo: 125 },
      { entityType: "lead", entityId: leadIds[0] as string, action: "handoff", actorId: clawAI, actorType: "ai",
        metadata: { from: "Claw AI", reason: "Enterprise pricing discussion" }, severity: "medium", hoursAgo: 26 },
      { entityType: "lead", entityId: leadIds[3] as string, action: "handoff", actorId: clawAI, actorType: "ai",
        metadata: { from: "Claw AI", to: "Emily Rodriguez", reason: "Startup account" }, severity: "medium", hoursAgo: 96 },
      { entityType: "teamMember", entityId: sarah as string, action: "create", actorType: "system", severity: "low", hoursAgo: 168 },
      { entityType: "teamMember", entityId: clawAI as string, action: "create", actorType: "system", severity: "medium", hoursAgo: 168,
        metadata: { type: "ai", capabilities: ["auto-reply", "qualification"] } },
    ];

    for (const a of auditDefs) {
      await ctx.db.insert("auditLogs", {
        organizationId,
        entityType: a.entityType,
        entityId: a.entityId,
        action: a.action,
        actorId: a.actorId,
        actorType: a.actorType,
        changes: a.changes,
        metadata: a.metadata,
        severity: a.severity,
        createdAt: now - a.hoursAgo * 60 * 60 * 1000,
      });
    }

    // ─── SUMMARY ────────────────────────────────────────────────────
    return {
      teamMembers: teamMemberIds.length,
      contacts: contactIds.length,
      leads: leadIds.length,
      conversations: 6,
      messages: totalMessages,
      activities: totalActivities,
      handoffs: 2,
      auditLogs: auditDefs.length,
    };
  },
});
