interface JsonHighlighterProps {
  data: unknown;
}

function highlightJson(json: string): string {
  // Escape HTML entities first
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Regex matches all JSON tokens in one pass
  return escaped.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "text-amber-300"; // number
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = "text-sky-400"; // key
        } else {
          cls = "text-emerald-400"; // string value
        }
      } else if (/true|false/.test(match)) {
        cls = "text-purple-400"; // boolean
      } else if (/null/.test(match)) {
        cls = "text-gray-500"; // null
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function JsonHighlighter({ data }: JsonHighlighterProps) {
  const json = JSON.stringify(data, null, 2) ?? "";
  const html = highlightJson(json);

  return (
    <pre className="text-[13px] leading-relaxed bg-[#0d1117] rounded-lg p-3 overflow-auto text-gray-400">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
