import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Lock } from "lucide-react";

interface ChangePasswordScreenProps {
  organizationId: Id<"organizations">;
  onSuccess: () => void;
}

export function ChangePasswordScreen({
  organizationId,
  onSuccess,
}: ChangePasswordScreenProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const changePassword = useAction(api.nodeActions.changePassword);

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!currentPassword) {
      newErrors.currentPassword = "Senha atual é obrigatória.";
    }
    if (!newPassword) {
      newErrors.newPassword = "Nova senha é obrigatória.";
    } else if (newPassword.length < 8) {
      newErrors.newPassword = "A nova senha deve ter pelo menos 8 caracteres.";
    }
    if (newPassword !== confirmPassword) {
      newErrors.confirmPassword = "As senhas não coincidem.";
    }
    if (newPassword === currentPassword && newPassword) {
      newErrors.newPassword = "A nova senha deve ser diferente da atual.";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      await changePassword({
        organizationId,
        currentPassword,
        newPassword,
      });
      toast.success("Senha alterada com sucesso!");
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || "Falha ao alterar senha.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen px-4 py-8 bg-surface-base">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-brand-500/10 mb-4">
            <Lock size={32} className="text-brand-500" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary mb-2">
            Alterar Senha
          </h1>
          <p className="text-text-secondary text-sm">
            Você precisa alterar sua senha temporária antes de continuar.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Senha Atual"
            type="password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setErrors((prev) => ({ ...prev, currentPassword: "" }));
            }}
            error={errors.currentPassword}
            placeholder="Digite sua senha atual"
            autoComplete="current-password"
          />

          <Input
            label="Nova Senha"
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setErrors((prev) => ({ ...prev, newPassword: "" }));
            }}
            error={errors.newPassword}
            placeholder="Minimo 8 caracteres"
            autoComplete="new-password"
          />

          <Input
            label="Confirmar Nova Senha"
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setErrors((prev) => ({ ...prev, confirmPassword: "" }));
            }}
            error={errors.confirmPassword}
            placeholder="Repita a nova senha"
            autoComplete="new-password"
          />

          <Button
            type="submit"
            disabled={isSubmitting}
            className="w-full"
            size="lg"
          >
            {isSubmitting ? "Alterando..." : "Alterar Senha"}
          </Button>
        </form>
      </div>
    </div>
  );
}
