/**
 * Agregação PURA do Painel da Central (`centralAnalytics.getCentralDashboard`).
 * Recebe as linhas já lidas por índice + período e devolve o payload; sem ctx,
 * testável em isolamento.
 *
 * Definições (documentadas aqui porque o painel é o contrato com o cliente):
 *  - Tudo usa os carimbos EXPLÍCITOS `createdAt`/`closedAt` (nunca
 *    `_creationTime`) — é o que deixa o histórico retroativo da simulação certo.
 *  - Só `contactKind` ausente/"lead" entra em leads, conversão, receita, ROAS e
 *    CAC. Hóspede, fornecedor e agência contam em conversas e `contactKinds`.
 *  - leads = leads CRIADOS no período; converted/lost/receita = leads FECHADOS
 *    (won/lost) no período. conversionRate = converted / leads (coortes
 *    diferentes: pode passar de 1 num período curto — é a conta que a Central
 *    faz no dia a dia, "vendas / contatos novos").
 *  - avgFirstResponseSec = média de `firstResponseAt - firstInboundAt` das
 *    conversas criadas no período que têm os dois carimbos.
 *  - aiResolvedRate ("conversas sem humano") = entre as conversas do período
 *    com primeira resposta, a fração em que a 1ª resposta foi da IA, sem
 *    transferência nem repasse e sem responsável humano. Barato (sem ler
 *    mensagens) e conservador: qualquer sinal de humano tira a conversa.
 *  - roas/cac são de MÍDIA PAGA: só entram as reservas cuja origem
 *    (source + campaignKey) tem investimento registrado no período. Receita
 *    de indicação/orgânico dividida pelo gasto inflaria o ROAS (o total
 *    ficaria maior que o de qualquer campanha). roas = receitaPaga / gasto,
 *    cac = gasto / reservasPagas (null com denominador 0).
 *  - daily preenche todo dia do período com zero, no fuso da org.
 */
import { Doc, Id } from "../_generated/dataModel";

export type DashboardInput = {
  from: string; // YYYY-MM-DD (fuso da org)
  to: string; // YYYY-MM-DD (inclusive)
  timezone: string;
  unitId?: Id<"units">;
  conversations: Doc<"conversations">[]; // criadas no período (sem grupos)
  leadsCreated: Doc<"leads">[];
  leadsClosed: Doc<"leads">[];
  leadsById: Map<string, Doc<"leads">>; // leads das conversas (e dos períodos)
  conversationsById: Map<string, Doc<"conversations">>; // conversas de transfers/handoffs
  transfers: Doc<"conversationTransfers">[];
  handoffs: Doc<"handoffs">[];
  adSpend: Doc<"adSpend">[];
  units: Doc<"units">[];
  departments: Doc<"departments">[];
  departmentOpen: Map<string, number>;
  boards: Doc<"boards">[];
  stages: Doc<"stages">[];
  membersById: Map<string, Doc<"teamMembers">>;
  openNow: number;
  truncated: boolean;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Data local YYYY-MM-DD de um instante, no fuso informado. */
export function localDateKey(ms: number, timezone: string): string {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timezone, fmt);
  }
  return fmt.format(new Date(ms));
}

/** Dias do calendário de `from` a `to`, inclusive (aritmética de data, não de horas). */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  const end = Date.UTC(ty, tm - 1, td);
  while (cursor.getTime() <= end && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const isLeadKind = (kind: string | undefined) => kind === undefined || kind === "lead";
const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);
const ratioOrNull = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

const SPEND_SOURCE: Record<Doc<"adSpend">["platform"], string> = {
  meta: "meta_ads",
  google: "google_ads",
  other: "outros",
};
export const NO_SOURCE = "sem_origem";

