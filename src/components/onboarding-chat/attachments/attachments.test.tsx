import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentSheet } from "./AttachmentSheet";
import type { AttachmentDraft } from "@/lib/onboardingAttachments";
import { VoiceSheet } from "./VoiceSheet";

const ok = async () => ({ ok: true as const });

describe("AttachmentSheet", () => {
  it("link: valida https antes de enviar e envia a URL normalizada", async () => {
    const onSubmit = vi.fn(ok);
    const onClose = vi.fn();
    render(<AttachmentSheet open onClose={onClose} onSubmit={onSubmit} phase={null} />);
    await userEvent.click(screen.getByRole("button", { name: /Link do site ou Instagram/ }));
    const input = screen.getByLabelText(/Endereço/);
    await userEvent.type(input, "http://loja.com.br");
    await userEvent.click(screen.getByRole("button", { name: "Enviar link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("https://");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "https://instagram.com/loja");
    await userEvent.click(screen.getByRole("button", { name: "Enviar link" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ kind: "url", url: "https://instagram.com/loja" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("PDF grande demais ou tipo errado: erro no cliente, sem envio", async () => {
    const onSubmit = vi.fn(ok);
    render(<AttachmentSheet open onClose={vi.fn()} onSubmit={onSubmit} phase={null} />);
    const input = screen.getByLabelText("Escolher PDF") as HTMLInputElement;
    expect(input).toHaveAttribute("accept", expect.stringContaining("application/pdf"));
    const big = new File(["x"], "grande.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    await userEvent.upload(input, big, { applyAccept: false });
    expect(await screen.findByRole("alert")).toHaveTextContent("até 20 MB");
    await userEvent.upload(input, new File(["x"], "foto.png", { type: "image/png" }), { applyAccept: false });
    expect(await screen.findByRole("alert")).toHaveTextContent("PDF");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("imagem válida vai para o envio com o mime certo", async () => {
    const onSubmit = vi.fn(ok);
    render(<AttachmentSheet open onClose={vi.fn()} onSubmit={onSubmit} phase={null} />);
    const file = new File(["abc"], "flyer.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Escolher imagem"), file);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ kind: "image", file, name: "flyer.png", mimeType: "image/png" }));
  });

  it("erro do envio fica na folha; progresso é anunciado", async () => {
    const onSubmit = vi.fn(async () => ({ ok: false as const, message: "Não foi possível enviar o arquivo." }));
    const { rerender } = render(<AttachmentSheet open onClose={vi.fn()} onSubmit={onSubmit} phase={null} />);
    await userEvent.upload(screen.getByLabelText("Escolher imagem"), new File(["a"], "a.png", { type: "image/png" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível enviar o arquivo.");
    rerender(<AttachmentSheet open onClose={vi.fn()} onSubmit={onSubmit} phase="uploading" />);
    expect(screen.getByText("Enviando o arquivo…")).toBeInTheDocument();
  });
});

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (t: string) => t === "audio/mp4";
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_s: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "";
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: this.mimeType }) });
    void this.onstop?.();
  }
}

describe("VoiceSheet", () => {
  beforeEach(() => {
    FakeRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("grava (formato mp4 do Safari), mostra a prévia e envia como audio/mp4", async () => {
    const onSubmit = vi.fn(async (_d: AttachmentDraft) => ({ ok: true as const }));
    render(<VoiceSheet open onClose={vi.fn()} onSubmit={onSubmit} phase={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Começar a gravar" }));
    await screen.findByRole("button", { name: "Parar gravação" });
    await userEvent.click(screen.getByRole("button", { name: "Parar gravação" }));
    expect(await screen.findByLabelText("Prévia da gravação")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const draft = onSubmit.mock.calls[0][0] as Exclude<AttachmentDraft, { kind: "url" }>;
    expect(draft.kind).toBe("audio");
    expect(draft.mimeType).toBe("audio/mp4");
    expect(draft.name).toMatch(/\.m4a$/);
    expect(draft.file.size).toBe(64);
  });

  it("gravação acima de 2 MB avisa e não deixa enviar", async () => {
    const onSubmit = vi.fn(ok);
    FakeRecorder.prototype.stop = function (this: FakeRecorder) {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "audio/mp4" }) });
      void this.onstop?.();
    };
    render(<VoiceSheet open onClose={vi.fn()} onSubmit={onSubmit} phase={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Começar a gravar" }));
    await userEvent.click(await screen.findByRole("button", { name: "Parar gravação" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Áudio grande demais");
    expect(screen.getByRole("button", { name: "Enviar áudio" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("permissão do microfone negada: mensagem clara e volta ao início", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(denied);
    render(<VoiceSheet open onClose={vi.fn()} onSubmit={vi.fn(ok)} phase={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Começar a gravar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permissão do microfone negada");
    expect(screen.getByRole("button", { name: "Começar a gravar" })).toBeInTheDocument();
  });

  it("navegador sem MediaRecorder: avisa", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    render(<VoiceSheet open onClose={vi.fn()} onSubmit={vi.fn(ok)} phase={null} />);
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Começar a gravar" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("não grava áudio");
  });
});
