import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiInstructionPopover } from "./AiDraftCard";

function Harness({ onSubmit = vi.fn() }: { onSubmit?: (i?: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div className="overflow-hidden">
      <button ref={ref} type="button" onClick={() => setOpen((v) => !v)}>
        Devolver à IA
      </button>
      <AiInstructionPopover
        open={open}
        anchor={ref}
        title="Devolver a conversa à IA"
        placeholder="Instrução para a IA (opcional)"
        submitLabel="Devolver"
        onSubmit={onSubmit}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

describe("AiInstructionPopover", () => {
  it("abre em portal no body com campo, Cancelar e Devolver", async () => {
    const { container } = render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Devolver à IA" }));
    const dialog = screen.getByRole("dialog", { name: "Devolver a conversa à IA" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(screen.getByPlaceholderText("Instrução para a IA (opcional)")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Devolver" })).toBeInTheDocument();
  });

  it("Cancelar fecha sem enviar", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Devolver à IA" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Devolver envia a instrução aparada; vazio envia undefined", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Devolver à IA" }));
    await userEvent.type(screen.getByPlaceholderText("Instrução para a IA (opcional)"), "  o Pix é X  ");
    await userEvent.click(screen.getByRole("button", { name: "Devolver" }));
    expect(onSubmit).toHaveBeenCalledWith("o Pix é X");

    await userEvent.clear(screen.getByPlaceholderText("Instrução para a IA (opcional)"));
    await userEvent.click(screen.getByRole("button", { name: "Devolver" }));
    expect(onSubmit).toHaveBeenLastCalledWith(undefined);
  });

  it("Esc fecha", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Devolver à IA" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
