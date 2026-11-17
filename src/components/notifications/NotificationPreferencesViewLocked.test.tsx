import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KNOWN_FLAGS, ACTIONABLE_FLAGS } from "../../../convex/lib/notificationPolicy";
import { NotificationPreferencesView, type NotificationPreferencesViewProps } from "./NotificationPreferencesView";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

describe("linha travada com e-mail", () => {
  it("e-mail e sino mostram 'Sempre ligado' sem interruptor, e a linha não é 'Personalizado'", async () => {
    const mk = (v: boolean) => Object.fromEntries(KNOWN_FLAGS.map((f) => [f, v]));
    const onChannel = vi.fn().mockResolvedValue(undefined);
    const props: NotificationPreferencesViewProps = {
      prefs: {
        preset: "none",
        presetSource: "default",
        flags: {},
        channels: { bell: mk(true), email: mk(false), telegram: mk(false), push: mk(false) },
        actionableFlags: [...ACTIONABLE_FLAGS],
        pausedUntil: null,
        quietHours: { enabled: false, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" },
        urgentBypass: true,
        showPreview: true,
        orgHidePreview: false,
        effectiveShowPreview: true,
        orgDefaults: { preset: null, hidePreviewOnLockScreen: false },
      },
      now: Date.now(),
      canManageOrg: false,
      telegramLinked: true,
      pushAvailable: false,
      pushEnabled: true,
      onPreset: vi.fn(),
      onChannel,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onQuietHours: vi.fn(),
      onUrgentBypass: vi.fn(),
      onShowPreview: vi.fn(),
      onApplyAll: vi.fn(),
      onOrgDefaults: vi.fn(),
    };
    render(<NotificationPreferencesView {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByText(/Falha de pagamento e cancelamento: e-mail não pode ser desligado|Falha de pagamento e cancelamento: E-mail não pode ser desligado/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Falha de pagamento e cancelamento: E-mail" })).toBeNull();
    expect(onChannel).not.toHaveBeenCalled();
  });
});
