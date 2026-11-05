import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { pageDocumentTitle, usePageTitle } from "./usePageTitle";

function Page({ title }: { title: string | null }) {
  usePageTitle(title);
  return null;
}

describe("usePageTitle", () => {
  it("define o título da aba e restaura ao desmontar", () => {
    document.title = "HNBCRM";
    const { unmount } = render(<Page title="Conversas" />);
    expect(document.title).toBe("Conversas · HNBCRM");
    unmount();
    expect(document.title).toBe("HNBCRM");
  });

  it("acompanha mudança de título", () => {
    document.title = "HNBCRM";
    const { rerender } = render(<Page title="Painel" />);
    rerender(<Page title="Agenda" />);
    expect(document.title).toBe("Agenda · HNBCRM");
  });

  it("null não mexe no título; a página filha vence (efeito do filho roda antes do pai)", () => {
    document.title = "HNBCRM";
    function Parent({ own }: { own: boolean }) {
      usePageTitle(own ? null : "Painel");
      return <Page title="Configurações · Aparência" />;
    }
    const { rerender } = render(<Parent own />);
    expect(document.title).toBe("Configurações · Aparência · HNBCRM");
    rerender(<Parent own={false} />);
    expect(document.title).toBe("Painel · HNBCRM");
  });

  it("sem título de página, mostra só o nome do app", () => {
    expect(pageDocumentTitle("HNBCRM")).toBe("HNBCRM");
    expect(pageDocumentTitle("")).toBe("HNBCRM");
  });

  it("formata o título", () => {
    expect(pageDocumentTitle("Equipe")).toBe("Equipe · HNBCRM");
  });
});
