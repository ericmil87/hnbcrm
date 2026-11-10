interface JsonHighlighterProps {
  data: unknown;
}

export function highlightJson(json: string): string {
  // Escape HTML entities first
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Regex matches all JSON tokens in one pass
  return escaped.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "text-code-number"; // number
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = "text-code-key"; // key
        } else {
          cls = "text-code-string"; // string value
        }
      } else if (/true|false/.test(match)) {
        cls = "text-code-keyword"; // boolean
      } else if (/null/.test(match)) {
        cls = "text-code-muted"; // null
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function JsonHighlighter({ data }: JsonHighlighterProps) {
  const json = JSON.stringify(data, null, 2) ?? "";
  const html = highlightJson(json);

  return (
    <pre className="text-[13px] leading-relaxed bg-code-bg border border-code-border rounded-lg p-3 overflow-auto text-code-fg">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
