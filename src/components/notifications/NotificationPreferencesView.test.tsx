import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { KNOWN_FLAGS, ACTIONABLE_FLAGS } from "../../../convex/lib/notificationPolicy";
import {
  NotificationPreferencesView,
  type EffectivePrefs,
  type NotificationPreferencesViewProps,
} from "./NotificationPreferencesView";
import { NotificationPauseMenuView } from "./NotificationPauseMenu";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const NOW = new Date(2026, 10, 7, 10, 0).getTime();

function makePrefs(over: Partial<EffectivePrefs> = {}): EffectivePrefs {
  const mk = (bell: boolean) => Object.fromEntries(KNOWN_FLAGS.map((f) => [f, bell]));
  return {
    preset: "all",
    presetSource: "default",
    channels: { bell: mk(true), email: mk(true), telegram: mk(true), push: mk(true) },
    actionableFlags: [...ACTIONABLE_FLAGS],
    pausedUntil: null,
    quietHours: { enabled: false, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" },
    urgentBypass: true,
    showPreview: true,
    orgHidePreview: false,
    effectiveShowPreview: true,
    orgDefaults: { preset: null, hidePreviewOnLockScreen: false },
    ...over,
  };
}

function setup(over: Partial<NotificationPreferencesViewProps> = {}) {
  const ok = () => vi.fn().mockResolvedValue(undefined);
  const props: NotificationPreferencesViewProps = {
    prefs: makePrefs(),
    now: NOW,
    canManageOrg: false,
    telegramLinked: true,
    pushAvailable: false,
    onPreset: ok(),
    onChannel: ok(),
    onPause: ok(),
    onResume: ok(),
    onQuietHours: ok(),
    onUrgentBypass: ok(),
    onShowPreview: ok(),
    onApplyAll: vi.fn().mockResolvedValue({ applied: 2, skipped: 1 }),
    onOrgDefaults: ok(),
    ...over,
  };
  render(<NotificationPreferencesView {...props} />);
  return props;
}

beforeEach(() => vi.clearAllMocks());

describe("atalhos", () => {
  it("chamam setPreset e refletem a escolha na hora", async () => {
    const p = setup();
    expect(screen.getByRole("radio", { name: /^Tudo/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: /Só o que é comigo/ }));
    expect(p.onPreset).toHaveBeenCalledWith("mine");
    expect(screen.getByRole("radio", { name: /Só o que é comigo/ })).toHaveAttribute("aria-checked", "true");
    expect(toast.success).toHaveBeenCalledWith("Preferência salva", expect.objectContaining({ id: expect.any(String) }));
  });

  it("volta ao anterior se falhar", async () => {
    setup({ onPreset: vi.fn().mockRejectedValue(new Error("x")) });
    await userEvent.click(screen.getByRole("radio", { name: /Nada/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Tudo/ })).toHaveAttribute("aria-checked", "true"));
    expect(toast.error).toHaveBeenCalled();
  });

  it("aplicar a todas confirma e mostra applied/skipped", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: "Aplicar a todas as minhas organizações" }));
    expect(p.onApplyAll).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    await waitFor(() => expect(p.onApplyAll).toHaveBeenCalled());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("2 organizações")));
  });
});

describe("matriz", () => {
  it("autosave chama setChannelPref com os argumentos certos e reverte se falhar", async () => {
    const onChannel = vi.fn().mockResolvedValue(undefined);
    setup({ onChannel });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    const sw = screen.getByRole("switch", { name: "Tarefa atrasada: E-mail" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(onChannel).toHaveBeenCalledWith("email", "taskOverdue", false);
    expect(screen.getByRole("switch", { name: "Tarefa atrasada: E-mail" })).toHaveAttribute("aria-checked", "false");
  });

  it("rollback quando a mutation falha", async () => {
    setup({ onChannel: vi.fn().mockRejectedValue(new Error("x")) });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    await userEvent.click(screen.getByRole("switch", { name: "Lead atribuído: Telegram" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Lead atribuído: Telegram" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(toast.error).toHaveBeenCalled();
  });

  it("sino de tipo acionável fica travado, sem interruptor", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByLabelText(/Tarefa atrasada: sino sempre ligado/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Tarefa atrasada: Sino/ })).toBeNull();
  });

  it("Push oculto com a flag desligada; Telegram só com vínculo", async () => {
    setup({ telegramLinked: false, pushAvailable: false });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.queryByRole("switch", { name: /: Push$/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /: Telegram$/ })).toBeNull();
    expect(screen.getByRole("switch", { name: "Tarefa atrasada: E-mail" })).toBeInTheDocument();
  });

  it("Push aparece quando disponível", async () => {
    setup({ pushAvailable: true });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByRole("switch", { name: "Tarefa atrasada: Push" })).toBeInTheDocument();
  });

  it("tipo sem template de e-mail mostra traço no lugar do interruptor", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.queryByRole("switch", { name: "Conversa transferida para você: E-mail" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Conversa transferida para você: sem e-mail para este aviso" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Conversa transferida para você: Telegram" })).toBeInTheDocument();
  });

  it("não mostra a linha de convites travada", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.queryByText("Convites de equipe")).toBeNull();
  });
});

