import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import type { AuthFlow } from "@/lib/authEntry";
import {
  checkErrorView,
  currentPasswordError,
  emailFieldError,
  flowForStep,
  MIN_PASSWORD_LENGTH,
  newPasswordError,
  passwordStepErrorMessage,
  stepForNext,
  type EmailEntryStep,
  type SignInCheckNext,
} from "@/lib/emailEntry";
import { cn } from "@/lib/utils";

type PasswordStep = Exclude<EmailEntryStep, "email">;

export interface EmailEntrySuccess {
  flow: AuthFlow;
  email: string;
}

export interface EmailEntryCardViewProps {
  /** Checagem do e-mail (`authEntry.checkEmailForSignIn`); lança em erro. */
  checkEmail: (email: string) => Promise<SignInCheckNext>;
  /** Entrar ou criar conta com o provider Password; lança em erro. */
  submitPassword: (input: { email: string; password: string; flow: AuthFlow }) => Promise<void>;
  /** "Esqueci a senha": quem renderiza decide o fluxo (hoje, `ForgotPasswordForm`). */
  onForgotPassword: (email: string) => void;
  /** Chamado depois que entrar/criar conta deu certo. */
  onSuccess?: (result: EmailEntrySuccess) => void;
  /** Cartão dentro de uma conversa (onboarding): títulos e espaços menores. */
  compact?: boolean;
  /** Só muda o título do primeiro passo (`?modo=cadastro`); quem decide o caminho é a checagem. */
  intent?: AuthFlow;
  initialEmail?: string;
  /** Volta direto a um passo (ex.: retorno do "Esqueci a senha"). Exige `initialEmail`. */
  initialStep?: EmailEntryStep;
  /** Foca o e-mail ao montar. Trocas de passo sempre movem o foco. */
  autoFocus?: boolean;
}

const STEP_COPY: Record<PasswordStep, { title: string; lead: string; status: string }> = {
  password: {
    title: "Bem-vindo de volta",
    lead: "Digite a senha da conta",
    status: "Conta encontrada. Digite sua senha.",
  },
  signup: {
    title: "Vamos criar sua conta",
    lead: "Crie uma senha para",
    status: "Ainda não há conta com este e-mail. Crie uma senha.",
  },
};

/**
 * Entrada unificada: um campo de e-mail e "Continuar"; no MESMO formulário, o passo
 * seguinte é a senha (conta existente) ou criar senha (conta nova). Apresentacional:
 * recebe as chamadas por props (o container `EmailEntryCard` liga ao Convex). Reutilizado
 * pela etapa 1 do onboarding conversacional com `compact`.
 */
