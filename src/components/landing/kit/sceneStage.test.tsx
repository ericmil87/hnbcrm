import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AudioBubble } from "./AudioBubble";
import { Bubble } from "./Bubble";
import { ChatFeed } from "./ChatFeed";
import { FunnelRail } from "./FunnelRail";
import { PhoneFrame } from "./PhoneFrame";
import { PhoneNotification } from "./PhoneNotification";
import { SceneLoop } from "./SceneLoop";
import { SceneSteps } from "./SceneSteps";
import { TypingDots } from "./TypingDots";

const STAGES = [
  { id: "novo", title: "Novo" },
  { id: "interessado", title: "Interessado" },
  { id: "agendado", title: "Agendado" },
];

describe("ChatFeed", () => {
  it("ancora as bolhas embaixo de uma área que não cresce", () => {
    const { container, rerender } = render(
      <ChatFeed>
        <Bubble variant="in">primeira</Bubble>
      </ChatFeed>
    );
    const feed = container.querySelector("[data-chat-feed]")!;
    expect(feed).toHaveClass("overflow-hidden", "flex-1", "min-h-0");
    expect(feed.firstElementChild).toHaveClass("absolute", "bottom-0");
    // Bolha nova: a moldura é a mesma (jsdom não tem `Element.animate`; não pode quebrar).
    rerender(
      <ChatFeed>
        <Bubble variant="in">primeira</Bubble>
        <Bubble variant="ai">segunda</Bubble>
      </ChatFeed>
    );
    expect(container.querySelector("[data-chat-feed]")).toBe(feed);
    expect(screen.getByText("segunda")).toBeInTheDocument();
  });

  it("`faded` apaga o conteúdo sem tirar do lugar", () => {
    const { container } = render(
      <ChatFeed faded>
        <Bubble variant="in">oi</Bubble>
      </ChatFeed>
    );
    expect(container.querySelector("[data-chat-feed]")!.firstElementChild).toHaveClass("opacity-0");
  });
});

describe("FunnelRail", () => {
  it("o cartão em destaque muda de etapa só por transform e o contador acompanha", () => {
    const moving = { title: "Marina", subtitle: "limpeza de pele" };
    const { container, rerender } = render(<FunnelRail stages={STAGES} moving={{ ...moving, stageId: "novo" }} orientation="horizontal" />);
    const rail = screen.getByRole("group", { name: "Funil" });
    const card = container.querySelector("[data-rail-card]")!;
    expect(rail.style.getPropertyValue("--rail-i")).toBe("0");
    expect(rail.style.getPropertyValue("--rail-n")).toBe("3");
    expect(card).toHaveClass("absolute", "motion-safe:transition-transform");
    expect(container.querySelector('[data-rail-stage="novo"]')).toHaveTextContent("Novo1");

    rerender(<FunnelRail stages={STAGES} moving={{ ...moving, stageId: "agendado" }} orientation="horizontal" highlight />);
    // Mesmo nó (não remonta): é ele que desliza.
    expect(container.querySelector("[data-rail-card]")).toBe(card);
    expect(rail.style.getPropertyValue("--rail-i")).toBe("2");
    expect(rail).toHaveAttribute("data-stage", "agendado");
    expect(container.querySelector('[data-rail-stage="novo"]')).toHaveTextContent("Novo0");
    expect(container.querySelector('[data-rail-stage="agendado"]')).toHaveTextContent("Agendado1");
    expect(container.querySelector('[data-rail-stage="agendado"] .motion-safe\\:animate-stage-flash')).not.toBeNull();
    expect(container.querySelector('[data-rail-stage="novo"] .motion-safe\\:animate-stage-flash')).toBeNull();
    expect(screen.getByText(", na etapa Agendado")).toHaveClass("sr-only");
  });

  it("`visible: false` esconde o cartão sem contar nem mexer no trilho", () => {
    const { container } = render(
      <FunnelRail
        stages={STAGES}
        cards={[{ id: "paulo", title: "Paulo", stageId: "novo" }]}
        moving={{ title: "Marina", stageId: "novo", visible: false }}
        orientation="vertical"
      />
    );
    expect(container.querySelector("[data-rail-card]")!.querySelector(".opacity-0")).not.toBeNull();
    expect(container.querySelector('[data-rail-stage="novo"]')).toHaveTextContent("Novo01");
    expect(container.querySelectorAll("[data-rail-stage]")).toHaveLength(3);
    expect(screen.getByText("Paulo")).toBeInTheDocument();
  });
});

describe("peças novas e props opcionais do kit", () => {
  it("SceneSteps é decorativo e marca concluído, atual e pendente", () => {
    const { container } = render(
      <SceneSteps
        items={[
          { id: "a", label: "Cliente chama" },
          { id: "b", label: "IA responde" },
          { id: "c", label: "Você entra" },
        ]}
        activeIndex={1}
      />
    );
    const list = container.querySelector("[data-scene-steps]")!;
    expect(list).toHaveAttribute("aria-hidden", "true");
    expect([...list.querySelectorAll("li")].map((li) => li.getAttribute("data-state"))).toEqual(["done", "current", "pending"]);
  });

  it("PhoneFrame mostra o relógio e tem tela que corta o conteúdo", () => {
    render(
      <PhoneFrame time="23:14" label="Seu celular">
        <p>tela</p>
      </PhoneFrame>
    );
    expect(screen.getByRole("group", { name: "Seu celular" })).toHaveTextContent("23:14");
    expect(screen.getByText("tela").parentElement).toHaveClass("relative", "overflow-hidden");
  });

  it("TypingDots: padrão continua à esquerda; `ai` vai para a direita com a cor da IA", () => {
    const { container, rerender } = render(<TypingDots />);
    expect(container.querySelector(".bubble-tail-start.bg-bubble-in")).not.toBeNull();
    rerender(<TypingDots variant="ai" />);
    expect(container.querySelector(".bubble-tail-end.bg-bubble-ai")).not.toBeNull();
    expect(container.firstElementChild).toHaveClass("justify-end");
  });

  it("AudioBubble: parada por padrão; `playing` mexe a onda", () => {
    const { container, rerender } = render(<AudioBubble variant="in" duration="0:14" />);
    expect(container.querySelector(".motion-safe\\:animate-wave-bar")).toBeNull();
    rerender(<AudioBubble variant="in" duration="0:14" playing />);
    expect(container.querySelectorAll(".motion-safe\\:animate-wave-bar").length).toBeGreaterThan(0);
    expect(screen.getByText("Mensagem de voz, 0:14")).toHaveClass("sr-only");
  });

  it("PhoneNotification: `pressed` marca só a ação apertada", () => {
    render(<PhoneNotification title="Assumir?" actions={[{ label: "Depois" }, { label: "Assumir", primary: true, pressed: true }]} />);
    expect(screen.getByText("Assumir")).toHaveClass("scale-95");
    expect(screen.getByText("Depois")).not.toHaveClass("scale-95");
  });

  it("SceneLoop: `header` fica fora do aria-hidden e recebe o botão de pausa", () => {
    render(
      <SceneLoop
        steps={[
          { id: "a", duration: 1000 },
          { id: "b", duration: 1000 },
        ]}
        label="Cena"
        description="Texto alternativo."
        renderControl={false}
        header={(scene) => <div data-testid="cabecalho">{scene.control}</div>}
      >
        {() => <p>cena</p>}
      </SceneLoop>
    );
    const header = screen.getByTestId("cabecalho");
    expect(header.closest("[aria-hidden]")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Pausar cena" }));
    expect(header).toContainElement(screen.getByRole("button", { name: "Retomar cena" }));
  });
});
