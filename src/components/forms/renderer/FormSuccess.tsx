import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

interface FormSuccessProps {
  message: string;
  redirectUrl?: string;
}

export function FormSuccess({ message, redirectUrl }: FormSuccessProps) {
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    if (!redirectUrl) return;

    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          window.location.href = redirectUrl;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [redirectUrl]);

  return (
    <div className="animate-fade-in-up flex flex-col items-center justify-center py-12 px-6 text-center">
      <div className="mb-6 flex items-center justify-center">
        <CheckCircle2
          size={64}
          className="text-[#22C55E]"
          aria-hidden="true"
          strokeWidth={1.5}
        />
      </div>

      <p
        className="text-lg font-semibold mb-2"
        style={{ color: "var(--form-text)" }}
      >
        {message}
      </p>

      {redirectUrl && (
        <p
          className="text-sm mt-4"
          style={{ color: "var(--form-text)", opacity: 0.55 }}
        >
          Redirecionando em {countdown}...
        </p>
      )}
    </div>
  );
}
