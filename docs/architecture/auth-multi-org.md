# Autenticação, RBAC, convites e multi-org

> Histórico técnico movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (snapshot do commit 1f51a2f). Ordem = ordem de versão. Pegadinhas que mudam a forma de codar foram destiladas em `.claude/rules/`; este arquivo é a fonte completa, para ler quando se mexe nesta área.

## Estado atual

Login por senha (Convex Auth), `requireAuth`/`requirePermission`, convite de humanos, N:N usuário↔org (v0.61), senha temporária por conta. Código: `convex/lib/auth.ts`, `convex/lib/permissions.ts`, `convex/teamMembers.ts`, `convex/organizations.ts`, `src/components/org/`.

## Decisões, pegadinhas medidas e histórico

### Multi-tenancy

**Multi-tenancy:** Every table has `organizationId`. All queries must be scoped to the user's org.

### Auth flow

**Auth flow:** `requireAuth(ctx, organizationId)` from `convex/lib/auth.ts` handles auth + org membership. Returns the team member. `requirePermission(ctx, organizationId, category, level)` extends this with granular RBAC checks. A few functions without org context (e.g. `getUserOrganizations`) still use `getAuthUserId` directly.

### Permissions (RBAC)

**Permissions (RBAC):** 10 permission categories (leads, contacts, inbox, tasks, reports, team, settings, auditLogs, apiKeys, campaigns) with hierarchical levels. Defined in `convex/lib/permissions.ts`. Each role (admin, manager, agent, ai) has sensible defaults; admins can override per-member. Frontend uses `usePermissions(organizationId)` hook and `<PermissionGate>` component.

### Invite flow

**Invite flow:** Admins invite humans via `inviteHumanMember` action (creates auth account with bcrypt-hashed temp password). New users must change password on first login (`mustChangePassword` flag). **Não existe mais auto-link por e-mail no cadastro** (v0.61) — ver "Multi-org" abaixo.

### Multi-org N:N usuário↔empresa (v0.61)

**Multi-org N:N usuário↔empresa (v0.61):** 1 usuário em N orgs, 1 org com N membros (linha `teamMembers` por par org+user). (1) **Remover corta o acesso:** `removeTeamMember` grava `removedAt`/`removedBy` (+ `status:"inactive"`); `isMembershipRevoked` = `removedAt` OU `inactive` legado (nada além da remoção grava `inactive`, e `updateTeamMemberStatus` só aceita `active`/`busy` — ninguém se reativa sozinho). `getActiveMembership` em `lib/auth.ts` é a base de `requireAuth`/`requirePermission`, dos lookups manuais, de `getUserOrganizations` e de `getByKeyHash` (API key de removido ou cross-org não autentica; `insertApiKey` valida a org do membro). Reconvidar REATIVA a mesma linha; todo caminho que põe IA em `active` limpa `removedAt`. Atribuição (lead/tarefa/repasse/evento) passa por `assertAssignableMember` — removido não recebe atribuição NOVA (quem já era responsável segue válido na re-edição). `getTeamMembers` devolve `removed`/`pending` (pendente = humano sem `userId`, legado; não conta na guarda de último admin). (2) **Convite:** `createTeamMember` só cria IA; humano sempre por `inviteHumanMember` → `{teamMemberId,isNewUser,existingUser,reactivated,pendingPasswordChange,tempPassword?,emailSent}` — conta existente é vinculada sem tocar na senha e recebe e-mail `addedToOrg`; aplica `ROLE_RANK`. O auto-link em `afterUserCreatedOrUpdated` foi REMOVIDO: o cadastro não verifica e-mail, então qualquer um que se cadastrasse primeiro com o e-mail de um membro pré-criado entrava na org (até como admin); pendente legado é adotado quando o admin reconvida. (3) **E-mail sem caixa:** lookup de conta acha qualquer variante (forma exata vence se houver duas); login normaliza via `withCanonicalEmail`; cadastro com variante de conta existente é recusado. Backfill `authHelpers:internalNormalizeLegacyEmails {table, dryRun(default true), cursor}` só reporta colisões. (4) **Senha temporária é da CONTA:** `teamMembers.getMustChangePassword` (sem org) trava o app antes de tudo em qualquer org; convite de conta com senha pendente herda o flag; trocar limpa todos os membros. (5) **Onboarding por org:** `getOnboardingProgress.shouldShowWizard` só para admin de org sem `onboardingMeta.wizardCompletedAt`; `setupPipelineFromWizard` recusa após conclusão ou com leads (ele apaga boards). (6) **Front:** `src/components/org/OrgSwitcher.tsx` (modal: lista, "Nova organização", Sair — também no header/menu "Mais" do mobile); `key={orgId}` no AppShell e `src/lib/orgSwitch.ts` limpam `?task=/lead=/conversation=/handoff=` na troca; deep-link de entidade de OUTRA org resolve por `organizations.resolveEntityOrg` e troca de org (ou "não encontramos"); queries de detalhe devolvem null para não-membro; ErrorBoundary reseta por rota; signOut limpa `hnbcrm.selectedOrgId` e toasts; aviso "Você foi adicionado" só com `invited:true` de `getUserOrganizations`. (7) `updateOrganization`/`completeWizard` fazem MERGE de `settings` (antes o Salvar do perfil apagava `optOutKeywords`/`campaignDefaults`). Testes: `convex/multiOrg.test.ts`, `src/lib/orgSwitch.test.ts`, `src/lib/teamMembers.test.ts`.