export function computeCentralDashboard(input: DashboardInput) {
  const { unitId, timezone } = input;
  const leadOf = (c: Doc<"conversations">) =>
    c.leadId ? input.leadsById.get(c.leadId) ?? null : null;
  const convUnit = (c: Doc<"conversations">) => c.unitId ?? leadOf(c)?.unitId;
  const inUnit = (u: Id<"units"> | undefined) => !unitId || u === unitId;

  const conversations = input.conversations.filter((c) => inUnit(convUnit(c)));
  const leadsCreated = input.leadsCreated.filter(
    (l) => inUnit(l.unitId) && isLeadKind(l.contactKind)
  );
  const leadsClosed = input.leadsClosed.filter(
    (l) => inUnit(l.unitId) && isLeadKind(l.contactKind) && l.closedType
  );
  const won = leadsClosed.filter((l) => l.closedType === "won");
  const lost = leadsClosed.filter((l) => l.closedType === "lost");
  const spendRows = input.adSpend.filter((r) => inUnit(r.unitId));
  const transfers = input.transfers.filter((t) => {
    const c = input.conversationsById.get(t.conversationId);
    return !unitId || (c && inUnit(convUnit(c)));
  });
  const handoffs = input.handoffs.filter((h) => {
    if (!unitId) return true;
    const c = h.conversationId ? input.conversationsById.get(h.conversationId) : undefined;
    const lead = h.leadId ? input.leadsById.get(h.leadId) : undefined;
    return inUnit(c ? convUnit(c) : lead?.unitId);
  });

  const revenue = won.reduce((sum, l) => sum + (l.value || 0), 0);
  const spend = spendRows.reduce((sum, r) => sum + r.amount, 0);
  // Origens com investimento no período (source + campaignKey) = mídia paga.
  const paidKeys = new Set(
    spendRows.filter((r) => r.amount > 0).map((r) => `${SPEND_SOURCE[r.platform]}|${r.campaignKey}`)
  );
  const isPaid = (l: Doc<"leads">) =>
    !!l.attribution && paidKeys.has(`${l.attribution.source}|${l.attribution.campaignKey ?? ""}`);

  // Primeira resposta
  const responseSecs = (list: Doc<"conversations">[]) => {
    const secs = list
      .filter((c) => c.firstInboundAt !== undefined && c.firstResponseAt !== undefined)
      .map((c) => (c.firstResponseAt! - c.firstInboundAt!) / 1000)
      .filter((s) => s >= 0);
    return secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null;
  };

  // "Sem humano"
  const transferred = new Set(transfers.map((t) => t.conversationId as string));
  const handedOff = new Set(
    handoffs.map((h) => h.conversationId as string | undefined).filter(Boolean) as string[]
  );
  const answered = conversations.filter((c) => c.firstResponseAt !== undefined);
  const aiResolved = answered.filter((c) => {
    if (c.firstResponderType !== "ai") return false;
    if (transferred.has(c._id) || handedOff.has(c._id)) return false;
    const owner = c.assignedTo ? input.membersById.get(c.assignedTo) : undefined;
    return !owner || owner.type === "ai";
  });

  // Diário
  const dayKeys = daysBetween(input.from, input.to);
  const daily = new Map(
    dayKeys.map((date) => [date, { date, conversations: 0, leads: 0, converted: 0, revenue: 0 }])
  );
  for (const c of conversations) {
    const row = daily.get(localDateKey(c.createdAt, timezone));
    if (row) row.conversations++;
  }
  for (const l of leadsCreated) {
    const row = daily.get(localDateKey(l.createdAt, timezone));
    if (row) row.leads++;
  }
  for (const l of won) {
    const row = daily.get(localDateKey(l.closedAt!, timezone));
    if (row) {
      row.converted++;
      row.revenue += l.value || 0;
    }
  }

  // Por unidade (+ "sem unidade" quando há dado sem unidade e não há filtro)
  const unitRows = input.units
    .filter((u) => inUnit(u._id))
    .map((u) => ({ unitId: u._id as Id<"units"> | null, name: u.name, color: u.color }));
  if (!unitId) unitRows.push({ unitId: null, name: "Sem unidade", color: "#71717a" });
  const byUnit = unitRows
    .map((u) => {
      const match = (id: Id<"units"> | undefined) => (id ?? null) === u.unitId;
      const leads = leadsCreated.filter((l) => match(l.unitId)).length;
      const uWon = won.filter((l) => match(l.unitId));
      const uRevenue = uWon.reduce((sum, l) => sum + (l.value || 0), 0);
      const uSpend = spendRows.filter((r) => match(r.unitId)).reduce((s, r) => s + r.amount, 0);
      const uPaidRevenue = uWon.filter(isPaid).reduce((sum, l) => sum + (l.value || 0), 0);
      return {
        unitId: u.unitId,
        name: u.name,
        color: u.color,
        leads,
        converted: uWon.length,
        conversionRate: round2(ratio(uWon.length, leads)),
        revenue: uRevenue,
        avgTicket: round2(ratio(uRevenue, uWon.length)),
        spend: uSpend,
        roas: ratioOrNull(uPaidRevenue, uSpend),
      };
    })
    .filter((row) => row.unitId !== null || row.leads + row.converted + row.spend > 0);

  // Por setor
  const byDepartment = input.departments.map((d) => {
    const convs = conversations.filter((c) => c.departmentId === d._id);
    return {
      departmentId: d._id,
      name: d.name,
      color: d.color,
      conversations: convs.length,
      open: input.departmentOpen.get(d._id) ?? 0,
      transfersIn: transfers.filter((t) => t.toDepartmentId === d._id).length,
      avgFirstResponseSec: responseSecs(convs),
    };
  });

  // Por origem (source + campanha)
  type SourceRow = {
    source: string;
    campaignKey: string;
    campaignName?: string;
    leads: number;
    converted: number;
    revenue: number;
    spend: number;
  };
  const sources = new Map<string, SourceRow>();
  const sourceRow = (source: string, campaignKey: string, campaignName?: string) => {
    const key = `${source}\u0000${campaignKey}`;
    let row = sources.get(key);
    if (!row) {
      row = { source, campaignKey, leads: 0, converted: 0, revenue: 0, spend: 0 };
      sources.set(key, row);
    }
    if (!row.campaignName && campaignName) row.campaignName = campaignName;
    return row;
  };
  for (const l of leadsCreated) {
    sourceRow(
      l.attribution?.source ?? NO_SOURCE,
      l.attribution?.campaignKey ?? "",
      l.attribution?.campaignName
    ).leads++;
  }
  for (const l of won) {
    const row = sourceRow(
      l.attribution?.source ?? NO_SOURCE,
      l.attribution?.campaignKey ?? "",
      l.attribution?.campaignName
    );
    row.converted++;
    row.revenue += l.value || 0;
  }
  for (const r of spendRows) {
    sourceRow(SPEND_SOURCE[r.platform], r.campaignKey, r.campaignName).spend += r.amount;
  }
  const bySource = [...sources.values()]
    .map((row) => ({
      source: row.source,
      ...(row.campaignKey ? { campaignKey: row.campaignKey } : {}),
      ...(row.campaignName ? { campaignName: row.campaignName } : {}),
      leads: row.leads,
      converted: row.converted,
      revenue: row.revenue,
      spend: row.spend,
      cac: ratioOrNull(row.spend, row.converted),
      roas: ratioOrNull(row.revenue, row.spend),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads || b.spend - a.spend);

  // Motivos de perda
  const reasons = new Map<string, number>();
  for (const l of lost) {
    const reason = l.closedReason?.trim() || "Sem motivo informado";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const lostReasons = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // Por responsável (dono da conversa, ou do lead)
  const responders = new Map<
    string,
    { memberId: Id<"teamMembers"> | null; name: string; type: "ai" | "human"; conversations: number; converted: number }
  >();
  for (const c of conversations) {
    const lead = leadOf(c);
    const ownerId = c.assignedTo ?? lead?.assignedTo;
    const owner = ownerId ? input.membersById.get(ownerId) : undefined;
    let key: string;
    let seed: { memberId: Id<"teamMembers"> | null; name: string; type: "ai" | "human" };
    if (owner) {
      key = owner._id;
      seed = { memberId: owner._id, name: owner.name, type: owner.type };
    } else if (c.firstResponderType === "ai") {
      key = "none:ai";
      seed = { memberId: null, name: "Atendimento IA", type: "ai" };
    } else {
      key = "none:human";
      seed = { memberId: null, name: "Sem responsável", type: "human" };
    }
    let row = responders.get(key);
    if (!row) {
      row = { ...seed, conversations: 0, converted: 0 };
      responders.set(key, row);
    }
    row.conversations++;
    if (lead?.closedType === "won" && isLeadKind(lead.contactKind)) row.converted++;
  }
  const byResponder = [...responders.values()].sort((a, b) => b.conversations - a.conversations);

  // Funil: leads DE RESERVA criados no período, pelo estágio ATUAL. Fornecedor/
  // agência/hóspede ficam fora — senão o board deles se mistura ao funil de venda.
  const stageCounts = new Map<string, number>();
  for (const l of leadsCreated) {
    if (!isLeadKind(l.contactKind)) continue;
    stageCounts.set(l.stageId, (stageCounts.get(l.stageId) ?? 0) + 1);
  }
  const boardOrder = new Map(input.boards.map((b) => [b._id as string, b.order]));
  const touchedBoards = new Set(
    input.stages.filter((s) => stageCounts.has(s._id)).map((s) => s.boardId as string)
  );
  const defaultBoard = input.boards.find((b) => b.isDefault && !b.archivedAt);
  if (defaultBoard) touchedBoards.add(defaultBoard._id);
  const funnel = input.stages
    .filter((s) => touchedBoards.has(s.boardId))
    .sort(
      (a, b) =>
        (boardOrder.get(a.boardId) ?? 0) - (boardOrder.get(b.boardId) ?? 0) || a.order - b.order
    )
    .map((s) => ({ stageId: s._id, name: s.name, color: s.color, count: stageCounts.get(s._id) ?? 0 }));

  // Tipos de contato
  const kinds = new Map<string, number>();
  for (const c of conversations) {
    const kind = c.contactKind ?? leadOf(c)?.contactKind ?? "lead";
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const contactKinds = [...kinds.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  const paidWon = won.filter(isPaid);
  const paidRevenue = paidWon.reduce((sum, l) => sum + (l.value || 0), 0);

  return {
    period: { from: input.from, to: input.to, timezone },
    truncated: input.truncated,
    totals: {
      conversations: conversations.length,
      leads: leadsCreated.length,
      converted: won.length,
      lost: lost.length,
      conversionRate: round2(ratio(won.length, leadsCreated.length)),
      revenue,
      avgTicket: round2(ratio(revenue, won.length)),
      avgFirstResponseSec: responseSecs(conversations),
      aiResolvedRate: round2(ratio(aiResolved.length, answered.length)),
      handoffs: handoffs.length,
      transfers: transfers.length,
      openNow: input.openNow,
      spend,
      paidConverted: paidWon.length,
      paidRevenue,
      cac: ratioOrNull(spend, paidWon.length),
      roas: ratioOrNull(paidRevenue, spend),
    },
    daily: [...daily.values()],
    byUnit,
    byDepartment,
    bySource,
    lostReasons,
    byResponder,
    funnel,
    contactKinds,
  };
}
