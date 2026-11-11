import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { mockReducedMotion } from "@/test/reducedMotion";
import { Composer, type ComposerProps } from "./Composer";

const PLACEHOLDERS = ["Tenho uma clínica de estética em Recife…", "instagram.com/minhaloja"];

function Harness(props: Partial<ComposerProps> & { onSubmit: (t: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <Composer
      value={value}
      onChange={setValue}
      placeholder="Conte sobre o seu negócio"
      placeholders={PLACEHOLDERS}
      label="Mensagem para o Copiloto"
      attachLabel="Anexar arquivo (site, PDF ou imagem)"
      {...props}
    />
  );
}

function field() {
  return screen.getByRole("textbox", { name: "Mensagem para o Copiloto" });
}

function overlay(container: HTMLElement) {
  return container.querySelector("[data-animated]");
}

describe("Composer", () => {
  it("botões de anexo e microfone têm nome acessível e 44 px", () => {
    render(<Harness onSubmit={vi.fn()} />);
    const attach = screen.getByRole("button", { name: "Anexar arquivo (site, PDF ou imagem)" });
    const mic = screen.getByRole("button", { name: "Gravar áudio" });
    expect(attach.className).toContain("size-11");
    expect(mic.className).toContain("size-11");
    expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull();
  });

  it("envia o texto sem espaços nas pontas pelo botão Enviar", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(field(), { target: { value: "  Tenho uma loja  " } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onSubmit).toHaveBeenCalledWith("Tenho uma loja");
  });

  it("Enter envia no computador e Shift+Enter não", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(field(), { target: { value: "Oi" } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("Oi");
  });

  it("não envia campo vazio ou só com espaços", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("chama os handlers de anexo e microfone", () => {
    const onAttach = vi.fn();
    const onMic = vi.fn();
    render(<Harness onSubmit={vi.fn()} onAttach={onAttach} onMic={onMic} />);
    fireEvent.click(screen.getByRole("button", { name: "Anexar arquivo (site, PDF ou imagem)" }));
    fireEvent.click(screen.getByRole("button", { name: "Gravar áudio" }));
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onMic).toHaveBeenCalledTimes(1);
  });

  it("placeholder animado para no foco e ao digitar; o estático fica no campo", () => {
    const { container } = render(<Harness onSubmit={vi.fn()} hint="Fica só no seu navegador." />);
    expect(field()).toHaveAttribute("placeholder", "Conte sobre o seu negócio");
    expect(overlay(container)).toHaveAttribute("aria-hidden", "true");
    fireEvent.focus(field());
    expect(overlay(container)).toBeNull();
    expect(screen.getByText("Fica só no seu navegador.")).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-describedby");
    fireEvent.blur(field());
    expect(overlay(container)).not.toBeNull();
    fireEvent.change(field(), { target: { value: "a" } });
    expect(overlay(container)).toBeNull();
  });

  it("com movimento reduzido não anima: só o placeholder estático", () => {
    const restore = mockReducedMotion(true);
    try {
      const { container } = render(<Harness onSubmit={vi.fn()} />);
      expect(overlay(container)).toBeNull();
      expect(field()).toHaveAttribute("placeholder", "Conte sobre o seu negócio");
      expect(container.querySelector(".motion-safe\\:animate-ring-pulse")).toBeNull();
    } finally {
      restore();
    }
  });
});
