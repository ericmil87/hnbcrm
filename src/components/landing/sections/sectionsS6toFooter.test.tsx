import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { rawColorHits } from "@/test/rawColorDom";
import { applyTheme } from "@/lib/themeDom";
import { LEGAL_ENTITY } from "@/lib/legalEntity";
import { UI_THEMES } from "../../../../convex/lib/uiTheme";
import { PLANS, SERVICES } from "../../../../convex/lib/plans";
import { S6PriceSummary } from "./S6PriceSummary";
import { S7Services } from "./S7Services";
import { S7bSocialProof } from "./S7bSocialProof";
import { S8Community } from "./S8Community";
import { S9Faq, landingFaq } from "./S9Faq";
import { FinalCta } from "./FinalCta";
import { LandingFooter } from "./Footer";
import { SOCIAL_PROOF } from "../socialProof";

const GROUP = "https://chat.whatsapp.com/grupo-de-teste";

afterEach(() => {
  applyTheme("whatsapp");
  vi.unstubAllEnvs();
});

const all = () => (
  <>
    <S6PriceSummary />
    <S7Services />
    <S7bSocialProof prod={false} />
    <S8Community />
    <S9Faq />
    <FinalCta />
    <LandingFooter version="1.2.3" />
  </>
);

describe("seções S6 a rodapé nos 4 temas", () => {
  for (const theme of UI_THEMES) {
    it(`${theme}: sem cor crua`, () => {
      vi.stubEnv("VITE_COMMUNITY_URL", GROUP);
      applyTheme(theme);
      const { container } = renderWithRouter(all());
      expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
      expect(container.querySelector("#precos")).not.toBeNull();
      expect(rawColorHits(container)).toEqual([]);
    });
  }
});

