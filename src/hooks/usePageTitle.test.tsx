import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { pageDocumentTitle, usePageTitle } from "./usePageTitle";

function Page({ title }: { title: string }) {
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

  it("formata o título", () => {
    expect(pageDocumentTitle("Equipe")).toBe("Equipe · HNBCRM");
  });
});
