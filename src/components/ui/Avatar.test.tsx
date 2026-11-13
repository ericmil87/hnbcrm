import { fireEvent, render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  test("sem imagem mostra as iniciais", () => {
    const { container, getByText } = render(<Avatar name="Daffne Miranda" />);
    expect(getByText("DM")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  test("com imagem mostra a foto, sem referrer e com carga preguiçosa", () => {
    const { container, queryByText } = render(<Avatar name="Daffne Miranda" imageUrl="https://x.convex.cloud/a" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://x.convex.cloud/a");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(queryByText("DM")).toBeNull();
  });

  test("imagem quebrada volta às iniciais; uma URL nova é tentada de novo", () => {
    const { container, getByText, rerender } = render(<Avatar name="Daffne Miranda" imageUrl="https://x.convex.cloud/a" />);
    fireEvent.error(container.querySelector("img")!);
    expect(getByText("DM")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    rerender(<Avatar name="Daffne Miranda" imageUrl="https://x.convex.cloud/b" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("https://x.convex.cloud/b");
  });
});
