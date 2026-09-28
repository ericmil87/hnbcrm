/**
 * Membro removido da org continua existindo para o HISTÓRICO (responsável de
 * um lead antigo, autor de comentário), mas não é opção de atribuição nova — o
 * servidor recusa. Estes helpers separam as duas coisas.
 */
interface MemberLike {
  _id: string;
  name: string;
  removed?: boolean;
}

/**
 * Opções de escolha: sem removidos, exceto quem já está selecionado (para o
 * valor atual não sumir do select/lista e poder ser trocado).
 */
export function assignableMembers<T extends MemberLike>(
  members: readonly T[] | undefined | null,
  keepIds: readonly (string | null | undefined)[] = []
): T[] {
  if (!members) return [];
  const keep = new Set(keepIds.filter((id): id is string => !!id));
  return members.filter((m) => !m.removed || keep.has(m._id));
}

/** Nome para exibição, marcando quem já saiu da org. */
export function memberLabel(member: Pick<MemberLike, "name" | "removed">): string {
  return member.removed ? `${member.name} (removido)` : member.name;
}

/**
 * Convite antigo sem conta: pessoa gravada pelo extinto `createTeamMember`
 * humano, sem `userId`. Desde que o auto-link no cadastro saiu, essa linha só
 * vira gente de verdade se alguém reenviar o convite (o convite adota a linha).
 */
export function isPendingMember(member: {
  type?: string;
  userId?: string | null;
  removed?: boolean;
  pending?: boolean;
}): boolean {
  if (typeof member.pending === "boolean") return member.pending;
  return member.type === "human" && !member.userId && !member.removed;
}
