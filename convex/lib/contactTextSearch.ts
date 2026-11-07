/**
 * Consulta única do índice `search_contacts` (busca sem acento).
 *
 * O `searchText` é gravado dobrado (`buildSearchText` → `foldForSearch`),
 * então o termo também é dobrado: "antonio", "ANTÔNIO" e "Antônio" acham
 * "Antônio". Contato gravado ANTES da dobra (ainda não passou pelo backfill
 * `opsSearchFold.internalBackfillContactSearchText`) guarda o texto com
 * acento: quando o termo digitado tem acento, uma segunda consulta com o termo
 * cru ainda o encontra. Depois do backfill essa segunda consulta só repete.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { foldForSearch } from "./searchFold";

export async function searchContactsByText(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
  term: string,
  limit: number
): Promise<Doc<"contacts">[]> {
  const raw = term.trim();
  const folded = foldForSearch(raw);
  if (!folded) return [];
  const primary = await ctx.db
    .query("contacts")
    .withSearchIndex("search_contacts", (q) =>
      q.search("searchText", folded).eq("organizationId", organizationId)
    )
    .take(limit);
  if (folded === raw.toLowerCase() || primary.length >= limit) return primary;
  const legacy = await ctx.db
    .query("contacts")
    .withSearchIndex("search_contacts", (q) =>
      q.search("searchText", raw).eq("organizationId", organizationId)
    )
    .take(limit);
  const seen = new Set(primary.map((c) => c._id));
  const out = [...primary];
  for (const c of legacy) {
    if (out.length >= limit) break;
    if (seen.has(c._id)) continue;
    seen.add(c._id);
    out.push(c);
  }
  return out;
}
