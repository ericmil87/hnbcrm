/**
 * Público de GRUPO das campanhas (v0.57 / F5 — D9 e D15), parte pura.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *  1. o NOSSO número nunca entra no público (mandaríamos a campanha para nós);
 *  2. a mesma pessoa em dois grupos recebe UMA vez, e o primeiro grupo vence
 *     como origem (senão o relatório por grupo conta em dobro);
 *  3. o funil que a prévia mostra bate com o que o lançamento materializa.
 */
import { describe, expect, test } from "vitest";
import {
  buildGroupMembersAudience,
  buildGroupsAudience,
  spreadOverDays,
  assignSpreadDays,
  maskMemberPhone,
  participantKey,
  groupsWithUnknownSelf,
  unknownSelfMessage,
  normalizeIncludeKeys,
  INCLUDE_KEYS_MAX,
  type GroupAudienceGroup,
  type GroupParticipantLike,
} from "./campaignAudience";
import type { Id } from "../_generated/dataModel";

const gid = (n: string) => n as unknown as Id<"groupChats">;
const cid = (n: string) => n as unknown as Id<"conversations">;
const contactId = (n: string) => n as unknown as Id<"contacts">;

function member(overrides: Partial<GroupParticipantLike> = {}): GroupParticipantLike {
  return { isAdmin: false, isSuperAdmin: false, ...overrides };
}

function group(overrides: Partial<GroupAudienceGroup> = {}): GroupAudienceGroup {
  return {
    groupChatId: gid("g1"),
    subject: "Grupo Teste",
    jid: "120363000000000001@g.us",
    monitored: true,
    conversationId: cid("c1"),
    selfKey: "99999@lid",
    selfPhone: "5511900000000",
    participants: [],
    ...overrides,
  };
}

describe("buildGroupMembersAudience — funil", () => {
  test("total → com telefone → sem duplicata → sem opt-out → finais", () => {
    const g = group({
      participants: [
        member({ phone: "5511988887777", name: "Ana" }),
        member({ phone: "5511988886666", name: "Bruno" }),
        member({ lid: "123@lid" }), // sem telefone
        member({ phone: "5511988885555", name: "Carla" }),
      ],
    });
    const result = buildGroupMembersAudience({
      groups: [g],
      optOuts: new Set(["5511988886666"]),
    });
    expect(result.funnel).toEqual({
      total: 4,
      withPhone: 3,
      deduped: 3,
      afterOptOut: 2,
      afterFilters: 2,
      final: 2,
    });
    expect(result.excluded.no_phone).toBe(1);
    expect(result.excluded.opted_out).toBe(1);
    expect(result.recipients.map((r) => r.memberName)).toEqual(["Ana", "Carla"]);
  });

  test("o NOSSO número nunca entra — nem pelo lid nem pelo telefone", () => {
    const g = group({
      selfKey: "meu@lid",
      selfPhone: "5511900000000",
      participants: [
        member({ lid: "meu@lid", phone: "5511900000000", name: "Eu (lid)" }),
        member({ phone: "5511900000000", name: "Eu (telefone)" }),
        member({ phone: "5511988887777", name: "Ana" }),
      ],
    });
    const result = buildGroupMembersAudience({ groups: [g] });
    expect(result.excluded.self).toBe(2);
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0].memberName).toBe("Ana");
  });

  test("quem saiu do grupo não entra e não conta no total", () => {
    const g = group({
      participants: [
        member({ phone: "5511988887777", name: "Ana", leftAt: 1_000 }),
        member({ phone: "5511988886666", name: "Bruno" }),
      ],
    });
    const result = buildGroupMembersAudience({ groups: [g] });
    expect(result.excluded.left).toBe(1);
    expect(result.funnel.total).toBe(1);
    expect(result.recipients).toHaveLength(1);
  });

  test("telefone é normalizado (9º dígito) e o repetido cai fora", () => {
    const g = group({
      participants: [
        member({ phone: "11988887777", name: "Ana" }), // sem DDI
        member({ phone: "+55 (11) 98888-7777", name: "Ana de novo" }),
      ],
    });
    const result = buildGroupMembersAudience({ groups: [g] });
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0].phone).toBe("5511988887777");
    expect(result.excluded.duplicate).toBe(1);
  });

  test("telefone impossível vira invalid_phone, não destinatário", () => {
    const g = group({ participants: [member({ phone: "123" }), member({ phone: "5511988887777" })] });
    const result = buildGroupMembersAudience({ groups: [g] });
    expect(result.excluded.invalid_phone).toBe(1);
    expect(result.recipients).toHaveLength(1);
  });
});