describe("pausa", () => {
  it("com pausa mostra o indicador e Retomar", async () => {
    const p = setup({ prefs: makePrefs({ pausedUntil: new Date(2026, 10, 7, 14, 0).getTime() }) });
    expect(screen.getByText("Pausado até 14:00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retomar" }));
    expect(p.onResume).toHaveBeenCalled();
  });

  it("sem pausa oferece 1 h / 4 h / amanhã", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: "Até amanhã 8 h" }));
    expect(p.onPause).toHaveBeenCalledWith("tomorrow");
  });

  it("menu do sino: indicador e Retomar", async () => {
    const onResume = vi.fn();
    render(
      <NotificationPauseMenuView
        pausedUntil={new Date(2026, 10, 7, 14, 0).getTime()}
        now={NOW}
        onPause={vi.fn()}
        onResume={onResume}
      />,
    );
    expect(screen.getByText("Pausado até 14:00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retomar" }));
    expect(onResume).toHaveBeenCalled();
  });

  it("menu do sino: escolhe 1 hora", async () => {
    const onPause = vi.fn();
    render(<NotificationPauseMenuView pausedUntil={null} now={NOW} onPause={onPause} onResume={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Pausar avisos" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Por 1 hora" }));
    expect(onPause).toHaveBeenCalledWith("1h");
  });
});

describe("padrões da organização", () => {
  it("admin vê e salva", async () => {
    const p = setup({ canManageOrg: true });
    expect(screen.getByRole("heading", { name: "Padrões da organização" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Ocultar prévia na tela de bloqueio" }));
    expect(p.onOrgDefaults).toHaveBeenCalledWith({ preset: "all", hidePreviewOnLockScreen: true });
  });

  it("membro não vê", () => {
    setup({ canManageOrg: false });
    expect(screen.queryByText("Padrões da organização")).toBeNull();
  });
});

describe("silêncio e prévia", () => {
  it("início igual ao fim mostra erro e não chama a mutation", async () => {
    const p = setup({
      prefs: makePrefs({ quietHours: { enabled: true, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" } }),
    });
    const end = screen.getByLabelText("Fim");
    await userEvent.clear(end);
    await userEvent.type(end, "21:00");
    expect(await screen.findByRole("alert")).toHaveTextContent("não podem ser o mesmo horário");
    expect(p.onQuietHours).not.toHaveBeenCalledWith(expect.objectContaining({ start: "21:00", end: "21:00" }));
  });

  it("ligar o silêncio envia horários e fuso", async () => {
    const p = setup({ deviceTimeZone: "America/Manaus" });
    await userEvent.click(screen.getByRole("switch", { name: "Silenciar em um horário" }));
    expect(p.onQuietHours).toHaveBeenCalledWith({
      enabled: true,
      start: "21:00",
      end: "08:00",
      timeZone: "America/Manaus",
    });
  });

  it("prévia desabilitada com explicação quando a organização oculta", () => {
    setup({ prefs: makePrefs({ orgHidePreview: true, effectiveShowPreview: false }) });
    const sw = screen.getByRole("switch", { name: "Mostrar prévia na tela de bloqueio" });
    expect(sw).toBeDisabled();
    expect(screen.getByText(/A organização ocultou a prévia/)).toBeInTheDocument();
  });

  it("pedido urgente chama setUrgentBypass", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("switch", { name: "Pedido de ajuda urgente fura pausa e silêncio" }));
    expect(p.onUrgentBypass).toHaveBeenCalledWith(false);
  });
});
