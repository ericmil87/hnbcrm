declare const __APP_BUILD__: string;

/** Build id injected by Vite `define`; "dev" under vitest/dev server. */
export const APP_BUILD: string = typeof __APP_BUILD__ !== "undefined" ? __APP_BUILD__ : "dev";
