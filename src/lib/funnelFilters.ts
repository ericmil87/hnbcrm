
export const getPriorityVariant = (priority: string): "error" | "warning" | "default" => {
  if (priority === "urgent") return "error";
  if (priority === "high") return "warning";
  return "default";
};

export const getTemperatureVariant = (temperature: string): "error" | "warning" | "info" => {
  if (temperature === "hot") return "error";
  if (temperature === "warm") return "warning";
  return "info";
};

export const getPriorityLabel = (priority: string): string => {
  const labels: Record<string, string> = {
    urgent: "Urgente",
    high: "Alta",
    medium: "Média",
    low: "Baixa",
  };
  return labels[priority] || priority;
};

export const getTemperatureLabel = (temperature: string): string => {
  const labels: Record<string, string> = {
    hot: "Quente",
    warm: "Morno",
    cold: "Frio",
  };
  return labels[temperature] || temperature;
};
