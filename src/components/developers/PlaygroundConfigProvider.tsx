import { createContext, useContext, useState, type ReactNode } from "react";

const STORAGE_KEYS = {
  baseUrl: "hnbcrm_playground_baseUrl",
  apiKey: "hnbcrm_playground_apiKey",
} as const;

interface PlaygroundConfigContextValue {
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  isConfigured: boolean;
}

const PlaygroundConfigContext = createContext<PlaygroundConfigContextValue | null>(null);

export function PlaygroundConfigProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.baseUrl) || ""
  );
  const [apiKey, setApiKeyState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.apiKey) || ""
  );

  const setBaseUrl = (value: string) => {
    setBaseUrlState(value);
    localStorage.setItem(STORAGE_KEYS.baseUrl, value);
  };

  const setApiKey = (value: string) => {
    setApiKeyState(value);
    localStorage.setItem(STORAGE_KEYS.apiKey, value);
  };

  const isConfigured = baseUrl.trim() !== "" && apiKey.trim() !== "";

  return (
    <PlaygroundConfigContext.Provider value={{ baseUrl, setBaseUrl, apiKey, setApiKey, isConfigured }}>
      {children}
    </PlaygroundConfigContext.Provider>
  );
}

export function usePlaygroundConfig(): PlaygroundConfigContextValue {
  const ctx = useContext(PlaygroundConfigContext);
  if (!ctx) {
    throw new Error("usePlaygroundConfig must be used within a PlaygroundConfigProvider");
  }
  return ctx;
}
