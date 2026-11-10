// Pre-paint theme (fv2-14). Served from 'self' (CSP script-src 'self'), no module, loaded before the CSS.
// Public pages always get the default ("whatsapp"); under /app the stored device theme wins when valid.
// Keep THEMES/COLORS in sync with UI_THEMES (convex/lib/uiTheme.ts) and THEME_COLOR (src/lib/theme.ts).
// Ownership ("hnbcrm:theme-user") is checked by useUiTheme, not here: the app clears both keys on
// sign-out and on an expired session.
(function () {
  var COLORS = { dark: "#0F0F11", light: "#FAFAFA", whatsapp: "#008069", "whatsapp-dark": "#202C33" };
  var theme = "whatsapp";
  try {
    var p = location.pathname;
    if (p === "/app" || p.indexOf("/app/") === 0) {
      var t = localStorage.getItem("hnbcrm:theme");
      if (t && Object.prototype.hasOwnProperty.call(COLORS, t)) theme = t;
    }
  } catch (e) {}
  try {
    document.documentElement.setAttribute("data-theme", theme);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", COLORS[theme]);
  } catch (e) {}
})();
