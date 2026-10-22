import { describe, expect, it } from "vitest";
import { decideSentinel, INITIAL_SENTINEL_STATE, type SentinelState } from "./infiniteScroll";

const open = { enabled: true, loading: false };
const loading = { enabled: true, loading: true };
const off = { enabled: false, loading: false };

function run(
  events: Array<[boolean, { enabled: boolean; loading: boolean }?]>,
  start: SentinelState = INITIAL_SENTINEL_STATE
) {
  let state = start;
  const fires: boolean[] = [];
  for (const [visible, gate] of events) {
    const r = decideSentinel(state, visible, gate ?? open);
    state = r.state;
    fires.push(r.fire);
  }
  return fires;
}

describe("decideSentinel", () => {
  it("1ª observação é linha de base: visível no mount não dispara", () => {
    expect(run([[true]])).toEqual([false]);
  });

  it("lista menor que a tela não carrega em cascata", () => {
    expect(run([[true], [true], [true]])).toEqual([false, false, false]);
  });

  it("dispara ao entrar depois de estar fora", () => {
    expect(run([[false], [true]])).toEqual([false, true]);
  });

  it("não re-dispara enquanto continua visível", () => {
    expect(run([[false], [true], [true]])).toEqual([false, true, false]);
  });

  it("dispara de novo só depois de sair e voltar", () => {
    expect(run([[false], [true], [false], [true]])).toEqual([false, true, false, true]);
  });

  it("não dispara enquanto carrega, e a entrada é consumida", () => {
    expect(run([[false], [true, loading], [true]])).toEqual([false, false, false]);
  });

  it("não dispara desabilitado (teto ou sem mais itens)", () => {
    expect(run([[false], [true, off]])).toEqual([false, false]);
  });

  it("depois do lote (conteúdo cresceu, sentinela saiu) volta a disparar ao rolar", () => {
    expect(run([[false], [true], [false, loading], [false], [true]])).toEqual([
      false,
      true,
      false,
      false,
      true,
    ]);
  });
});
