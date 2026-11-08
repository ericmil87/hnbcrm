declare const __APP_BUILD__: string;
declare const __PWA_KILL_SWITCH__: boolean;

/** Build id injected by Vite `define`; "dev" under vitest/dev server. */
export const APP_BUILD: string = typeof __APP_BUILD__ !== "undefined" ? __APP_BUILD__ : "dev";

/** True in a build made with PWA_KILL_SWITCH=1: the app unregisters any service worker instead of registering. */
export const PWA_KILL_SWITCH: boolean = typeof __PWA_KILL_SWITCH__ !== "undefined" ? __PWA_KILL_SWITCH__ : false;
