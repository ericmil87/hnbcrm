import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageAttachments } from "./MessageAttachments";
import type { InboxAttachmentFile } from "./types";

const file = (over: Partial<InboxAttachmentFile> = {}): InboxAttachmentFile => ({
  _id: "f1",
  name: "foto.jpg",
  mimeType: "image/jpeg",
  size: 1000,
  url: "https://example.test/foto.jpg",
  ...over,
});

describe("MessageAttachments — espaço reservado da imagem", () => {
  it("com dimensões: a caixa final vale antes de a imagem carregar", () => {
    render(<MessageAttachments files={[file({ width: 1080, height: 1920 })]} variant="inbound" />);
    const img = screen.getByAltText("foto.jpg") as HTMLImageElement;
    expect(img.getAttribute("width")).toBe("135");
    expect(img.getAttribute("height")).toBe("240");
    expect(img.style.width).toBe("135px");
    expect(img.style.aspectRatio).toBe("135 / 240");
    expect(img.className).toContain("object-cover");
    expect(img.className).not.toContain("max-h-[240px]");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("sem dimensões (mensagem antiga): exatamente o CSS de antes", () => {
    render(<MessageAttachments files={[file()]} variant="inbound" />);
    const img = screen.getByAltText("foto.jpg") as HTMLImageElement;
    expect(img.className).toBe("max-w-[240px] max-h-[240px] object-cover rounded-lg");
    expect(img.hasAttribute("width")).toBe(false);
    expect(img.hasAttribute("height")).toBe(false);
    expect(img.getAttribute("style")).toBeNull();
  });

  it("figurinha: 128 no maior lado, sem recorte; sem dimensões fica como antes", () => {
    const { rerender } = render(
      <MessageAttachments
        files={[file({ mimeType: "image/webp", width: 512, height: 256 })]}
        variant="inbound"
        sticker
      />
    );
    let img = screen.getByAltText("Figurinha") as HTMLImageElement;
    expect(img.getAttribute("width")).toBe("128");
    expect(img.getAttribute("height")).toBe("64");
    expect(img.style.aspectRatio).toBe("128 / 64");
    expect(img.className).toContain("object-contain");

    rerender(<MessageAttachments files={[file({ mimeType: "image/webp" })]} variant="inbound" sticker />);
    img = screen.getByAltText("Figurinha") as HTMLImageElement;
    expect(img.className).toBe("max-w-[128px] max-h-[128px] object-contain");
    expect(img.hasAttribute("width")).toBe(false);
  });

  it("álbum: cada imagem reserva a própria caixa", () => {
    render(
      <MessageAttachments
        files={[
          file({ _id: "a", name: "a.jpg", width: 1280, height: 720 }),
          file({ _id: "b", name: "b.jpg" }),
          file({ _id: "c", name: "c.png", mimeType: "image/png", width: 100, height: 100 }),
        ]}
        variant="outbound"
      />
    );
    expect(screen.getByAltText("a.jpg").getAttribute("height")).toBe("135");
    expect(screen.getByAltText("b.jpg").hasAttribute("height")).toBe(false);
    expect(screen.getByAltText("c.png").getAttribute("width")).toBe("100");
  });
});
