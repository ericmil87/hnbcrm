# HNBCRM Workflow Playbooks

Detailed step-by-step procedures for common CRM operations.

---

## 1. New Lead Intake

When a new lead arrives — either from an inbound webhook, manual creation, or API call:

### Step 1: Duplicate Check

Before creating a new contact, search for existing matches:

```
crm_search_contacts({ q: "email or phone or name" })
```

If a match is found, associate the lead with the existing contact instead of creating a duplicate.

### Step 2: Create the Lead

```
crm_create_lead({
  title: "Descriptive title",
  contact: { firstName, lastName, email, phone, company },
  priority: "medium",       // Assess from context
  temperature: "cold",      // Default, upgrade as you learn more
  message: "Initial message if any",
  channel: "webchat"        // or whatsapp, telegram, email
})
```

### Step 3: Initial Assessment

Review available information and set:

- **Priority**: `urgent` if time-sensitive, `high` if strong buying signals, `medium` default, `low` if unclear intent
- **Temperature**: `hot` if actively seeking solution, `warm` if engaged but exploring, `cold` if early stage

### Step 4: Log Your Assessment

```
crm_create_activity({
  leadId: "...",
  type: "note",
  content: "Initial assessment: [your reasoning]. Priority set to [X] because [reason]. Temperature [Y] based on [signals]."
})
```

### Step 5: First Response

If a message came with the lead, respond within the conversation:

```
crm_send_message({
  conversationId: "...",
  content: "Your response",
  isInternal: false
})
```

---

## 2. Lead Qualification (BANT)

### When to Qualify

Run qualification after initial engagement, when you have enough conversation context to assess buying readiness.

### Step 1: Gather Information

Through conversation, assess each BANT dimension:

| Dimension | Key Questions |
|-----------|--------------|
| **Budget** | Can they afford it? Have they mentioned budget constraints? |
| **Authority** | Are they the decision-maker? Do they need approval from others? |
| **Need** | What specific problem are they trying to solve? How urgent is it? |
| **Timeline** | When do they need a solution? Is there a deadline? |

### Step 2: Update Qualification

```
crm_update_lead({
  leadId: "...",
  qualification: {
    budget: true,      // or false
    authority: true,
    need: true,
    timeline: false,
    score: 3           // Count of true values (0-4)
  }
})
```

### Step 3: Adjust Temperature

| Score | Suggested Temperature |
|-------|----------------------|
| 0-1 | `cold` |
| 2 | `warm` |
| 3-4 | `hot` |

### Step 4: Document Findings

```
crm_create_activity({
  leadId: "...",
  type: "note",
  content: "BANT qualification completed. Score: 3/4. Budget confirmed ($X range), authority verified (CTO), clear need (pain point: ...), no timeline pressure yet."
})
```

---

## 3. Pipeline Advancement

### Stage Transition Criteria

Before moving a lead to the next stage, verify:

1. **Current stage work is complete** — all actions for this stage have been taken
2. **Exit criteria met** — the lead meets the requirements for the next stage
3. **Data is current** — priority, temperature, and qualification reflect the latest information

### Step 1: Review Current State

```
crm_get_lead({ leadId: "..." })
crm_get_activities({ leadId: "..." })
```

### Step 2: Move to Next Stage

```
crm_move_lead({
  leadId: "...",
  stageId: "target-stage-id"
})
```

### Step 3: Log the Transition

```
crm_create_activity({
  leadId: "...",
  type: "note",
  content: "Moved to [Stage Name]. Reason: [why the lead is ready for this stage]."
})
```

### Closing a Deal

For terminal stages (`isClosedWon` / `isClosedLost`):

- Move to the closed-won or closed-lost stage
- The system will set `closedAt` and `closedType` automatically
- Log a final activity summarizing the outcome

---

## 4. Contact Enrichment Cycle

### Step 1: Identify Gaps

```
crm_get_contact_gaps({ contactId: "..." })
```

This returns `missingFields` — a list of fields that have no value.

### Step 2: Prioritize Fields

Focus on high-value fields first:

1. **Identity**: email, phone, company, title
2. **Professional**: industry, companySize, companyWebsite
3. **Social**: linkedinUrl, instagramUrl
4. **Location**: city, state, country
5. **Behavioral**: preferredContactTime, deviceType

### Step 3: Research and Enrich

For each piece of discovered data:

```
crm_enrich_contact({
  contactId: "...",
  fields: {
    company: "Acme Corp",
    title: "VP of Sales",
    industry: "SaaS"
  },
  source: "linkedin-profile",   // Be specific about the source
  confidence: 0.9                // 1.0 = confirmed, 0.5 = inferred
})
```

### Step 4: Use enrichmentExtra for Non-Standard Data

For data that doesn't map to existing fields:

```
crm_update_contact({
  contactId: "...",
  enrichmentExtra: {
    "recentFunding": "$5M Series A in 2024",
    "techStack": ["React", "Node.js", "AWS"],
    "competitorUsing": "Salesforce"
  }
})
```

### Provenance Best Practices

