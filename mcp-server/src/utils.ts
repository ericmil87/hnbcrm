export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function successResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
