import { GenericDatabaseReader } from "convex/server";

/**
 * Batch-fetch documents by IDs and return a Map for O(1) lookup.
 * Filters out null/undefined IDs and deduplicates before fetching.
 */
export async function batchGet<T extends string>(
  db: GenericDatabaseReader<any>,
  ids: (string | null | undefined)[]
): Promise<Map<string, any>> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => id != null))];
  const docs = await Promise.all(uniqueIds.map((id) => db.get(id as any)));
  const map = new Map<string, any>();
  for (let i = 0; i < uniqueIds.length; i++) {
    if (docs[i]) map.set(uniqueIds[i], docs[i]);
  }
  return map;
}