- Always include `source` — use specific identifiers like `"linkedin-profile"`, `"company-website"`, `"google-search"`, `"conversation-2024-01-15"`
- Set `confidence` accurately:
  - `1.0` — directly confirmed by the contact
  - `0.8-0.9` — from a reliable source (LinkedIn, company website)
  - `0.5-0.7` — inferred or from a secondary source
  - `< 0.5` — speculative, mention in notes instead

---

## 5. Handoff Execution

### Decision Criteria

Hand off when ANY of these apply:

| Trigger | Example |
|---------|---------|
| **Pricing/commercial** | "Can you give me a 20% discount?" |
| **Legal/compliance** | "We need a DPA before proceeding" |
| **Emotional customer** | Frustrated, angry, or upset tone |
| **Technical depth** | Requires domain expertise you lack |
| **Authority needed** | Contract signing, strategic decisions |
| **Uncertainty** | You're not confident in the right response |

### Step 1: Prepare Summary

Before handing off, compile:

- Key facts about the lead and contact
- Conversation highlights and current status
- What the contact is asking for
- Your assessment of the situation

### Step 2: Request Handoff

```
crm_request_handoff({
  leadId: "...",
  reason: "Customer requesting 30% discount on annual plan — needs manager approval",
  summary: "Lead: Acme Corp (João Silva, CTO). Hot lead, BANT 4/4. Currently in Proposal stage. Has been evaluating for 2 weeks. Key need: team collaboration features. Budget confirmed at R$50k/year. Requesting discount due to multi-year commitment.",
  suggestedActions: [
    "Review discount request against margin policy",
    "Consider offering 15% for 2-year commitment as counter",
    "Schedule call this week — contact prefers afternoons"
  ],
  toMemberId: "specific-manager-id"  // Optional: target specific person
})
```

### Step 3: Notify in Conversation

Leave an internal note so the team sees the handoff context inline:

```
crm_send_message({
  conversationId: "...",
  content: "Handing off to [human name] — customer requesting discount that needs manager approval. Summary and suggested actions included in handoff request.",
  isInternal: true
})
```

---

## 6. Conversation Management

### Reading Before Responding

Always read the full conversation thread before replying:

```
crm_list_conversations({ leadId: "..." })
crm_get_messages({ conversationId: "..." })
```

Check:
- Who has been involved in the conversation
- What has already been discussed
- Whether a human is actively handling it

### When to Respond

| Situation | Action |
|-----------|--------|
| Lead assigned to you, new message | Respond |
| Lead unassigned, new message | Respond and consider self-assigning |
| Lead assigned to another agent, they're active | Don't respond |
| Lead assigned to another agent, no activity for 24h+ | Leave internal note flagging the delay |
| Internal note mentioning you | Respond with internal note |

### Internal Notes Best Practices

Use internal notes (`isInternal: true`) for:

- **AI reasoning**: "Based on the conversation, this lead seems most interested in feature X. Recommending we highlight the Y integration."
- **Research findings**: "Checked their company website — they recently expanded to 3 new markets, which explains the urgency."
- **Coordination**: "Handing off pricing discussion to @manager. Key context: budget is R$50k but they're comparing with Competitor."
- **Observations**: "Contact has been responsive within 30 minutes for the last 3 messages — suggests high engagement."

### Multi-Channel Awareness

Leads can have conversations across multiple channels (whatsapp, telegram, email, webchat, internal). When working with a lead:

1. List all conversations for the lead
2. Read messages across channels to get the full picture
3. Respond in the same channel the contact used last

---

## 7. Email Notifications

- After requesting a handoff, the target human receives an email notification automatically.
- After a handoff is accepted/rejected, the requester is notified by email.
- When a lead or task is assigned, the assignee receives an email.
- Overdue tasks trigger email reminders to assignees.
- A daily digest email summarizes CRM activity at 08:00 BRT.
- Members can opt out of specific notification types via Settings > Notificacoes.
- AI agents are never sent emails (type !== "human" check).

---

## 8. Form Submission Workflow

When a visitor submits a public form at `/f/:slug`:

### What Happens Automatically

1. **Spam check** — If the honeypot field is filled, the submission is silently stored as spam (no lead created)
2. **Contact find-or-create** — The system searches for an existing contact by email/phone; if none found, creates a new one using CRM-mapped fields
3. **Lead creation** — A new lead is created with:
   - Title from the form's `leadTitle` template (supports `{email}`, `{name}`, `{firstName}`, `{lastName}`, `{company}`, `{phone}` placeholders)
   - Board/stage from form settings (or default board's first stage)
   - Priority, temperature, and tags from form settings
   - Assignment based on form's `assignmentMode`: none, specific (fixed member), or round-robin (least-loaded active human)
4. **Activity log** — "Formulario 'X' submetido" logged on the lead timeline
5. **Audit log** — Form submission recorded with IP address and user agent
6. **Webhook trigger** — `form.submitted` event fired with formId, formName, leadId, contactId
7. **Email notifications** — If configured, specified team members are notified

### For AI Agents

- Leads from form submissions appear in `crm_list_leads` like any other lead
- Check the lead's activity feed (`crm_get_activities`) — form submissions show as `type: "created"` with content "Formulario 'X' submetido"
- The lead's contact will have fields populated from the form's CRM mappings
- Process these leads through the normal intake workflow (qualify, enrich contact, advance pipeline)
