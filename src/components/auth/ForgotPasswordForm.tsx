import { useAuthActions } from "@convex-dev/auth/react";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../convex/_generated/api";

interface ForgotPasswordFormProps {
  /** E-mail já digitado no formulário de login, se houver. */
  initialEmail: string;
  onBack: () => void;
}

type ResetStep = "email" | "code";

const CODE_LENGTH = 8;
const RESEND_COOLDOWN_SECONDS = 60;

// Mensagem ÚNICA para sucesso e "falha mascarada" — nunca revela se a conta existe.
const NEUTRAL_RESET_MESSAGE =
  "Se existir uma conta com este e-mail, enviamos um código de 8 dígitos. Ele vale por 15 minutos.";

interface FieldErrors {
  code?: string;
  newPassword?: string;
  confirmPassword?: string;
}

function isNetworkOrRateLimitError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("offline") ||
    message.includes("too many") ||
    message.includes("toomanyfailedattempts") ||
    message.includes("rate limit") ||
    message.includes("429")
  );
}

export function ForgotPasswordForm({
  initialEmail,
  onBack,
}: ForgotPasswordFormProps) {
  const { signIn } = useAuthActions();
  // Best-effort: se a mutation ainda não existir no backend (implantação em
  // paralelo) ou falhar por qualquer motivo, o login não pode travar por causa
  // disso — só limpa o aviso de "troca de senha obrigatória" quando dá certo.
  const clearMustChangePassword = useMutation(
    api.teamMembers.clearMustChangePasswordAfterReset
  );

  const [step, setStep] = useState<ResetStep>("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [sendingCode, setSendingCode] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const emailInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Foco automático no primeiro campo de cada tela.
  useEffect(() => {
    if (step === "email") {
      emailInputRef.current?.focus();
    } else {
      codeInputRef.current?.focus();
    }
  }, [step]);

  // Contagem regressiva do cooldown de reenvio.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const requestCode = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;

    setSendingCode(true);
    try {
      try {
        await signIn("password", { email: trimmedEmail, flow: "reset" });
      } catch (error) {
        // Anti-enumeração: o backend lança erro (ex.: InvalidAccountId) quando
        // não existe conta com este e-mail. Só erros claramente de rede/limite
        // de tentativas interrompem o fluxo — qualquer outro é mascarado, e a
        // tela sempre avança com a mesma mensagem neutra.
        if (isNetworkOrRateLimitError(error)) {
          throw error;
        }
      }
      setStep("code");
      setCooldown(RESEND_COOLDOWN_SECONDS);
      toast.success(NEUTRAL_RESET_MESSAGE);
    } catch {
      toast.error(
        "Não foi possível enviar o código agora. Verifique sua conexão e tente novamente."
      );
    } finally {
      setSendingCode(false);
    }
  };

  const handleSendCode = (e: React.FormEvent) => {
    e.preventDefault();
    void requestCode();
  };

  const handleResend = () => {
    if (cooldown > 0 || sendingCode) return;
    void requestCode();
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    const errors: FieldErrors = {};
    if (!code.trim()) {
      errors.code = "Informe o código recebido por e-mail.";
    }
    if (!newPassword) {
      errors.newPassword = "Nova senha é obrigatória.";
    } else if (newPassword.length < 8) {
      errors.newPassword = "A nova senha deve ter pelo menos 8 caracteres.";
    }
    if (newPassword !== confirmPassword) {
      errors.confirmPassword = "As senhas não coincidem.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setResetting(true);
    try {
      await signIn("password", {
        email: email.trim(),
        code: code.trim(),
        newPassword,
        flow: "reset-verification",
      });

      try {
        await clearMustChangePassword({});
      } catch {
        // Ignorado de propósito — ver comentário acima.
      }

      toast.success("Senha redefinida com sucesso!");
      // A partir daqui o usuário já está autenticado (signIn efetiva a sessão);
      // quem cuida do redirecionamento é o AuthPage, reagindo ao isAuthenticated.
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Invalid code")) {
        setFieldErrors((prev) => ({
          ...prev,
          code: "Código inválido ou expirado.",
        }));
        toast.error(
          "Código inválido ou expirado. Confira o e-mail ou peça um novo código."
        );
      } else if (isNetworkOrRateLimitError(error)) {
        toast.error(
          "Não foi possível redefinir a senha agora. Verifique sua conexão e tente novamente."
        );
      } else {
        toast.error("Não foi possível redefinir a senha. Tente novamente.");
      }
    } finally {
      setResetting(false);
    }
  };

  if (step === "email") {
    return (
      <div className="w-full">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
        >
          <ArrowLeft size={16} />
          Voltar para o login
        </button>

        <h2 className="text-lg font-semibold text-text-primary mb-1">
          Esqueci minha senha
        </h2>
        <p className="text-sm text-text-secondary mb-5">
          Digite seu e-mail. Se houver uma conta associada, enviaremos um
          código para redefinir sua senha.
        </p>

        <form className="flex flex-col gap-5" onSubmit={handleSendCode}>
          <input
            ref={emailInputRef}
            className="auth-input-field"
            type="email"
            name="email"
            placeholder="Email"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="auth-button" type="submit" disabled={sendingCode}>
            {sendingCode ? "Enviando..." : "Enviar código"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="w-full">
      <h2 className="text-lg font-semibold text-text-primary mb-1">
        Redefinir senha
      </h2>
      <p className="text-sm text-text-secondary mb-5" aria-live="polite">
        {NEUTRAL_RESET_MESSAGE}
      </p>

      <form className="flex flex-col gap-5" onSubmit={handleResetPassword}>
        <div>
          <input
            ref={codeInputRef}
            className="auth-input-field"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH}
            placeholder="Código de 8 dígitos"
            aria-label="Código de verificação"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH));
              setFieldErrors((prev) => ({ ...prev, code: undefined }));
            }}
            required
          />
          {fieldErrors.code && (
            <p className="mt-1.5 text-[13px] text-semantic-error" role="alert">
              {fieldErrors.code}
            </p>
          )}
        </div>

        <div>
          <input
            className="auth-input-field"
            type="password"
            autoComplete="new-password"
            placeholder="Nova senha"
            aria-label="Nova senha"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setFieldErrors((prev) => ({ ...prev, newPassword: undefined }));
            }}
            required
          />
          {fieldErrors.newPassword && (
            <p className="mt-1.5 text-[13px] text-semantic-error" role="alert">
              {fieldErrors.newPassword}
            </p>
          )}
        </div>

        <div>
          <input
            className="auth-input-field"
            type="password"
            autoComplete="new-password"
            placeholder="Confirmar nova senha"
            aria-label="Confirmar nova senha"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setFieldErrors((prev) => ({ ...prev, confirmPassword: undefined }));
            }}
            required
          />
          {fieldErrors.confirmPassword && (
            <p className="mt-1.5 text-[13px] text-semantic-error" role="alert">
              {fieldErrors.confirmPassword}
            </p>
          )}
        </div>

        <button className="auth-button" type="submit" disabled={resetting}>
          {resetting ? "Redefinindo..." : "Redefinir senha"}
        </button>

        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={handleResend}
            disabled={cooldown > 0 || sendingCode}
            className="text-brand-500 hover:text-brand-400 hover:underline font-medium disabled:text-text-muted disabled:no-underline disabled:cursor-not-allowed cursor-pointer"
          >
            {cooldown > 0 ? `Reenviar código (${cooldown}s)` : "Reenviar código"}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="text-text-secondary hover:text-text-primary hover:underline font-medium cursor-pointer"
          >
            Voltar para o login
          </button>
        </div>
      </form>
    </div>
  );
}
