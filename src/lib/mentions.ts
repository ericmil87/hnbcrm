import { Id } from "../../convex/_generated/dataModel";

// Matches @[Display Name](teamMemberId) tokens in content
export const MENTION_REGEX = /@\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Check if @ at a given index should trigger mention autocomplete
 * (must be at start of string or preceded by whitespace)
 */
export function shouldTriggerMention(text: string, atIndex: number): boolean {
  if (atIndex === 0) return true;
  const charBefore = text[atIndex - 1];
  return charBefore === " " || charBefore === "\n" || charBefore === "\t";
}

/**
 * Get the current mention query from cursor position.
 * Returns null if cursor is not inside an @mention trigger.
 */
export function getMentionQuery(
  text: string,
  cursorPos: number,
): { query: string; triggerIndex: number } | null {
  // Walk backwards from cursor to find the @ trigger
  const textBeforeCursor = text.slice(0, cursorPos);
  const lastAtIndex = textBeforeCursor.lastIndexOf("@");

  if (lastAtIndex === -1) return null;
  if (!shouldTriggerMention(text, lastAtIndex)) return null;

  const queryText = textBeforeCursor.slice(lastAtIndex + 1);

  // If query contains a newline, the @ is on a previous line — not a trigger
  if (queryText.includes("\n")) return null;

  // Check if we're inside an already-completed mention token
  // Walk backwards to see if there's a [ after @
  const afterAt = text.slice(lastAtIndex);
  const completedMatch = afterAt.match(/^@\[[^\]]+\]\([^)]+\)/);
  if (completedMatch && lastAtIndex + completedMatch[0].length >= cursorPos) {
    return null;
  }

  return { query: queryText, triggerIndex: lastAtIndex };
}

/**
 * Insert a mention token at the trigger position, replacing the @query text.
 */
export function insertMention(
  text: string,
  triggerIndex: number,
  cursorPos: number,
  name: string,
  id: string,
): { newText: string; newCursorPosition: number } {
  const token = `@[${name}](${id}) `;
  const before = text.slice(0, triggerIndex);
  const after = text.slice(cursorPos);
  const newText = before + token + after;
  const newCursorPosition = before.length + token.length;

  return { newText, newCursorPosition };
}

/**
 * Extract unique team member IDs from content string.
 */
export function extractMentionIds(content: string): Id<"teamMembers">[] {
  const ids = new Set<string>();
  let match;
  const regex = new RegExp(MENTION_REGEX.source, "g");
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[2]);
  }
  return Array.from(ids) as Id<"teamMembers">[];
}

/**
 * Normalize string for fuzzy matching (remove accents, lowercase).
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Filter team members by query string (case-insensitive, accent-normalized).
 */
export function filterMembers<
  T extends { name: string; email?: string },
>(members: T[], query: string): T[] {
  if (!query.trim()) return members;
  const normalizedQuery = normalize(query);
  return members.filter((m) => {
    const name = normalize(m.name);
    const email = m.email ? normalize(m.email) : "";
    return name.includes(normalizedQuery) || email.includes(normalizedQuery);
  });
}
