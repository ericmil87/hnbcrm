import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

interface FormSuccessProps {
  message: string;
  redirectUrl?: string;
  title?: string;
  subtitle?: string;
  cta?: { label: string; url: string };
  submittedValues?: Record<string, string>;
  fields?: { id: string; label: string }[];
}

/**
 * Replace {variable} placeholders with submitted field values.
 * Matches field IDs or field labels (case-insensitive).
 */
function replaceVariables(
  text: string,
  values?: Record<string, string>,
  fields?: { id: string; label: string }[]
): string {
  if (!values || !fields) return text;

  return text.replace(/\{([^}]+)\}/g, (match, key) => {
    // Try direct field ID match
    if (values[key] !== undefined) return values[key];

    // Try matching by field label (case-insensitive)
    const field = fields.find(
      (f) => f.label.toLowerCase() === key.toLowerCase()
    );
    if (field && values[field.id] !== undefined) return values[field.id];

    return match; // Leave unreplaced
  });
}

export function FormSuccess({
  message,
  redirectUrl,
  title,
  subtitle,
  cta,
  submittedValues,
  fields,
}: FormSuccessProps) {
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

  const displayTitle = title
    ? replaceVariables(title, submittedValues, fields)
    : undefined;
  const displaySubtitle = subtitle
    ? replaceVariables(subtitle, submittedValues, fields)
    : undefined;
  const displayMessage = replaceVariables(message, submittedValues, fields);

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

      {displayTitle ? (
        <>
          <h3
            className="text-xl font-bold mb-2"
            style={{ color: "var(--form-text)" }}
          >
            {displayTitle}
          </h3>
          {displaySubtitle && (
            <p
              className="text-sm mb-2"
              style={{ color: "var(--form-text)", opacity: 0.7 }}
            >
              {displaySubtitle}
            </p>
          )}
        </>
      ) : (
        <p
          className="text-lg font-semibold mb-2"
          style={{ color: "var(--form-text)" }}
        >
          {displayMessage}
        </p>
      )}

      {/* CTA button */}
      {cta && (
        <a
          href={cta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center justify-center px-6 py-3 text-sm font-bold text-white rounded-lg transition-all duration-150 hover:brightness-110"
          style={{
            backgroundColor: "var(--form-primary)",
            borderRadius: "var(--form-radius)",
          }}
        >
          {cta.label}
        </a>
      )}

      {redirectUrl && !cta && (
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