export function EmailEntryCardView({
  checkEmail,
  submitPassword,
  onForgotPassword,
  onSuccess,
  compact = false,
  intent = "signIn",
  initialEmail = "",
  initialStep = "email",
  autoFocus = false,
}: EmailEntryCardViewProps) {
  const [step, setStep] = useState<EmailEntryStep>(initialEmail ? initialStep : "email");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const firstRender = useRef(true);

  // Foco: no primeiro passo só com `autoFocus`; a cada troca de passo, sempre.
  useEffect(() => {
    const isFirst = firstRender.current;
    firstRender.current = false;
    if (isFirst && !autoFocus) return;
    if (step === "email") {
      emailRef.current?.focus();
      if (!isFirst) emailRef.current?.select();
    } else {
      passwordRef.current?.focus();
    }
  }, [step, autoFocus]);

  const resetStepState = () => {
    setPassword("");
    setShowPassword(false);
    setPasswordError(null);
    setFormError(null);
  };

  const goToStep = (next: EmailEntryStep) => {
    resetStepState();
    setRateLimited(false);
    setEmailError(null);
    setStep(next);
  };

  // Checagem limitada: a pessoa escolhe o caminho; o provider recusa o que não bater.
  const chooseManually = (next: PasswordStep) => {
    const error = emailFieldError(email);
    if (error) {
      setEmailError(error);
      emailRef.current?.focus();
      return;
    }
    goToStep(next);
  };

  const handleEmailSubmit = async () => {
    const error = emailFieldError(email);
    setFormError(null);
    setRateLimited(false);
    if (error) {
      setEmailError(error);
      emailRef.current?.focus();
      return;
    }
    setEmailError(null);
    setBusy(true);
    try {
      const next = await checkEmail(email.trim());
      goToStep(stepForNext(next));
    } catch (err) {
      const view = checkErrorView(err);
      setFormError(view.message);
      setRateLimited(view.rateLimited);
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordSubmit = async (current: PasswordStep) => {
    const error = current === "password" ? currentPasswordError(password) : newPasswordError(password);
    setFormError(null);
    if (error) {
      setPasswordError(error);
      passwordRef.current?.focus();
      return;
    }
    setPasswordError(null);
    setBusy(true);
    const flow = flowForStep(current);
    const trimmed = email.trim();
    try {
      await submitPassword({ email: trimmed, password, flow });
      onSuccess?.({ flow, email: trimmed });
    } catch (err) {
      setFormError(passwordStepErrorMessage(err, current));
      passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    void (step === "email" ? handleEmailSubmit() : handlePasswordSubmit(step));
  };

  const titleClass = cn(
    "font-display font-bold text-text-primary",
    compact ? "text-base" : "text-xl md:text-2xl",
  );
  const leadClass = cn("text-text-secondary", compact ? "text-[13px]" : "text-sm");
  const emailTitle = intent === "signUp" ? "Crie sua conta" : "Entrar ou criar conta";

  return (
    <form noValidate onSubmit={handleSubmit} className={cn("flex flex-col", compact ? "gap-3" : "gap-5")}>
      <p className="sr-only" aria-live="polite">
        {step === "email" ? "" : STEP_COPY[step].status}
      </p>

      {step === "email" ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className={titleClass}>{emailTitle}</h2>
            <p className={leadClass}>Digite seu e-mail. Se já tiver conta, pedimos a senha; se não, criamos uma agora.</p>
          </div>
          <FormField label="E-mail" error={emailError ?? undefined}>
            {(field) => (
              <Input
                {...field}
                ref={emailRef}
                type="email"
                name="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="nome@empresa.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                className={cn("min-h-11", emailError && "border-semantic-error")}
              />
            )}
          </FormField>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h2 className={titleClass}>{STEP_COPY[step].title}</h2>
            <p className={cn(leadClass, "break-words")}>
              {STEP_COPY[step].lead} <span className="font-medium text-text-primary">{email.trim()}</span>
            </p>
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-3 min-h-11"
                onClick={() => goToStep("email")}
                disabled={busy}
              >
                <ArrowLeft size={16} aria-hidden="true" />
                Trocar e-mail
              </Button>
            </div>
          </div>
          {/* Gerenciadores de senha associam a senha ao e-mail por este campo. */}
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email.trim()}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
          />
          <FormField
            label={step === "password" ? "Senha" : "Crie uma senha"}
            hint={step === "signup" ? `Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` : undefined}
            error={passwordError ?? undefined}
          >
            {(field) => (
              <div className="relative">
                <Input
                  {...field}
                  ref={passwordRef}
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete={step === "password" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (passwordError) setPasswordError(null);
                  }}
                  className={cn("min-h-11 pr-12", passwordError && "border-semantic-error")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label="Mostrar senha"
                  aria-pressed={showPassword}
                  className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
              </div>
            )}
          </FormField>
          {step === "password" && (
            <div className="-mt-2 flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-mr-3 min-h-11"
                onClick={() => onForgotPassword(email.trim())}
                disabled={busy}
              >
                Esqueci a senha
              </Button>
            </div>
          )}
        </>
      )}

      {formError && (
        <div role="alert" className="rounded-field border border-semantic-error/30 bg-semantic-error/10 px-3 py-2.5 text-[13px] text-semantic-error">
          {formError}
        </div>
      )}

      {step === "email" && rateLimited && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" className="min-h-11 flex-1" onClick={() => chooseManually("password")}>
            Já tenho conta
          </Button>
          <Button type="button" variant="secondary" className="min-h-11 flex-1" onClick={() => chooseManually("signup")}>
            Criar conta
          </Button>
        </div>
      )}

      <Button type="submit" size="lg" loading={busy} className="w-full">
        {step === "email" ? "Continuar" : step === "password" ? "Entrar" : "Criar conta"}
      </Button>
    </form>
  );
}

export interface EmailEntryCardProps {
  onSuccess?: (result: EmailEntrySuccess) => void;
  compact?: boolean;
  intent?: AuthFlow;
  initialEmail?: string;
  autoFocus?: boolean;
}

/**
 * Container da entrada unificada: liga a checagem (`authEntry.checkEmailForSignIn`) e o
 * provider Password (`signIn("password", { email, password, flow })`). "Esqueci a senha"
 * abre o `ForgotPasswordForm` no lugar e o "Voltar" dele retorna ao passo da senha.
 */
export function EmailEntryCard({ onSuccess, compact, intent, initialEmail, autoFocus }: EmailEntryCardProps) {
  const check = useMutation(api.authEntry.checkEmailForSignIn);
  const { signIn } = useAuthActions();
  const [forgotEmail, setForgotEmail] = useState<string | null>(null);
  const [returnEmail, setReturnEmail] = useState<string | null>(null);

  if (forgotEmail !== null) {
    return (
      <ForgotPasswordForm
        initialEmail={forgotEmail}
        onBack={() => {
          setReturnEmail(forgotEmail);
          setForgotEmail(null);
        }}
      />
    );
  }

  return (
    <EmailEntryCardView
      key={returnEmail ?? "inicio"}
      checkEmail={async (email) => (await check({ email })).next}
      submitPassword={async ({ email, password, flow }) => {
        await signIn("password", { email, password, flow });
      }}
      onForgotPassword={setForgotEmail}
      onSuccess={onSuccess}
      compact={compact}
      intent={intent}
      initialEmail={returnEmail ?? initialEmail}
      initialStep={returnEmail ? "password" : "email"}
      autoFocus={autoFocus || returnEmail !== null}
    />
  );
}