describe("S6", () => {
  it("quatro cartões com preço do catálogo, calculadora compacta e link para /precos", () => {
    const { container } = renderWithRouter(<S6PriceSummary />);
    expect(container.querySelectorAll("[data-plan]")).toHaveLength(4);
    const ess = container.querySelector('[data-plan="essencial"]') as HTMLElement;
    expect(within(ess).getByText(`R$ ${PLANS.essencial.monthlyBrl}`, { exact: false })).toBeTruthy();
    expect(within(ess).getByText("1 número de WhatsApp")).toBeTruthy();
    const emp = container.querySelector('[data-plan="empresa"]') as HTMLElement;
    expect(within(emp).getByText(/R\$\s*1\.490/)).toBeTruthy();
    expect(within(emp).getByText(/R\$\s*390 por unidade/)).toBeTruthy();
    expect(screen.getByText("Mais escolhido")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Ver tabela completa" })[0].getAttribute("href")).toBe("/precos");
    expect(screen.getByText("Em quantos números de WhatsApp?")).toBeTruthy();
    expect(screen.queryByText("Precisa de algum destes?")).toBeNull();
  });
});

describe("S7", () => {
  it("valores de implantação e acompanhamento vêm do catálogo; consultoria é sob orçamento", () => {
    const { container } = renderWithRouter(<S7Services />);
    const get = (k: string) => container.querySelector(`[data-service="${k}"]`) as HTMLElement;
    expect(within(get("express")).getByText(/R\$\s*1\.490/)).toBeTruthy();
    expect(within(get("completa")).getByText(/R\$\s*3\.900/)).toBeTruthy();
    expect(within(get("empresa")).getByText(/R\$\s*6\.900/)).toBeTruthy();
    expect(within(get("empresa")).getByText(/R\$\s*2\.400 por unidade adicional/)).toBeTruthy();
    expect(screen.getByText(/R\$\s*390\/mês, com 2 horas/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`até ${SERVICES.installments} vezes`))).toBeTruthy();
    const custom = get("consultoria");
    expect(within(custom).getByText("Consultoria sob medida")).toBeTruthy();
    expect(within(custom).getByText("Sob orçamento")).toBeTruthy();
    expect(custom.textContent).not.toMatch(/R\$/);
    expect(within(custom).getByRole("button", { name: "Pedir orçamento" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Falar com a gente" })).toBeTruthy();
  });
});

describe("S7b", () => {
  it("em produção: só cenas com selo e números; sem depoimento nem logo", () => {
    const { container } = render(<S7bSocialProof prod />);
    expect(screen.getByRole("heading", { level: 2, name: "Como é usar no dia a dia" })).toBeTruthy();
    expect(screen.getAllByText("Exemplo ilustrativo")).toHaveLength(3);
    expect(screen.queryByText("Nome de exemplo")).toBeNull();
    expect(screen.queryByText("Marca de exemplo")).toBeNull();
    expect(screen.queryByText("Quem usa")).toBeNull();
    expect(container.textContent).toContain("Milhares");
  });

  it("em desenvolvimento: mostra os exemplos de depoimento e logo, todos com selo", () => {
    render(<S7bSocialProof prod={false} />);
    expect(screen.getAllByText("Nome de exemplo")).toHaveLength(3);
    expect(screen.getByText("Marca de exemplo")).toBeTruthy();
    expect(screen.getAllByText("Exemplo ilustrativo")).toHaveLength(3 + 3 + 1);
  });

  it("depoimento real aparece em produção sem selo", () => {
    render(
      <S7bSocialProof
        prod
        items={[
          ...SOCIAL_PROOF,
          { kind: "depoimento", id: "r", real: true, quote: "Atende bem.", name: "Fulana", business: "Clínica" },
        ]}
      />,
    );
    expect(screen.getByText("Atende bem.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "O que dizem quem já usa" })).toBeTruthy();
    expect(screen.getAllByText("Exemplo ilustrativo")).toHaveLength(3);
  });
});

describe("S8", () => {
  it("some sem a env", () => {
    vi.stubEnv("VITE_COMMUNITY_URL", "");
    const { container } = render(<S8Community />);
    expect(container.innerHTML).toBe("");
  });

  it("some com env inválida (http, texto solto)", () => {
    for (const bad of ["http://chat.whatsapp.com/x", "grupo", "javascript:alert(1)"]) {
      vi.stubEnv("VITE_COMMUNITY_URL", bad);
      const { container, unmount } = render(<S8Community />);
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });

  it("com env válida mostra o botão, as três linhas e não a linha da IA", () => {
    vi.stubEnv("VITE_COMMUNITY_URL", GROUP);
    render(<S8Community />);
    const a = screen.getByRole("link", { name: "Entrar no grupo do WhatsApp" });
    expect(a.getAttribute("href")).toBe(GROUP);
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("Regras simples, fixadas na descrição")).toBeTruthy();
    expect(screen.queryByText(/Tem IA no grupo/)).toBeNull();
  });

  it("no computador mostra o QR code em SVG", async () => {
    vi.stubEnv("VITE_COMMUNITY_URL", GROUP);
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(<S8Community />);
      const qr = await screen.findByRole("img", { name: "QR code do grupo do WhatsApp" });
      expect(qr.tagName.toLowerCase()).toBe("svg");
      expect(screen.getByText("Aponte a câmera do celular para entrar.")).toBeTruthy();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("S9", () => {
  it("cinco perguntas em acordeão com aria-expanded", () => {
    renderWithRouter(<S9Faq />);
    const faq = landingFaq();
    expect(faq).toHaveLength(5);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(5);
    for (const b of buttons) expect(b.getAttribute("aria-expanded")).toBe("false");
    const first = buttons[0];
    const panel = document.getElementById(first.getAttribute("aria-controls") ?? "") as HTMLElement;
    expect(panel.hidden).toBe(true);
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("conta 1");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("link", { name: "Mais perguntas sobre preço" }).getAttribute("href")).toBe(
      "/precos#perguntas",
    );
  });
});

describe("CTA final e rodapé", () => {
  it("CTA final traz o composer do hero e a linha de confiança", () => {
    renderWithRouter(<FinalCta />);
    expect(screen.getByRole("textbox", { name: "Mensagem para o Copiloto" })).toBeTruthy();
    expect(screen.getByText(/dias grátis · sem cartão · reembolso em/)).toBeTruthy();
  });

  it("rodapé: identificação legal, linha de desenvolvedores, versão e links", () => {
    vi.stubEnv("VITE_COMMUNITY_URL", "");
    renderWithRouter(<LandingFooter version="1.2.3" />);
    const text = document.body.textContent ?? "";
    expect(text).toContain(`Vendido por ${LEGAL_ENTITY.name}`);
    expect(text).toContain(LEGAL_ENTITY.document);
    expect(text).toContain(LEGAL_ENTITY.email);
    expect(screen.getByRole("link", { name: "Ver a documentação" }).getAttribute("href")).toBe("/developers");
    expect(screen.getByRole("link", { name: "Versão 1.2.3" }).getAttribute("href")).toContain("CHANGELOG");
    expect(screen.getByRole("link", { name: "Termos" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacidade" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Comunidade" })).toBeNull();
  });

  it("rodapé mostra Comunidade com a env válida e omite a versão quando não há", () => {
    vi.stubEnv("VITE_COMMUNITY_URL", GROUP);
    renderWithRouter(<LandingFooter version={null} />);
    expect(screen.getByRole("link", { name: "Comunidade" })).toBeTruthy();
    expect(screen.queryByText(/^Versão/)).toBeNull();
  });
});
