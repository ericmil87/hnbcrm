// Pre-paint theme (fv2-14). Served from 'self' (CSP script-src 'self'), no module, loaded before the CSS.
(function () {
  try {
    var t = localStorage.getItem("hnbcrm:theme");
    var p = location.pathname;
    if ((t === "light" || t === "whatsapp") && (p === "/app" || p.indexOf("/app/") === 0)) {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch (e) {}
})();
