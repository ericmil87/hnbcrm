import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";
import { toast } from "sonner";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export function SignInForm() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  if (showForgotPassword) {
    return (
      <ForgotPasswordForm
        initialEmail={email}
        onBack={() => setShowForgotPassword(false)}
      />
    );
  }

  return (
    <div className="w-full">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitting(true);
          const formData = new FormData(e.target as HTMLFormElement);
          formData.set("flow", flow);
          void signIn("password", formData).catch((error) => {
            let toastTitle = "";
            if (error.message.includes("Invalid password")) {
              toastTitle = "Senha inválida. Tente novamente.";
            } else {
              toastTitle =
                flow === "signIn"
                  ? "Não foi possível entrar. Você quis se cadastrar?"
                  : "Não foi possível cadastrar. Você quis entrar?";
            }
            toast.error(toastTitle);
            setSubmitting(false);
          });
        }}
      >
        <input
          className="auth-input-field"
          type="email"
          name="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="auth-input-field"
          type="password"
          name="password"
          placeholder="Senha"
          required
        />
        {flow === "signIn" && (
          <div className="text-right -mt-3">
            <button
              type="button"
              className="text-sm text-brand-500 hover:text-brand-400 hover:underline font-medium cursor-pointer"
              onClick={() => setShowForgotPassword(true)}
            >
              Esqueci minha senha
            </button>
          </div>
        )}
        <button className="auth-button" type="submit" disabled={submitting}>
          {flow === "signIn" ? "Entrar" : "Cadastrar"}
        </button>
        <div className="text-center text-sm">
          <span className="text-text-secondary">
            {flow === "signIn"
              ? "Não tem conta? "
              : "Já tem conta? "}
          </span>
          <button
            type="button"
            className="text-brand-500 hover:text-brand-400 hover:underline font-medium cursor-pointer"
            onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}
          >
            {flow === "signIn" ? "Cadastrar" : "Entrar"}
          </button>
        </div>
      </form>
      <div className="flex items-center justify-center my-3">
        <hr className="my-4 grow border-border" />
        <span className="mx-4 text-text-muted">ou</span>
        <hr className="my-4 grow border-border" />
      </div>
      <button className="auth-button" onClick={() => void signIn("anonymous")}>
        Entrar anonimamente
      </button>
    </div>
  );
}
