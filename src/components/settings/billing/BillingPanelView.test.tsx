import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { BillingPanelView, type BillingPanelViewProps } from "./BillingPanelView";
import { AttendancesStatementView } from "./AttendancesStatement";
import { OverageCardView, type OverageCardViewProps } from "./OverageCard";
import type { ChannelAndGroupUsage, Entitlements, UsageSummary } from "./billingTypes";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const noop = () => {};
const baseOverage: OverageCardViewProps = {
  enabled: false,
  capBrl: null,
  unitBrlCents: 49,
  eligibility: { canEnable: true, reason: null },
  canManage: true,
  capInput: "",
  capError: null,
  capDirty: false,
  saving: false,
  confirmOpen: false,
  confirmTitle: "Ligar o excedente?",
  confirmText: "",
  parsedCapBrl: null,
  onCapInputChange: noop,
  onToggle: noop,
  onSaveCap: noop,
  onConfirm: noop,
  onCancelConfirm: noop,
};

const ent = (over: Partial<Entitlements>): Entitlements =>
  ({
    mode: "active",
    planId: "profissional",
    planLabel: "Profissional",
    readOnly: false,
    limits: null,
    overage: { enabled: false, capBrl: null },
    ...over,
  }) as Entitlements;

const summary: UsageSummary = {
  month: "2026-11",
  periodStart: 0,
  periodEnd: 0,
  mode: "active",
  planId: "profissional",
  attendances: { total: 850, included: 850, credit: 0, overage: 0, suggestOnly: 3, overageBrlCents: 0, limit: 1000 },
  campaignSends: { used: 1200, limit: 5000 },
  credits: [{ granted: 1000, consumed: 400, remaining: 600, expiresAt: NOW + 10 * DAY, source: "pack" }],
  packBalance: 600,
  overage: { enabled: false, capBrl: null, unitBrlCents: 49 },
  byo: false,
  costUsdMicros: 0,
  byKind: {},
  estimate: { planBrl: 497, extraChannelsBrl: 79, groupsAddonBrl: 0, listBrl: 576, recurringBrl: 576, overageBrl: 0, totalBrl: 576 },
};
const channelUsage: ChannelAndGroupUsage = {
  channels: { active: 2, limit: 3, truncated: false },
  aiGroups: { used: 1, limit: 10, truncated: false },
};

function renderView(over: Partial<BillingPanelViewProps>) {
  const props: BillingPanelViewProps = {
    canView: true,
    entitlements: ent({}),
    summary,
    channelUsage,
    history: [],
    now: NOW,
    changePlanHref: "mailto:contato@hnbcrm.com",
    overage: baseOverage,
    statement: <div>extrato</div>,
    ...over,
  };
  return render(
    <MemoryRouter>
      <BillingPanelView {...props} />
    </MemoryRouter>,
  );
}

