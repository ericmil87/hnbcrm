# CLAUDE.md — Frontend (React + TailwindCSS)

## Structure

```
src/
├── main.tsx                    # Entry: ConvexAuthProvider wrapper
├── App.tsx                     # Auth gates (Authenticated/Unauthenticated), org selector, header
├── SignInForm.tsx              # Password + Anonymous sign-in
├── SignOutButton.tsx           # Sign-out button
├── index.css                  # TailwindCSS imports + custom styles
└── components/
    ├── Dashboard.tsx           # Main layout — tab navigation controller
    ├── DashboardOverview.tsx   # Metrics overview tab
    ├── KanbanBoard.tsx         # Pipeline board with drag-and-drop stages
    ├── LeadDetailPanel.tsx     # Slide-over panel for lead details
    ├── CreateLeadModal.tsx     # Modal for creating new leads
    ├── Inbox.tsx               # Conversation inbox with message threads
    ├── HandoffQueue.tsx        # AI-to-human handoff management
    ├── TeamPage.tsx            # Team member list and management
    ├── Settings.tsx            # Organization settings
    ├── AuditLogs.tsx           # Audit log viewer with filters
    └── OrganizationSelector.tsx # Org switcher dropdown
```

## Patterns

**Data fetching:** Always use `useQuery(api.module.functionName, args)` from `convex/react`. Pass `"skip"` instead of args when dependencies aren't ready:
```tsx
const leads = useQuery(
  api.leads.list,
  selectedOrgId ? { organizationId: selectedOrgId as Id<"organizations"> } : "skip"
);
```

**Mutations:** Use `useMutation(api.module.functionName)` and call the returned function. Wrap with toast notifications from `sonner`:
```tsx
const createLead = useMutation(api.leads.create);
// ...
toast.promise(createLead({ ... }), { loading: "Creating...", success: "Created!", error: "Failed" });
```

**Loading states:** Check `useQuery` result for `undefined` (loading) vs actual data:
```tsx
if (data === undefined) return <Spinner />;
```

**Auth gates:** Use `<Authenticated>` and `<Unauthenticated>` from `convex/react` to conditionally render.

**Organization scoping:** The selected `organizationId` is passed as a prop from `App.tsx` → `Dashboard.tsx` → child components. Every query includes it.

## Styling

- TailwindCSS 3 utility classes only — no CSS modules or styled-components
- Primary color: `blue-600` / `blue-700`
- Common patterns: `bg-white rounded-lg shadow-sm border p-4` for cards
- Responsive: not currently implemented (desktop-first)

## Path Alias

`@/` maps to `src/` — use `@/components/Foo` for imports within the frontend.

## Key Dependencies

- `convex/react` — `useQuery`, `useMutation`, `Authenticated`, `Unauthenticated`
- `@convex-dev/auth/react` — `ConvexAuthProvider`, `useAuthActions`
- `sonner` — `toast` for notifications, `<Toaster />` in App.tsx
- `clsx` + `tailwind-merge` — conditional class merging