describe("buildGroupMembersAudience — dedupe entre grupos", () => {
  test("o PRIMEIRO grupo escolhido vence como origem", () => {
    const a = group({
      groupChatId: gid("gA"),
      subject: "Clientes A",
      participants: [member({ phone: "5511988887777", name: "Ana" })],
    });
    const b = group({
      groupChatId: gid("gB"),
      subject: "Clientes B",
      conversationId: cid("c2"),
      participants: [
        member({ phone: "5511988887777", name: "Ana" }),
        member({ phone: "5511988886666", name: "Bruno" }),
      ],
    });
    const result = buildGroupMembersAudience({ groups: [a, b] });
    expect(result.recipients).toHaveLength(2);
    expect(result.recipients[0].sourceGroupChatId).toBe(gid("gA"));
    expect(result.excluded.duplicate).toBe(1);
    expect(result.perGroup).toEqual([
      { groupChatId: gid("gA"), subject: "Clientes A", count: 1 },
      { groupChatId: gid("gB"), subject: "Clientes B", count: 1 },
    ]);
  });

  test("inverter a ordem inverte a origem", () => {
    const a = group({ groupChatId: gid("gA"), participants: [member({ phone: "5511988887777" })] });
    const b = group({ groupChatId: gid("gB"), participants: [member({ phone: "5511988887777" })] });
    expect(buildGroupMembersAudience({ groups: [b, a] }).recipients[0].sourceGroupChatId).toBe(gid("gB"));
  });
});

describe("buildGroupMembersAudience — filtros do §7.1", () => {
  const base = () =>
    group({
      participants: [
        member({ phone: "5511988887777", name: "Ana", isAdmin: true }),
        member({ phone: "5511988886666", name: "Bruno", contactId: contactId("k1") }),
        member({ phone: "5511988885555", name: "Carla", lid: "carla@lid" }),
      ],
    });

  test("excluir admins", () => {
    const r = buildGroupMembersAudience({ groups: [base()], filters: { excludeAdmins: true } });
    expect(r.excluded.admin).toBe(1);
    expect(r.recipients.map((x) => x.memberName)).toEqual(["Bruno", "Carla"]);
  });

  test("excluir quem já é contato (pelo vínculo do participante ou pelo telefone)", () => {
    const r = buildGroupMembersAudience({
      groups: [base()],
      filters: { excludeExistingContacts: true },
      existingContactPhones: new Set(["5511988887777"]),
    });
    expect(r.excluded.existing_contact).toBe(2);
    expect(r.recipients.map((x) => x.memberName)).toEqual(["Carla"]);
  });

  test("excluir quem recebeu campanha há pouco", () => {
    const r = buildGroupMembersAudience({
      groups: [base()],
      filters: { excludeCampaignedWithinDays: 30 },
      recentlyCampaigned: new Set(["5511988885555"]),
    });
    expect(r.excluded.campaigned_recently).toBe(1);
    expect(r.recipients).toHaveLength(2);
  });

  test("só quem falou no grupo — casa por lid OU por telefone", () => {
    const r = buildGroupMembersAudience({
      groups: [base()],
      filters: { activeInGroupWithinDays: 7 },
      activeKeys: new Map([["g1", new Set(["carla@lid", "5511988887777"])]]),
    });
    expect(r.recipients.map((x) => x.memberName)).toEqual(["Ana", "Carla"]);
    expect(r.excluded.inactive_in_group).toBe(1);
  });

  test("sem nenhuma mensagem na janela, o filtro zera o público (não passa geral)", () => {
    const r = buildGroupMembersAudience({
      groups: [base()],
      filters: { activeInGroupWithinDays: 7 },
      activeKeys: new Map([["g1", new Set()]]),
    });
    expect(r.recipients).toHaveLength(0);
    expect(r.excluded.inactive_in_group).toBe(3);
  });

  test("excluir membros de outro grupo", () => {
    const r = buildGroupMembersAudience({
      groups: [base()],
      filters: { excludeGroupChatIds: [gid("gX")] },
      excludedGroupPhones: new Set(["5511988886666"]),
    });
    expect(r.excluded.in_excluded_group).toBe(1);
    expect(r.recipients).toHaveLength(2);
  });

  test("opt-out vence qualquer filtro (sai antes, conta como opt-out)", () => {
    const r = buildGroupMembersAudience({
      groups: [base()],
      filters: { excludeAdmins: true },
      optOuts: new Set(["5511988887777"]),
    });
    expect(r.excluded.opted_out).toBe(1);
    expect(r.excluded.admin).toBe(0);
  });
});

