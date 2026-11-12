import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  it("icon: one inline SVG named HNBCRM, human on currentColor and AI on the logo-ai token", () => {
    const { container, getByRole } = render(<BrandLogo />);
    const svg = getByRole("img", { name: "HNBCRM" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('path[stroke="currentColor"]')).not.toBeNull();
    expect(container.querySelector("path.fill-logo-ai")).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{6}\b/i); // no raw brand colors (mask fills are white/black only)
  });

  it("wordmark: wider viewBox and the outlined HNBCRM text", () => {
    const { container, getByRole } = render(<BrandLogo variant="wordmark" size="lg" />);
    const svg = getByRole("img", { name: "HNBCRM" });
    expect(svg.getAttribute("viewBox")).toBe("0 0 229 64");
    expect(svg.getAttribute("class")).toContain("h-10");
    expect(container.querySelectorAll("path").length).toBe(4);
  });

  it("responsive: icon below the breakpoint and wordmark from it up", () => {
    const { container } = render(<BrandLogo variant="responsive" breakpoint="lg" />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute("class")).toContain("lg:hidden");
    expect(svgs[1].getAttribute("class")).toContain("hidden lg:block");
  });

  it("decorative: hidden from the accessibility tree (text HNBCRM is next to it)", () => {
    const { container, queryByRole } = render(<BrandLogo decorative />);
    expect(queryByRole("img")).toBeNull();
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("aria-label")).toBeNull();
  });

  it("className wins over the size height and each instance has its own mask id", () => {
    const { container } = render(
      <>
        <BrandLogo className="h-12" />
        <BrandLogo />
      </>,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs[0].getAttribute("class")).toContain("h-12");
    expect(svgs[0].getAttribute("class")).not.toContain("h-8");
    const ids = [...container.querySelectorAll("mask")].map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });
});
