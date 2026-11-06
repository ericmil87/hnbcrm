import { beforeEach, describe, expect, it } from "vitest";
import { lockBodyScroll, lockDocumentScroll } from "./scrollLock";

describe("lockBodyScroll", () => {
  it("só restaura quando a última camada libera, em qualquer ordem", () => {
    document.body.style.overflow = "";
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");
    a();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
  });

  it("liberar duas vezes não desbalanceia o contador", () => {
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    a();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("lockDocumentScroll", () => {
  const html = () => document.documentElement.style;
  const body = () => document.body.style;
  beforeEach(() => {
    html().overflow = "";
    html().overscrollBehavior = "";
    body().overflow = "";
    body().overscrollBehavior = "";
  });

  it("trava html e body (overflow + overscroll) e restaura ao liberar", () => {
    html().overflow = "auto";
    const unlock = lockDocumentScroll();
    expect(html().overflow).toBe("hidden");
    expect(html().overscrollBehavior).toBe("none");
    expect(body().overflow).toBe("hidden");
    expect(body().overscrollBehavior).toBe("none");
    unlock();
    unlock();
    expect(html().overflow).toBe("auto");
    expect(html().overscrollBehavior).toBe("");
    expect(body().overflow).toBe("");
    expect(body().overscrollBehavior).toBe("");
  });

  it("SlideOver aberto antes do modo conversa e fechado durante: nada fica preso", () => {
    const slideOver = lockBodyScroll();
    const chat = lockDocumentScroll();
    slideOver();
    expect(body().overflow).toBe("hidden");
    chat();
    expect(body().overflow).toBe("");
    expect(html().overflow).toBe("");
  });

  it("Modal por cima do modo conversa: fechar o Modal mantém a trava; sair da conversa libera", () => {
    const chat = lockDocumentScroll();
    const modal = lockBodyScroll();
    modal();
    expect(body().overflow).toBe("hidden");
    expect(html().overflow).toBe("hidden");
    chat();
    expect(body().overflow).toBe("");
  });

  it("modo conversa sai antes do Modal: body continua travado até o Modal fechar", () => {
    const chat = lockDocumentScroll();
    const modal = lockBodyScroll();
    chat();
    expect(body().overflow).toBe("hidden");
    expect(html().overflow).toBe("");
    expect(body().overscrollBehavior).toBe("");
    modal();
    expect(body().overflow).toBe("");
  });
});