describe("buildGroupMembersAudience — amostra e teto", () => {
  test("amostra tem no máximo 10, com telefone mascarado", () => {
    const participants = Array.from({ length: 15 }, (_, i) =>
      member({ phone: `551198888${String(1000 + i)}`, name: `Pessoa ${i}` })
    );
    const r = buildGroupMembersAudience({ groups: [group({ participants })] });
    expect(r.recipients).toHaveLength(15);
    expect(r.sample).toHaveLength(10);
    expect(r.sample[0].phone).not.toContain("98888");
    expect(r.sample[0].group).toBe("Grupo Teste");
  });

  test("limit corta a materialização sem mentir no funil", () => {
    const participants = Array.from({ length: 5 }, (_, i) =>
      member({ phone: `551198888${String(2000 + i)}` })
    );
    const r = buildGroupMembersAudience({ groups: [group({ participants })], limit: 2 });
    expect(r.recipients).toHaveLength(2);
    expect(r.funnel.withPhone).toBe(5);
  });

  test("maskMemberPhone nunca devolve o número inteiro", () => {
    expect(maskMemberPhone("5511988887777")).toBe("5511••••7777");
    expect(maskMemberPhone("")).toBe("");
  });

  test("participantKey é lid antes de telefone", () => {
    expect(participantKey(member({ lid: "a@lid", phone: "5511" }))).toBe("a@lid");
    expect(participantKey(member({ phone: "5511" }))).toBe("5511");
  });
});

describe("buildGroupsAudience", () => {
  test("uma sala monitorada com conversa = um destinatário; alcance é a soma", () => {
    const a = group({
      groupChatId: gid("gA"),
      subject: "A",
      jid: "1@g.us",
      participants: [member({ phone: "5511988887777" }), member({ phone: "5511988886666" })],
    });
    const b = group({
      groupChatId: gid("gB"),
      subject: "B",
      jid: "2@g.us",
      conversationId: cid("c2"),
      participantsCount: 40,
      participants: [],
    });
    const r = buildGroupsAudience({ groups: [a, b] });
    expect(r.recipients.map((x) => x.jid)).toEqual(["1@g.us", "2@g.us"]);
    expect(r.reach).toBe(2);
  });

  test("não monitorado e sem conversa ficam de fora, com motivo", () => {
    const r = buildGroupsAudience({
      groups: [
        group({ groupChatId: gid("g1"), subject: "Sem acompanhar", monitored: false }),
        group({ groupChatId: gid("g2"), subject: "Sem conversa", jid: "2@g.us", conversationId: undefined }),
      ],
    });
    expect(r.recipients).toHaveLength(0);
    expect(r.excluded.not_monitored).toBe(1);
    expect(r.excluded.no_conversation).toBe(1);
    expect(r.skipped.map((x) => x.subject)).toEqual(["Sem acompanhar", "Sem conversa"]);
  });

  test("mesmo JID duas vezes = um destinatário só", () => {
    const g = group();
    const r = buildGroupsAudience({ groups: [g, { ...g, groupChatId: gid("g2") }] });
    expect(r.recipients).toHaveLength(1);
    expect(r.excluded.duplicate).toBe(1);
  });
});

