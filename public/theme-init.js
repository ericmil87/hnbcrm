// Pre-paint theme (fv2-14). Served from 'self' (CSP script-src 'self'), no module, loaded before the CSS.
// Keep the theme-color values in sync with THEME_COLOR in src/lib/theme.ts. Ownership ("hnbcrm:theme-user")
// is checked by useUiTheme, not here: the app clears both keys on sign-out and on an expired session.
(function () {
  try {
    var t = localStorage.getItem("hnbcrm:theme");
    var p = location.pathname;
    if ((t === "light" || t === "whatsapp") && (p === "/app" || p.indexOf("/app/") === 0)) {
      document.documentElement.setAttribute("data-theme", t);
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute("content", t === "light" ? "#FAFAFA" : "#008069");
    }
  } catch (e) {}
})();
