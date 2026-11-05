// Convites do passo "Equipe" do assistente: regras puras (sem Convex nem React).

export type InviteRole = "admin" | "manager" | "agent";

export interface InviteRow {
  name: string;
  email: string;
  role: InviteRole;
}

export const MAX_INVITES = 10;

export const ROLE_OPTIONS: { value: InviteRole; label: string }[] = [
  { value: "agent", label: "Atendente" },
  { value: "manager", label: "Gerente" },
  { value: "admin", label: "Administrador" },
];

export function inviteKey(row: Pick<InviteRow, "email">): string {
  return `human:${row.email.trim().toLowerCase()}`;
}

/** Linhas com e-mail, sem repetir e sem quem já foi processado com êxito. */
export function inviteRowsToSend(rows: ReadonlyArray<InviteRow>, done: ReadonlySet<string>): InviteRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.email.trim()) return false;
    const key = inviteKey(row);
    if (done.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
