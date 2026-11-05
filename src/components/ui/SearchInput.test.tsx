import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emite o valor só depois do debounce", () => {
    const onValueChange = vi.fn();
    render(<SearchInput value="" onValueChange={onValueChange} placeholder="Buscar leads" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ana" } });
    act(() => void vi.advanceTimersByTime(299));
    expect(onValueChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onValueChange).toHaveBeenCalledWith("ana");
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("limpar zera na hora e chama onClear", () => {
    const onValueChange = vi.fn();
    const onClear = vi.fn();
    render(<SearchInput value="" onValueChange={onValueChange} onClear={onClear} />);
    expect(screen.queryByLabelText("Limpar busca")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "x" } });
    fireEvent.click(screen.getByLabelText("Limpar busca"));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(onClear).toHaveBeenCalled();
    expect(onValueChange).toHaveBeenCalledWith("");
    expect(screen.queryByLabelText("Limpar busca")).toBeNull();
  });

  it("sincroniza quando o valor externo muda", () => {
    function Harness() {
      const [v, setV] = useState("a");
      return (
        <>
          <SearchInput value={v} onValueChange={setV} />
          <button onClick={() => setV("zzz")}>externo</button>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByText("externo"));
    expect(screen.getByRole("searchbox")).toHaveValue("zzz");
  });

  it("limpar devolve o foco ao campo", () => {
    render(<SearchInput value="" onValueChange={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "x" } });
    fireEvent.click(screen.getByLabelText("Limpar busca"));
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });
});