describe("espalhamento em dias", () => {
  test("spreadOverDays: grupos correm em paralelo, manda o maior", () => {
    expect(spreadOverDays(25, 10)).toBe(3);
    expect(spreadOverDays([25, 5], 10)).toBe(3);
    expect(spreadOverDays([5, 5], 10)).toBe(1);
    expect(spreadOverDays(0, 10)).toBe(1);
    expect(spreadOverDays([], 10)).toBe(0);
  });

  test("assignSpreadDays: o dia avança a cada N do MESMO grupo", () => {
    const recipients = [
      { sourceGroupChatId: gid("gA") },
      { sourceGroupChatId: gid("gA") },
      { sourceGroupChatId: gid("gA") },
      { sourceGroupChatId: gid("gB") },
      { sourceGroupChatId: gid("gB") },
    ];
    const out = assignSpreadDays(recipients, 2);
    // Cada grupo mantém o próprio ritmo (2/dia): gA tem dois no dia 0 e um no 1.
    const byGroup = (g: string) =>
      out.filter((r) => String(r.sourceGroupChatId) === String(gid(g))).map((r) => r.dayIndex);
    expect(byGroup("gA")).toEqual([0, 0, 1]);
    expect(byGroup("gB")).toEqual([0, 0]);
  });

  test("assignSpreadDays: a ORDEM é dia crescente, intercalando os grupos", () => {
    const recipients = [
      { sourceGroupChatId: gid("gA"), n: 1 },
      { sourceGroupChatId: gid("gA"), n: 2 },
      { sourceGroupChatId: gid("gA"), n: 3 },
      { sourceGroupChatId: gid("gB"), n: 4 },
      { sourceGroupChatId: gid("gB"), n: 5 },
    ];
    // Sem isto, as linhas do gA (inclusive as de amanhã) ficam todas antes das
    // do gB — e a janela finita do worker nunca alcança o segundo grupo no dia 0.
    expect(assignSpreadDays(recipients, 2).map((r) => r.n)).toEqual([1, 4, 2, 5, 3]);
    expect(assignSpreadDays(recipients, 2).map((r) => r.dayIndex)).toEqual([0, 0, 0, 0, 1]);
  });

  test("assignSpreadDays: com um grupo só a ordem original é preservada", () => {
    const recipients = [
      { sourceGroupChatId: gid("gA"), n: 1 },
      { sourceGroupChatId: gid("gA"), n: 2 },
      { sourceGroupChatId: gid("gA"), n: 3 },
    ];
    expect(assignSpreadDays(recipients, 2).map((r) => r.n)).toEqual([1, 2, 3]);
  });
});

describe("teto do público de membros (limite de leituras da transação)", () => {
  test("limite corta os excedentes e o resultado avisa", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      member({ lid: `l${i}@lid`, phone: `551198887000${i}`, name: `M${i}` })
    );
    const r = buildGroupMembersAudience({
      groups: [group({ participants: many })],
      limit: 3,
    });
    expect(r.recipients).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.overLimit).toBe(2);
    expect(r.funnel.final).toBe(3);
    // `afterFilters` conta quem PASSOU nos filtros, inclusive quem o teto cortou.
    expect(r.funnel.afterFilters).toBe(5);
  });

  test("sem estourar o teto, nada é marcado como truncado", () => {
    const r = buildGroupMembersAudience({
      groups: [group({ participants: [member({ phone: "5511988887777", name: "Ana" })] })],
      limit: 100,
    });
    expect(r.truncated).toBe(false);
    expect(r.overLimit).toBe(0);
  });
});

