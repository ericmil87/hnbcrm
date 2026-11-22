import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";
import { SlideOver } from "./SlideOver";
import { layerDepth } from "@/lib/layerStack";

function Nested() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button onClick={() => setInner(true)}>Abrir de dentro</button>
      <SlideOver open={outer} onClose={() => setOuter(false)} title="Painel">
        <p>conteúdo do painel</p>
        <Modal open={inner} onClose={() => setInner(false)} title="Folha">
          <p>conteúdo da folha</p>
        </Modal>
      </SlideOver>
    </>
  );
}

describe("Esc com camadas (pilha)", () => {
  it("uma camada só: Esc fecha, como antes", async () => {
    function One() {
      const [open, setOpen] = useState(true);
      return <Modal open={open} onClose={() => setOpen(false)} title="Única">x</Modal>;
    }
    render(<One />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(layerDepth()).toBe(0);
  });

  it("duas aninhadas: Esc fecha só a de cima; o segundo Esc fecha a de baixo", async () => {
    render(<Nested />);
    await userEvent.click(screen.getByRole("button", { name: "Abrir de dentro" }));
    expect(screen.getByText("conteúdo da folha")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("conteúdo da folha")).toBeNull();
    expect(screen.getByText("conteúdo do painel")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("conteúdo do painel")).toBeNull();
    expect(layerDepth()).toBe(0);
  });

  it("três camadas fecham uma por vez na ordem inversa da abertura", async () => {
    function Three() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(false);
      const [c, setC] = useState(false);
      return (
        <>
          <button onClick={() => setB(true)}>abrir B</button>
          <button onClick={() => setC(true)}>abrir C</button>
          <Modal open={a} onClose={() => setA(false)} title="A">camada-a</Modal>
          <Modal open={b} onClose={() => setB(false)} title="B">camada-b</Modal>
          <Modal open={c} onClose={() => setC(false)} title="C">camada-c</Modal>
        </>
      );
    }
    render(<Three />);
    await userEvent.click(screen.getByRole("button", { name: "abrir B", hidden: true }));
    await userEvent.click(screen.getByRole("button", { name: "abrir C", hidden: true }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("camada-c")).toBeNull();
    expect(screen.getByText("camada-b")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("camada-b")).toBeNull();
    expect(screen.getByText("camada-a")).toBeInTheDocument();
  });

  it("camada desmontada sem fechar libera a pilha: a de baixo volta a reagir ao Esc", async () => {
    function Unmounting() {
      const [show, setShow] = useState(true);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setShow(false)}>desmontar</button>
          <Modal open={open} onClose={() => setOpen(false)} title="Base">camada-base</Modal>
          {show && <Modal open onClose={() => setShow(false)} title="Topo">camada-topo</Modal>}
        </>
      );
    }
    render(<Unmounting />);
    await userEvent.click(screen.getByRole("button", { name: "desmontar", hidden: true }));
    expect(screen.queryByText("camada-topo")).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("camada-base")).toBeNull();
    expect(layerDepth()).toBe(0);
  });

  it("re-render da camada de baixo não a põe no topo", async () => {
    function Rerender() {
      const [n, setN] = useState(0);
      const [inner, setInner] = useState(true);
      return (
        <>
          <button onClick={() => setN((x) => x + 1)}>render {n}</button>
          <SlideOver open onClose={() => undefined} title="Painel">
            <Modal open={inner} onClose={() => setInner(false)} title="Folha">camada-folha</Modal>
          </SlideOver>
        </>
      );
    }
    render(<Rerender />);
    await userEvent.click(screen.getByRole("button", { name: /render/, hidden: true }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("camada-folha")).toBeNull();
  });
});
