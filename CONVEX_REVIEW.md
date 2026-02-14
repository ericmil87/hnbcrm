# ClawCRM — Convex Best Practices Review

> Revisao completa da codebase contra as melhores praticas do Convex.
> Data: 2026-02-14

---

## CRITICO (Seguranca / Bugs)

### 1. Validators `returns` ausentes em TODAS as funcoes

- **Arquivos:** todos os `.ts` em `convex/`
- Toda query/mutation/action esta sem o campo `returns`. A regra do projeto exige `args` + `returns` em toda funcao.
- Exemplo em `convex/leads.ts:7`:

```ts
export const getLeads = query({
  args: { ... },
  // FALTA: returns: v.array(v.object({...})),
  handler: async (ctx, args) => { ... }
});
```

- **Fix:** adicionar `returns` validator em cada funcao exportada.

---

### 2. API Keys armazenadas em texto puro (sem hash)

- **Arquivo:** `convex/apiKeys.ts:54`
- `const keyHash = apiKey;` — a chave e salva diretamente, sem SHA-256.
- **Risco:** se o banco for comprometido, todas as API keys ficam expostas.
- **Fix:** usar `crypto.subtle.digest("SHA-256", ...)` antes de salvar. Requer `"use node";` em arquivo de action separado.

---

### 3. Webhook signature insegura (`simpleHash`)

- **Arquivo:** `convex/webhookTrigger.ts:52-61`
- Usa um hash de 32 bits nao-criptografico para assinar payloads de webhook:

```ts
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}
```

- **Risco:** um atacante pode forjar assinaturas facilmente.
- **Fix:** usar HMAC-SHA256 via `crypto.subtle` (requer `"use node";` em arquivo separado de action).

---

### 4. HTTP router chama `api.*` em vez de `internal.*`

- **Arquivo:** `convex/router.ts` (linhas 71, 81, 90, 101, 106, 114, 132, 138, 165, etc.)
- Os httpActions chamam `api.leads.createLead`, `api.contacts.findOrCreateContact`, etc.
- Essas mutations fazem `getAuthUserId(ctx)` que vai retornar `null` quando chamadas de httpAction (nao ha sessao de auth).
- **Potencial bug:** endpoints da REST API podem falhar com "Not authenticated".
- **Fix:** criar versoes `internal.*` dessas funcoes que recebem `teamMemberId` como argumento e nao dependem de auth session.

---

### 5. CORS wildcard `Access-Control-Allow-Origin: *`

- **Arquivo:** `convex/router.ts:10`

```ts
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  ...
};
```

- **Risco:** qualquer dominio pode fazer requests a API.
- **Fix:** em producao, restringir a origens especificas (ex: `https://app.clawcrm.com`).

---

## ALTO (Performance / Escalabilidade)

### 6. Queries sem paginacao — `.collect()` em tabelas ilimitadas

- `convex/leads.ts:39` — `query.collect()` carrega TODOS os leads da org
- `convex/conversations.ts:35` — `query.collect()` carrega TODAS as conversas
- `convex/dashboard.ts:25` — carrega TODOS os leads para calcular stats
- `convex/handoffs.ts:33` — `query.collect()` em todos os handoffs
- **Impacto:** em escala (1000+ leads), isso sera lento e caro.
- **Fix:** usar `paginationOptsValidator` + `.paginate()` ou `.take(limit)`.

---

### 7. Filtragem em memoria em vez de usar index

**`convex/conversations.ts:38-46`:**

```ts
const conversations = await query.collect();
if (args.leadId) {
  filteredConversations = filteredConversations.filter(c => c.leadId === args.leadId);
}
```

- Deveria usar `.withIndex("by_lead")` quando `leadId` e fornecido.

**`convex/leads.ts:42-44`:**

```ts
const filteredLeads = args.boardId
  ? leads.filter(lead => lead.boardId === args.boardId)
  : leads;
```

- Filtra `boardId` em memoria apos collect. Falta index `by_organization_and_board`.

---

### 8. Dashboard query pesada — N+1 queries

- **Arquivo:** `convex/dashboard.ts`
- Uma unica query carrega: todos os leads, todos os boards, todos os stages, todos os leadSources, todos os teamMembers, e 10 atividades com resolucao de actor.
- **Impacto:** em escala, pode saturar o timeout de query do Convex.
- **Fix:** quebrar em queries menores ou pre-computar aggregacoes via scheduled functions.

---

### 9. Auth check duplicada em toda funcao (boilerplate)

Padrao repetido **30+ vezes** no backend:

```ts
const userId = await getAuthUserId(ctx);
if (!userId) throw new Error("Not authenticated");
const userMember = await ctx.db.query("teamMembers")
  .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
  .filter((q) => q.eq(q.field("userId"), userId))
  .first();
if (!userMember) throw new Error("Not authorized");
```

- **Fix:** extrair para um custom function wrapper (`authedQuery`, `authedMutation`) usando `convex-helpers` ou o padrao de custom functions do Convex. Isso reduziria cada funcao em ~10 linhas e centralizaria a logica de auth.

---

## MEDIO (Qualidade de Codigo)

### 10. Uso de `any` no frontend e backend

