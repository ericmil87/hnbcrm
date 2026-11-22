import { describe, expect, it } from "vitest";
import { isTypingTarget, shortcutBlocked } from "./agendaShortcuts";

const ev = (target: EventTarget | null, over: Partial<KeyboardEvent> = {}) => ({ defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, target, ...over });

describe("atalhos da Agenda", () => {
  it("seta dentro do seletor de visão ou de agrupamento (radiogroup) é do seletor, não da página", () => {
    document.body.innerHTML = '<div role="radiogroup"><button id="r" role="radio">Dia</button></div><div role="tablist"><button id="t"></button></div><div role="listbox"><div id="l"></div></div><button id="plain"></button>';
    for (const id of ["r", "t", "l"]) expect(isTypingTarget(document.getElementById(id))).toBe(true);
    expect(isTypingTarget(document.getElementById("plain"))).toBe(false);
  });
  it("campo de texto, menu e diálogo também seguram a tecla", () => {
    document.body.innerHTML = '<input id="i"/><div role="menu"><button id="m"></button></div><div role="dialog"><button id="d"></button></div>';
    for (const id of ["i", "m", "d"]) expect(isTypingTarget(document.getElementById(id))).toBe(true);
  });
  it("tecla já tratada (preventDefault), modificadores e camada aberta bloqueiam", () => {
    document.body.innerHTML = '<button id="b"></button>';
    const b = document.getElementById("b");
    expect(shortcutBlocked(ev(b), false)).toBe(false);
    expect(shortcutBlocked(ev(b, { defaultPrevented: true }), false)).toBe(true);
    expect(shortcutBlocked(ev(b, { ctrlKey: true }), false)).toBe(true);
    expect(shortcutBlocked(ev(b), true)).toBe(true);
  });
});