describe("identidade própria desconhecida (correção 22, parte 2)", () => {
  test("sem selfKey e sem selfPhone a sala é apontada", () => {
    const unknown = group({ groupChatId: gid("g9"), subject: "Sem self", selfKey: null, selfPhone: null });
    const known = group();
    expect(groupsWithUnknownSelf([known, unknown]).map((g) => g.subject)).toEqual(["Sem self"]);
  });

  test("só o telefone já conta como conhecido (gateway sem LID)", () => {
    const g = group({ selfKey: null, selfPhone: "5511900000000" });
    expect(groupsWithUnknownSelf([g])).toEqual([]);
  });

  test("a mensagem nomeia a sala e diz como resolver", () => {
    const msg = unknownSelfMessage([group({ subject: "Grupo-Teste-Eric", selfKey: null, selfPhone: null })]);
    expect(msg).toContain("«Grupo-Teste-Eric»");
    expect(msg).toContain("próprio número da empresa");
  });

  test("com várias salas a mensagem conta quantas são", () => {
    const many = ["A", "B", "C", "D"].map((subject, i) =>
      group({ groupChatId: gid(`g${i}`), subject, selfKey: null, selfPhone: null })
    );
    const msg = unknownSelfMessage(many);
    expect(msg).toContain("4 grupos");
    expect(msg).toContain("…");
  });

  /**
   * A razão de existir da recusa: sem o self o builder não tem como filtrar o
   * nosso número, e ele vira destinatário de uma campanha de prospecção.
   */
  test("sem a recusa o próprio número entraria no público", () => {
    const g = group({
      selfKey: null,
      selfPhone: null,
      participants: [
        member({ lid: "99999@lid", phone: "5511900000000", name: "HNB CRM" }), // nós
        member({ phone: "5511988887777", name: "Ana" }),
      ],
    });
    const r = buildGroupMembersAudience({ groups: [g] });
    expect(r.recipients.map((x) => x.phone)).toContain("5511900000000");
    expect(r.excluded.self).toBe(0);
    expect(groupsWithUnknownSelf([g])).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seleção explícita de membros (`includeKeys`) e a lista "quem vai receber"
//
// O que estes testes protegem: a seleção é um RECORTE do público, nunca uma
// fonte de destinatário. Uma chave que não existe mais na sala não pode fazer
// ninguém receber mensagem, e um admin escolhido a dedo continua saindo quando
// "excluir admins" está ligado — senão a tela prometeria uma coisa e o
// lançamento faria outra.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildGroupMembersAudience — includeKeys", () => {
  const trio = () =>
    group({
      participants: [
        member({ phone: "5511988887777", name: "Ana", lid: "ana@lid", isAdmin: true }),
        member({ phone: "5511988886666", name: "Bruno", lid: "bruno@lid" }),
        member({ phone: "5511988885555", name: "Carla", lid: "carla@lid" }),
      ],
    });

  test("só os escolhidos entram; o resto vira not_selected", () => {
    const r = buildGroupMembersAudience({
      groups: [trio()],
      filters: { includeKeys: ["bruno@lid"] },
    });
    expect(r.recipients.map((x) => x.memberName)).toEqual(["Bruno"]);
    expect(r.excluded.not_selected).toBe(2);
    // O funil enxerga a seleção: não adianta prometer 3 e mandar para 1.
    expect(r.funnel).toMatchObject({ total: 3, withPhone: 3, afterOptOut: 3, final: 1 });
  });

  test("a chave é `lid ?? phone` — quem não tem lid entra pelo telefone", () => {
    const g = group({
      participants: [
        member({ phone: "5511988887777", name: "Ana" }),
        member({ phone: "5511988886666", name: "Bruno" }),
      ],
    });
    const r = buildGroupMembersAudience({ groups: [g], filters: { includeKeys: ["5511988886666"] } });
    expect(r.recipients.map((x) => x.memberName)).toEqual(["Bruno"]);
  });

  test("chave desconhecida é IGNORADA — nunca vira destinatário", () => {
    const r = buildGroupMembersAudience({
      groups: [trio()],
      filters: { includeKeys: ["bruno@lid", "fantasma@lid", "5511900009999"] },
    });
    expect(r.recipients.map((x) => x.memberName)).toEqual(["Bruno"]);
    expect(r.funnel.final).toBe(1);
  });

  test("lista vazia = sem seleção = todos os elegíveis", () => {
    const r = buildGroupMembersAudience({ groups: [trio()], filters: { includeKeys: [] } });
    expect(r.recipients).toHaveLength(3);
    expect(r.excluded.not_selected).toBe(0);
  });

  test("admin escolhido + excludeAdmins: fica de fora, e o motivo é 'admin'", () => {
    const r = buildGroupMembersAudience({
      groups: [trio()],
      filters: { includeKeys: ["ana@lid", "bruno@lid"], excludeAdmins: true },
      memberList: {},
    });
    expect(r.recipients.map((x) => x.memberName)).toEqual(["Bruno"]);
    expect(r.excluded.admin).toBe(1);
    const ana = r.members.find((m) => m.key === "ana@lid");
    expect(ana?.excludedReason).toBe("admin");
    // Carla não foi escolhida: o motivo dela é outro.
    expect(r.members.find((m) => m.key === "carla@lid")?.excludedReason).toBe("not_selected");
  });

  test("opt-out vence a seleção (a supressão é org-wide, não negociável)", () => {
    const r = buildGroupMembersAudience({
      groups: [trio()],
      filters: { includeKeys: ["bruno@lid"] },
      optOuts: new Set(["5511988886666"]),
      memberList: {},
    });
    expect(r.recipients).toHaveLength(0);
    expect(r.members.find((m) => m.key === "bruno@lid")?.excludedReason).toBe("opted_out");
  });
});

describe("normalizeIncludeKeys", () => {
  test("tira repetidas e vazias; lista vazia vira undefined", () => {
    expect(normalizeIncludeKeys(["a", "a", " b ", ""])).toEqual(["a", "b"]);
    expect(normalizeIncludeKeys([])).toBeUndefined();
    expect(normalizeIncludeKeys(undefined)).toBeUndefined();
  });

  test("acima do teto é chamada mal-formada, não seleção grande", () => {
    const many = Array.from({ length: INCLUDE_KEYS_MAX + 1 }, (_, i) => `k${i}`);
    expect(() => normalizeIncludeKeys(many)).toThrow(/máximo é 1024/);
  });
});

describe("buildGroupMembersAudience — lista 'quem vai receber'", () => {
  test("sem memberList a lista não é montada (o snapshot não paga por ela)", () => {
    const r = buildGroupMembersAudience({
      groups: [group({ participants: [member({ phone: "5511988887777", name: "Ana" })] })],
    });
    expect(r.members).toEqual([]);
    expect(r.membersTotal).toBe(0);
    expect(r.membersTruncated).toBe(false);
  });

  test("mostra TODO MUNDO com o motivo de quem ficou de fora", () => {
    const g = group({
      selfKey: "meu@lid",
      selfPhone: "5511900000000",
      participants: [
        member({ lid: "meu@lid", phone: "5511900000000", name: "Guardião", isAdmin: true }),
        member({ phone: "5511988887777", name: "Ana", lid: "ana@lid", isAdmin: true }),
        member({ phone: "5511988886666", name: "Bruno", lid: "bruno@lid", contactId: contactId("k1") }),
        member({ lid: "sem-telefone@lid", name: "Dani" }),
        member({ phone: "5511988885555", name: "Fora", leftAt: 1_000 }),
      ],
    });
    const r = buildGroupMembersAudience({
      groups: [g],
      filters: { excludeAdmins: true },
      memberList: {},
    });
    const byKey = Object.fromEntries(r.members.map((m) => [m.key, m]));
    // Quem saiu não aparece: não é decisão do operador.
    expect(r.members).toHaveLength(4);
    expect(byKey["meu@lid"].excludedReason).toBe("self");
    expect(byKey["ana@lid"].excludedReason).toBe("admin");
    expect(byKey["bruno@lid"].excludedReason).toBeUndefined();
    expect(byKey["bruno@lid"].isContact).toBe(true);
    expect(byKey["sem-telefone@lid"].excludedReason).toBe("no_phone");
    expect(byKey["sem-telefone@lid"].phoneMasked).toBe("");
    expect(byKey["ana@lid"].isAdmin).toBe(true);
    expect(byKey["ana@lid"].groupSubject).toBe("Grupo Teste");
  });

  test("telefone cru só com revealPhones; senão apenas a máscara", () => {
    const g = group({ participants: [member({ phone: "5511988887777", name: "Ana" })] });
    const masked = buildGroupMembersAudience({ groups: [g], memberList: {} });
    expect(masked.members[0].phone).toBeUndefined();
    expect(masked.members[0].phoneMasked).toMatch(/•/);

    const full = buildGroupMembersAudience({ groups: [g], memberList: { revealPhones: true } });
    expect(full.members[0].phone).toBe("5511988887777");
  });

  test("teto de linhas: a lista corta e avisa, o público NÃO", () => {
    const g = group({
      participants: Array.from({ length: 12 }, (_, i) =>
        member({ phone: `551198888${String(1000 + i)}`, name: `P${i}` })
      ),
    });
    const r = buildGroupMembersAudience({ groups: [g], memberList: { limit: 5 } });
    expect(r.members).toHaveLength(5);
    expect(r.membersTotal).toBe(12);
    expect(r.membersTruncated).toBe(true);
    expect(r.recipients).toHaveLength(12);
    expect(r.truncated).toBe(false);
  });
});
