import { useRef } from "react";
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
import { NotificationPanelShell } from "./NotificationPanel";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const NOW = new Date(2026, 10, 7, 10, 0).getTime();

function makePrefs(over: Partial<EffectivePrefs> = {}): EffectivePrefs {
  const mk = (bell: boolean) => Object.fromEntries(KNOWN_FLAGS.map((f) => [f, bell]));
  return {
    preset: "all",
    presetSource: "default",
    flags: {},
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
    pushEnabled: true,
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
    const pending = deferred();
    const p = setup({ onPreset: vi.fn(() => pending.promise) });
    expect(screen.getByRole("radio", { name: /^Tudo/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: /Só o que é comigo/ }));
    expect(p.onPreset).toHaveBeenCalledWith("mine");
    expect(screen.getByRole("radio", { name: /Só o que é comigo/ })).toHaveAttribute("aria-checked", "true");
    pending.resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
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
    const pending = deferred();
    const onChannel = vi.fn(() => pending.promise);
    setup({ onChannel });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    const sw = screen.getByRole("switch", { name: "Tarefa atrasada: E-mail" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(onChannel).toHaveBeenCalledWith("email", "taskOverdue", false);
    expect(screen.getByRole("switch", { name: "Tarefa atrasada: E-mail" })).toHaveAttribute("aria-checked", "false");
    pending.resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
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
    expect(screen.getByText(/Tarefa atrasada precisa de uma ação sua e não pode ser desligado/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Tarefa atrasada: Sino/ })).toBeNull();
  });

  it("Push oculto com a flag desligada; Telegram só com vínculo", async () => {
    setup({ telegramLinked: false, pushAvailable: false });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.queryByRole("switch", { name: /: No aparelho$/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /: Telegram$/ })).toBeNull();
    expect(screen.getByRole("switch", { name: "Tarefa atrasada: E-mail" })).toBeInTheDocument();
  });

  it("Push aparece quando disponível", async () => {
    setup({ pushAvailable: true });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByRole("switch", { name: "Tarefa atrasada: No aparelho" })).toBeInTheDocument();
  });

  it("tipo sem template de e-mail mostra traço no lugar do interruptor", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.queryByRole("switch", { name: "Conversa transferida para você: E-mail" })).toBeNull();
    // texto só para leitor de tela, sem controle focável (fora do Tab)
    expect(screen.getByText("Conversa transferida para você: sem e-mail para este aviso")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sem e-mail para este aviso/ })).toBeNull();
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
    setup({ pushAvailable: true, prefs: makePrefs({ orgHidePreview: true, effectiveShowPreview: false }) });
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

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("revisão do C2", () => {
  it("tocar no atalho atual reaplica", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("radio", { name: /^Tudo/ }));
    expect(p.onPreset).toHaveBeenCalledWith("all");
  });

  it("mostra Personalizado quando há escolha por tipo", () => {
    const base = makePrefs();
    setup({ prefs: { ...base, channels: { ...base.channels, email: { ...base.channels.email, taskOverdue: false } } } });
    expect(screen.getByText("Personalizado")).toBeInTheDocument();
  });

  it("com ajustes por tipo, trocar o atalho pede confirmação; Cancelar mantém a seleção", async () => {
    const base = makePrefs();
    const p = setup({
      prefs: { ...base, channels: { ...base.channels, email: { ...base.channels.email, taskOverdue: false } } },
    });
    await userEvent.click(screen.getByRole("radio", { name: /Nada/ }));
    expect(screen.getByText("Isso substitui seus ajustes por tipo. Continuar?")).toBeInTheDocument();
    expect(p.onPreset).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /^Tudo/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(p.onPreset).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /^Tudo/ })).toHaveAttribute("aria-checked", "true");
  });

  it("com ajustes por tipo, Continuar aplica o atalho (também ao reaplicar o atual)", async () => {
    const base = makePrefs();
    const p = setup({
      prefs: { ...base, channels: { ...base.channels, email: { ...base.channels.email, taskOverdue: false } } },
    });
    await userEvent.click(screen.getByRole("radio", { name: /^Tudo/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(p.onPreset).toHaveBeenCalledWith("all"));
  });

  it("sem escolhas por tipo não mostra Personalizado", () => {
    setup();
    expect(screen.queryByText("Personalizado")).toBeNull();
  });

  it("resposta atrasada de um toque antigo não apaga o palpite do toque mais novo", async () => {
    const calls: ReturnType<typeof deferred>[] = [];
    const onChannel = vi.fn(() => {
      const d = deferred();
      calls.push(d);
      return d.promise;
    });
    setup({ onChannel });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    const name = "Tarefa atrasada: E-mail";
    await userEvent.click(screen.getByRole("switch", { name })); // -> false
    await userEvent.click(screen.getByRole("switch", { name })); // -> true
    await userEvent.click(screen.getByRole("switch", { name })); // -> false
    expect(onChannel).toHaveBeenCalledTimes(3);
    calls[0].reject(new Error("atrasado"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // o servidor ainda diz "ligado", mas o último toque foi "desligado"
    expect(screen.getByRole("switch", { name })).toHaveAttribute("aria-checked", "false");
    calls[2].resolve();
    await waitFor(() => expect(screen.getByRole("switch", { name })).toHaveAttribute("aria-checked", "true"));
  });

  it("palpites pendentes somem quando o atalho é aplicado", async () => {
    const pending = deferred();
    setup({ onChannel: vi.fn(() => pending.promise) });
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    const name = "Tarefa atrasada: E-mail";
    await userEvent.click(screen.getByRole("switch", { name }));
    expect(screen.getByRole("switch", { name })).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByRole("radio", { name: /^Tudo/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(screen.getByRole("switch", { name })).toHaveAttribute("aria-checked", "true"));
  });

  it("resumo diário não tem sino", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByText("Resumo diário: não aparece no sino")).toBeInTheDocument();
  });

  it("sem push ligado: sem prévia (usuário e organização) e sem citar push", () => {
    setup({ pushEnabled: false, pushAvailable: false, canManageOrg: true });
    expect(screen.queryByRole("switch", { name: /prévia na tela de bloqueio/ })).toBeNull();
    // pausa e silêncio
    expect(screen.getAllByText(/nada sai por e-mail ou Telegram, exceto pedido de ajuda urgente; tudo fica registrado no sino/)).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/push/i);
  });

  it("com push disponível a prévia vale para os avisos no aparelho", () => {
    setup({ pushEnabled: true, pushAvailable: true });
    expect(screen.getByText(/Vale para os avisos no aparelho/)).toBeInTheDocument();
  });

  it("aparelho do admin sem suporte: sem prévia pessoal, mas 'Ocultar prévia' da organização aparece", () => {
    setup({ pushEnabled: true, pushAvailable: false, canManageOrg: true });
    expect(screen.queryByRole("switch", { name: "Mostrar prévia na tela de bloqueio" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Ocultar prévia na tela de bloqueio" })).toBeInTheDocument();
  });

  it("pausa com pedido urgente ligado cita a exceção; sem push o atalho Nada não cita avisos no aparelho", () => {
    setup({ pushEnabled: false, pushAvailable: false, prefs: makePrefs({ urgentBypass: true }) });
    expect(screen.getAllByText(/exceto pedido de ajuda urgente/)).toHaveLength(2);
  });

  it("a nota do e-mail de reserva aparece sob a matriz", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByText(/de tarefas, 30 min\./)).toBeInTheDocument();
  });

  it("desligar o silêncio com campos vazios chama só enabled:false, sem erro", async () => {
    const p = setup({
      prefs: makePrefs({ quietHours: { enabled: true, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" } }),
    });
    await userEvent.clear(screen.getByLabelText("Início"));
    await userEvent.click(screen.getByRole("switch", { name: "Silenciar em um horário" }));
    expect(p.onQuietHours).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("horário só é gravado ao sair do campo", async () => {
    const p = setup({
      prefs: makePrefs({ quietHours: { enabled: true, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" } }),
    });
    const end = screen.getByLabelText("Fim");
    await userEvent.clear(end);
    await userEvent.type(end, "07:00");
    expect(p.onQuietHours).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(p.onQuietHours).toHaveBeenCalledWith({
      enabled: true,
      start: "21:00",
      end: "07:00",
      timeZone: "America/Sao_Paulo",
    });
  });

  it("mostra o fuso com nome em português", () => {
    setup();
    expect(screen.getByText(/Fuso: São Paulo \(Brasília\)/)).toBeInTheDocument();
  });

  it("no celular a pausa vira só o ícone, com o texto completo no menu", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const onResume = vi.fn();
    render(
      <NotificationPauseMenuView
        pausedUntil={new Date(2026, 10, 7, 14, 0).getTime()}
        now={NOW}
        onPause={vi.fn()}
        onResume={onResume}
      />,
    );
    expect(screen.queryByText("Retomar")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Pausado até 14:00/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Retomar" }));
    expect(onResume).toHaveBeenCalled();
  });
});

describe("menu de pausa dentro do painel do sino", () => {
  function Harness({ onPause }: { onPause: (mode: string) => void }) {
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <header>
        <button ref={ref} type="button">
          sino
        </button>
        <NotificationPanelShell
          open
          onClose={vi.fn()}
          anchor={ref}
          hasUnread={false}
          onMarkAllRead={vi.fn()}
          headerExtra={<NotificationPauseMenuView pausedUntil={null} now={NOW} onPause={onPause} onResume={vi.fn()} />}
        >
          <p>lista</p>
        </NotificationPanelShell>
      </header>
    );
  }

  it.each([true, false])("abre o menu e chama pauseFor com 1 h (celular=%s)", async (mobile) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: mobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const onPause = vi.fn();
    render(<Harness onPause={onPause} />);
    await userEvent.click(screen.getByRole("button", { name: "Pausar avisos" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Por 1 hora" }));
    expect(onPause).toHaveBeenCalledWith("1h");
  });
});
