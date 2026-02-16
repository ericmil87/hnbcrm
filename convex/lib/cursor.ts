// Shared cursor-based pagination helpers.
// Cursor format: "timestamp|documentId"

/**
 * Parse a cursor string into its timestamp and document ID components.
 * Returns null if cursor is undefined or empty.
 */
export function parseCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (!cursor) return null;
  const [ts, id] = cursor.split("|");
  return { ts: Number(ts), id };
}

/**
 * Build a cursor string from a document's _creationTime and _id.
 */
export function buildCursorFromCreationTime(doc: { _creationTime: number; _id: string }): string {
  return `${doc._creationTime}|${doc._id}`;
}

/**
 * Build a cursor string from a document's explicit createdAt field and _id.
 */
export function buildCursorFromCreatedAt(doc: { createdAt: number; _id: string }): string {
  return `${doc.createdAt}|${doc._id}`;
}

/**
 * Apply cursor-based pagination to a list of documents.
 * Returns { items, nextCursor, hasMore }.
 *
 * @param docs - The fetched documents (should be over-read by at least 1)
 * @param limit - The requested page size
 * @param buildCursor - Function to build a cursor from the last item
 */
export function paginateResults<T>(
  docs: T[],
  limit: number,
  buildCursor: (doc: T) => string
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = docs.length > limit;
  const items = docs.slice(0, limit);
  const nextCursor = hasMore && items.length > 0 ? buildCursor(items[items.length - 1]) : null;
  return { items, nextCursor, hasMore };
}
