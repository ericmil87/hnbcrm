import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regressão do cabeçalho empilhado (Conversas, nov/2026): no painel da conversa o cabeçalho e o
 * composer são irmãos com `key` pelo id da conversa. Com a MESMA chave nos dois, o React perde o
 * rastro do cabeçalho antigo a cada troca e eles se acumulam acima da thread. A forma do JSX
 * abaixo espelha o `Inbox.tsx` (cabeçalho condicional, thread sem key, composer); o guarda
 * estático `src/lib/siblingKeysGuard.test.ts` impede que a forma errada volte ao código.
 */
function Header({ id }: { id: string }) {
  return <div data-testid="header">{id}</div>;
}
function Thread({ id }: { id: string }) {
  return <div data-testid="thread">{id}</div>;
}
function Composer({ id }: { id: string }) {
  return <div data-testid="composer">{id}</div>;
}

function Pane({ id, namespaced }: { id: string; namespaced: boolean }) {
  return (
    <div>
      {id ? <Header key={namespaced ? `header:${id}` : id} id={id} /> : <div />}
      <Thread id={id} />
      <Composer key={namespaced ? `composer:${id}` : id} id={id} />
    </div>
  );
}

function switchThrough(namespaced: boolean) {
  const { rerender } = render(<Pane id="a" namespaced={namespaced} />);
  rerender(<Pane id="b" namespaced={namespaced} />);
  rerender(<Pane id="c" namespaced={namespaced} />);
}

describe("painel da conversa: chaves dos irmãos", () => {
  afterEach(() => vi.restoreAllMocks());

  it("com a mesma chave no cabeçalho e no composer, os cabeçalhos antigos ficam empilhados", () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // aviso de chave duplicada do React
    switchThrough(false);
    expect(screen.getAllByTestId("header").length).toBeGreaterThan(1);
  });

  it("com chaves com prefixo próprio, só o cabeçalho da conversa aberta fica no documento", () => {
    switchThrough(true);
    expect(screen.getAllByTestId("header").map((h) => h.textContent)).toEqual(["c"]);
    expect(screen.getAllByTestId("composer").map((c) => c.textContent)).toEqual(["c"]);
    expect(screen.getAllByTestId("thread")).toHaveLength(1);
  });
});