- `convex/router.ts:29`: `function jsonResponse(data: any, ...)`
- `convex/router.ts:37`: `async function authenticateApiKey(ctx: any, ...)`
- `convex/router.ts:84,109`: `boards.find((b: any) => ...)`, `aiAgents.find((m: any) => ...)`
- `src/components/Inbox.tsx:53`: `const getMessageStyle = (message: any) => { ... }`
- **Viola** a regra `typescript-strict-no-any` do projeto.
- **Fix:** tipar corretamente usando `Doc<"tableName">`, `ActionCtx`, etc.

---

### 11. Props `organizationId` como `string` + cast manual

Todos os componentes recebem `organizationId: string` e fazem cast em toda chamada:

```tsx
organizationId: organizationId as Id<"organizations">
```

- Repetido em todos os 9 componentes do dashboard.
- **Fix:** usar `Id<"organizations">` diretamente nas interfaces de props:

```tsx
interface DashboardProps {
  organizationId: Id<"organizations">;
}
```

---

### 12. Tratamento de erros inconsistente no frontend

| Componente | Metodo de erro |
|-----------|----------------|
| `SignInForm.tsx` | `toast()` (sonner) |
| `OrganizationSelector.tsx` | `alert()` |
| `CreateLeadModal.tsx` | `alert()` |
| `Inbox.tsx` | `console.error()` |
| `HandoffQueue.tsx` | `console.error()` |
| `Settings.tsx` (ApiKeys) | `alert()` |

- **Fix:** padronizar em `toast()` do sonner em toda a app. Ja esta instalado como dependencia.

---

### 13. `src/lib/utils.ts` — codigo morto

- Define `cn()` (clsx + tailwind-merge) mas NUNCA e importado em nenhum componente.
- Esta configurado no `components.json` (shadcn/ui) mas nenhum componente shadcn foi instalado.
- **Fix:** remover se nao for usar shadcn/ui, ou comecar a usar `cn()` nos componentes existentes.

---

### 14. Missing Error Boundaries no React

- Nenhum `<ErrorBoundary>` no app. Se um componente crashar, a tela inteira fica branca.
- **Fix:** adicionar ao menos um ErrorBoundary no `Dashboard.tsx` envolvendo cada tab.

---

### 15. `createConversation` mutation sem auth check

- **Arquivo:** `convex/conversations.ts:224-263`
- A mutation `createConversation` nao verifica autenticacao nem autorizacao.
- Qualquer client com acesso ao endpoint pode criar conversas.
- **Fix:** adicionar o mesmo padrao de auth check que as outras mutations.

---

## BAIXO (Melhorias / Nice-to-have)

### 16. Missing index compound: `apiKeys` — `by_key_hash_and_active`

- `convex/apiKeys.ts:88-92`: filtra `isActive` em memoria apos index `by_key_hash`.
- Se o volume crescer, um compound index `["keyHash", "isActive"]` seria melhor.

---

### 17. `package.json` com nome generico

- Nome atual: `"flex-template"` — deveria ser `"clawcrm"`.

---

### 18. Algumas mutations sem webhook trigger

Mutations que **NAO disparam** webhooks:

- `leads.ts`: `updateLead`, `deleteLead`, `assignLead`, `updateLeadQualification`
- `handoffs.ts`: `acceptHandoff`, `rejectHandoff`

Se integracoes externas dependem desses eventos, estao faltando triggers para: `lead.updated`, `lead.deleted`, `lead.assigned`, `lead.qualification_updated`, `handoff.accepted`, `handoff.rejected`.

---

### 19. `rejectHandoff` usa `acceptedBy` para salvar quem rejeitou

- **Arquivo:** `convex/handoffs.ts:263`

```ts
await ctx.db.patch(args.handoffId, {
  status: "rejected",
  acceptedBy: userMember._id,  // semanticamente errado
  notes: args.notes,
  resolvedAt: now,
});
```

- **Fix:** renomear para `resolvedBy` no schema, ou adicionar campo `rejectedBy`.

---

### 20. `organizationId` na tabela `stages` e redundante

- Stages ja pertencem a um Board (`boardId`), que pertence a uma Organization.
- O `organizationId` em stages e desnormalizacao — aceitavel para performance de queries, mas documentar essa decisao.

---

### 21. `getOrganizationBySlug` sem auth check

- **Arquivo:** `convex/organizations.ts`
- Retorna dados da organizacao sem verificar autenticacao.
- **Risco:** pode expor dados se slugs forem previsiveis.
- **Fix:** adicionar auth check ou limitar os campos retornados (so nome e slug).

---

## Resumo

| Severidade | Qtd | Itens |
|-----------|-----|-------|
| CRITICO   | 5   | #1 - #5  |
| ALTO      | 4   | #6 - #9  |
| MEDIO     | 6   | #10 - #15 |
| BAIXO     | 6   | #16 - #21 |
| **Total** | **21** | |

### Prioridade de acao sugerida

1. **Primeiro:** #2 (hash API keys) + #4 (fix router auth) + #15 (auth em createConversation) — seguranca imediata
2. **Segundo:** #1 (adicionar `returns` validators) + #9 (custom functions para auth) — compliance + reducao de boilerplate
3. **Terceiro:** #6 e #7 (paginacao + indexes) — preparar para escala
4. **Quarto:** #3 (HMAC webhooks) + #5 (CORS) — hardening de seguranca
5. **Por ultimo:** itens medios e baixos conforme prioridade do time
