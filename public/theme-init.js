// Pre-paint theme (fv2-14). Served from 'self' (CSP script-src 'self'), no module, loaded before the CSS.
// Under /app the stored device theme ("hnbcrm:theme") wins when valid. Public pages mirror
// resolvePublicTheme (src/lib/theme.ts): visitor choice ("hnbcrm:public-theme") > device app theme > whatsapp.
// Keep THEMES/COLORS in sync with UI_THEMES (convex/lib/uiTheme.ts) and THEME_COLOR (src/lib/theme.ts).
// Ownership ("hnbcrm:theme-user") is checked by useUiTheme, not here: the app clears both keys on
// sign-out and on an expired session.
(function () {
  var COLORS = { dark: "#0F0F11", light: "#FAFAFA", whatsapp: "#008069", "whatsapp-dark": "#202C33" };
  var theme = "whatsapp";
  function valid(t) {
    return !!t && Object.prototype.hasOwnProperty.call(COLORS, t);
  }
  try {
    var p = location.pathname;
    var app = localStorage.getItem("hnbcrm:theme");
    if (p === "/app" || p.indexOf("/app/") === 0) {
      if (valid(app)) theme = app;
    } else {
      var pub = localStorage.getItem("hnbcrm:public-theme");
      if (valid(pub)) theme = pub;
      else if (valid(app)) theme = app;
    }
  } catch (e) {}
  try {
    document.documentElement.setAttribute("data-theme", theme);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", COLORS[theme]);
  } catch (e) {}
})();