describe("BillingPanelView", () => {
  it("carregando: so esqueleto", () => {
    renderView({ entitlements: undefined });
    expect(screen.getByLabelText("Carregando uso e fatura")).toBeTruthy();
  });

  it("sem permissao", () => {
    renderView({ canView: false });
    expect(screen.getByText("Você não tem acesso a esta página")).toBeTruthy();
  });

  it("entitlements null (nao e membro) nao mostra painel", () => {
    renderView({ entitlements: null });
    expect(screen.getByText("Sua conta ainda não tem um plano")).toBeTruthy();
    expect(screen.queryByText("Uso do mês")).toBeNull();
  });

  it("legacy nao mostra nada de plano", () => {
    renderView({ entitlements: ent({ mode: "legacy", planId: null, planLabel: null }) });
    expect(screen.getByText("Sua conta ainda não tem um plano")).toBeTruthy();
    expect(screen.queryByText("Uso do mês")).toBeNull();
  });

  it("plano ativo: medidores, estimativa, creditos e historico vazio", () => {
    renderView({});
    expect(screen.getByText("Profissional")).toBeTruthy();
    const meter = screen.getByRole("meter", { name: /Atendimentos IA/ });
    expect(meter.getAttribute("aria-valuenow")).toBe("850");
    expect(screen.getByText(/85% · Perto do limite/)).toBeTruthy();
    expect(screen.getByText(/Estimativa de fechamento/)).toBeTruthy();
    expect(screen.getByText(/O ciclo fecha às 21h do último dia/)).toBeTruthy();
    expect(screen.getByText("Total estimado")).toBeTruthy();
    expect(screen.getByText(/Saldo:/)).toBeTruthy();
    expect(screen.getByText("Vence em breve")).toBeTruthy();
    expect(screen.getByText("O histórico aparece depois do primeiro mês completo.")).toBeTruthy();
    expect(screen.getByText("extrato")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Falar com a gente/ }) ?? screen.getByText("Falar com a gente")).toBeTruthy();
  });

  it("teste: dias restantes calculados no front e sem fatura", () => {
    renderView({
      entitlements: ent({ mode: "trial", trialEndsAt: NOW + 12 * DAY - 1000 }),
      summary: { ...summary, mode: "trial", estimate: null },
    });
    expect(screen.getByText("Faltam 12 dias do teste grátis.")).toBeTruthy();
    expect(screen.getByText("Durante o teste grátis não há fatura.")).toBeTruthy();
  });

  it("past_due e read_only mostram aviso", () => {
    const { unmount } = renderView({ entitlements: ent({ mode: "past_due" }) });
    expect(screen.getByText(/pagamento pendente/)).toBeTruthy();
    unmount();
    renderView({ entitlements: ent({ mode: "read_only", readOnly: true }) });
    expect(screen.getByText(/em só leitura/)).toBeTruthy();
  });

  it("priceLock aparece no plano", () => {
    renderView({
      entitlements: ent({ pricing: { listMonthlyBrl: 497, priceLock: { kind: "founder", discountPct: 30 } } }),
    });
    expect(screen.getByText("Preço de fundador: 30% de desconto")).toBeTruthy();
  });
});

describe("OverageCardView", () => {
  it("teste grátis: recusado com o motivo e switch desabilitado", () => {
    render(
      <OverageCardView
        {...baseOverage}
        eligibility={{ canEnable: false, reason: "O excedente fica disponível depois que você contrata um plano." }}
      />,
    );
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/depois que você contrata um plano/)).toBeTruthy();
  });

  it("sem settings:manage: desabilitado e pede administrador", () => {
    render(<OverageCardView {...baseOverage} canManage={false} />);
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Peça a um administrador/)).toBeTruthy();
  });

  it("ligar chama onToggle; aceite mostra o texto e confirma", () => {
    const onToggle = vi.fn();
    const onConfirm = vi.fn();
    render(
      <OverageCardView
        {...baseOverage}
        onToggle={onToggle}
        onConfirm={onConfirm}
        confirmOpen
        confirmText="Você será cobrado R$ 0,49 por atendimento IA além da franquia do plano, até o teto de R$ 250 por mês."
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(true);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/R\$ 0,49 por atendimento IA além da franquia/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Aceitar e salvar" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("erro do teto e cobertura do teto", () => {
    const { unmount } = render(<OverageCardView {...baseOverage} capInput="x" capError="Informe o teto em reais, por exemplo 250." />);
    expect(screen.getByText("Informe o teto em reais, por exemplo 250.")).toBeTruthy();
    unmount();
    render(<OverageCardView {...baseOverage} capInput="250" parsedCapBrl={250} />);
    expect(screen.getByText(/vão até 510 atendimentos a mais/)).toBeTruthy();
  });
});

describe("AttendancesStatementView", () => {
  it("lista, rotulos e carregar mais", () => {
    const onLoadMore = vi.fn();
    render(
      <AttendancesStatementView
        month="2026-11"
        status="CanLoadMore"
        onLoadMore={onLoadMore}
        rows={[
          { id: "1", contactLabel: "Ana Souza", billing: "overage", firstAt: NOW, unitPriceBrlCents: 49 },
          { id: "2", contactLabel: "AS", billing: "suggest_only", firstAt: NOW, unitPriceBrlCents: null },
        ]}
      />,
    );
    expect(screen.getByText("Excedente")).toBeTruthy();
    expect(screen.getByText("Só sugestão")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("vazio", () => {
    render(<AttendancesStatementView month="2026-11" status="Exhausted" rows={[]} onLoadMore={noop} />);
    expect(screen.getByText(/Nenhum atendimento IA em/)).toBeTruthy();
  });
});
