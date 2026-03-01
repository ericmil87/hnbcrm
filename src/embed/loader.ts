(function () {
  // 1. Guard against double-init
  if ((window as any).__hnbcrm_embed_loaded) return;
  (window as any).__hnbcrm_embed_loaded = true;

  // 2. Read config from script tag
  var script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  var slug = script.getAttribute("data-slug") || "";
  var mode = script.getAttribute("data-mode") || "inline";
  var container = script.getAttribute("data-container") || "";
  var trigger = script.getAttribute("data-trigger") || (mode === "sidetab" ? "click" : "delay");
  var delay = parseInt(script.getAttribute("data-delay") || "0", 10);
  var scrollPercent = parseInt(script.getAttribute("data-scroll-percent") || "50", 10);
  var suppressDays = parseInt(script.getAttribute("data-suppress-days") || "7", 10);
  var tabLabel = script.getAttribute("data-tab-label") || "Fale Conosco";
  var tabPosition = script.getAttribute("data-tab-position") || "right";

  if (!slug) return;

  // 3. Derive base URL
  var scriptSrc = script.getAttribute("src") || "";
  var origin = "";
  try {
    origin = new URL(scriptSrc).origin;
  } catch (e) {
    origin = window.location.origin;
  }

  var iframeSrc = origin + "/f/" + slug + "?embed=1";

  // Forward parent page UTM params to iframe
  var parentParams = new URLSearchParams(window.location.search);
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (key) {
    var val = parentParams.get(key);
    if (val) iframeSrc += "&" + key + "=" + encodeURIComponent(val);
  });

  var suppressKey = "hnbcrm_suppress_" + slug;

  // Suppression check
  function isSuppressed(): boolean {
    try {
      var stored = localStorage.getItem(suppressKey);
      if (!stored) return false;
      var elapsed = (Date.now() - parseInt(stored, 10)) / 86400000;
      return elapsed < suppressDays;
    } catch (e) {
      return false;
    }
  }

  function setSuppression(): void {
    try {
      localStorage.setItem(suppressKey, Date.now().toString());
    } catch (e) {
      // localStorage unavailable
    }
  }

  // 4. Inject styles
  var style = document.createElement("style");
  style.textContent = [
    // Spinner
    "@keyframes hnbcrm-spin { to { transform: rotate(360deg); } }",
    ".hnbcrm-spinner { width: 32px; height: 32px; border: 3px solid rgba(0,0,0,0.1); border-top-color: #6366f1; border-radius: 50%; animation: hnbcrm-spin 0.8s linear infinite; }",
    ".hnbcrm-loading { display: flex; align-items: center; justify-content: center; min-height: 120px; }",

    // Iframe base
    ".hnbcrm-iframe { border: none; width: 100%; display: block; }",

    // Overlay (popup)
    ".hnbcrm-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999999; display: none; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.25s ease; }",
    ".hnbcrm-overlay.hnbcrm-visible { display: flex; }",
    ".hnbcrm-overlay.hnbcrm-open { opacity: 1; }",

    // Popup container
    ".hnbcrm-popup { position: relative; background: #fff; border-radius: 12px; max-width: 560px; width: 90%; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; }",

    // Close button
    ".hnbcrm-close { position: absolute; top: 8px; right: 8px; z-index: 10; width: 32px; height: 32px; border: none; background: rgba(0,0,0,0.08); border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1; color: #333; transition: background 0.15s; }",
    ".hnbcrm-close:hover { background: rgba(0,0,0,0.15); }",

    // Slidein
    ".hnbcrm-slidein-wrap { position: fixed; bottom: 0; right: 16px; z-index: 999999; width: 400px; max-height: 80vh; display: none; flex-direction: column; transform: translateY(100%); transition: transform 0.3s ease; }",
    ".hnbcrm-slidein-wrap.hnbcrm-visible { display: flex; }",
    ".hnbcrm-slidein-wrap.hnbcrm-open { transform: translateY(0); }",
    ".hnbcrm-slidein-panel { background: #fff; border-radius: 12px 12px 0 0; box-shadow: 0 -4px 24px rgba(0,0,0,0.15); overflow: hidden; display: flex; flex-direction: column; position: relative; flex: 1; max-height: 80vh; }",

    // Sidetab button
    ".hnbcrm-sidetab { position: fixed; z-index: 999998; background: #6366f1; color: #fff; border: none; cursor: pointer; padding: 10px 18px; font-size: 14px; font-weight: 600; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; writing-mode: vertical-rl; letter-spacing: 0.5px; border-radius: 8px 0 0 8px; transition: background 0.15s; }",
    ".hnbcrm-sidetab:hover { background: #4f46e5; }",
    ".hnbcrm-sidetab.hnbcrm-tab-right { right: 0; top: 50%; transform: translateY(-50%) rotate(180deg); border-radius: 8px 0 0 8px; }",
    ".hnbcrm-sidetab.hnbcrm-tab-left { left: 0; top: 50%; transform: translateY(-50%); border-radius: 0 8px 8px 0; }",

    // Responsive
    "@media (max-width: 560px) {",
    "  .hnbcrm-slidein-wrap { width: 100%; right: 0; left: 0; }",
    "  .hnbcrm-popup { width: 100%; max-width: 100%; border-radius: 12px 12px 0 0; max-height: 95vh; }",
    "}",
  ].join("\n");
  document.head.appendChild(style);

  // 5. Build iframe
  var iframe = document.createElement("iframe");
  iframe.src = iframeSrc;
  iframe.className = "hnbcrm-iframe";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("allow", "clipboard-write");

  // Loading spinner
  function createSpinner(): HTMLElement {
    var el = document.createElement("div");
    el.className = "hnbcrm-loading";
    el.innerHTML = '<div class="hnbcrm-spinner"></div>';
    return el;
  }

  // Close button
  function createCloseBtn(onClick: () => void): HTMLElement {
    var btn = document.createElement("button");
    btn.className = "hnbcrm-close";
    btn.setAttribute("aria-label", "Fechar");
    btn.innerHTML = "&#x2715;";
    btn.addEventListener("click", onClick);
    return btn;
  }

  // State
  var isOpen = false;
  var ready = false;
  var openFn: (() => void) | null = null;
  var closeFn: (() => void) | null = null;

  // 6. Create DOM structure based on mode
  if (mode === "inline") {
    var containerEl = container ? document.getElementById(container) : null;
    if (!containerEl) return;

    var spinner = createSpinner();
    containerEl.appendChild(spinner);
    containerEl.appendChild(iframe);
    iframe.style.display = "none";

    openFn = function () {};
    closeFn = function () {};
  } else if (mode === "popup") {
    var overlay = document.createElement("div");
    overlay.className = "hnbcrm-overlay";

    var popupBox = document.createElement("div");
    popupBox.className = "hnbcrm-popup";

    var popupSpinner = createSpinner();
    popupBox.appendChild(popupSpinner);
    popupBox.appendChild(createCloseBtn(function () { close(); }));
    popupBox.appendChild(iframe);
    iframe.style.flex = "1";

    overlay.appendChild(popupBox);
    document.body.appendChild(overlay);

    // Close on overlay click, not on popup click
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    openFn = function () {
      if (isSuppressed()) return;
      overlay.classList.add("hnbcrm-visible");
      // Force reflow for transition
      void overlay.offsetHeight;
      overlay.classList.add("hnbcrm-open");
      isOpen = true;
    };

    closeFn = function () {
      overlay.classList.remove("hnbcrm-open");
      setTimeout(function () {
        overlay.classList.remove("hnbcrm-visible");
      }, 250);
      isOpen = false;
      setSuppression();
    };
  } else if (mode === "slidein") {
    var slideinWrap = document.createElement("div");
    slideinWrap.className = "hnbcrm-slidein-wrap";

    var slideinPanel = document.createElement("div");
    slideinPanel.className = "hnbcrm-slidein-panel";

    var slideinSpinner = createSpinner();
    slideinPanel.appendChild(slideinSpinner);
    slideinPanel.appendChild(createCloseBtn(function () { close(); }));
    slideinPanel.appendChild(iframe);
    iframe.style.flex = "1";

    slideinWrap.appendChild(slideinPanel);
    document.body.appendChild(slideinWrap);

    openFn = function () {
      if (isSuppressed()) return;
      slideinWrap.classList.add("hnbcrm-visible");
      void slideinWrap.offsetHeight;
      slideinWrap.classList.add("hnbcrm-open");
      isOpen = true;
    };

    closeFn = function () {
      slideinWrap.classList.remove("hnbcrm-open");
      setTimeout(function () {
        slideinWrap.classList.remove("hnbcrm-visible");
      }, 300);
      isOpen = false;
      setSuppression();
    };
  } else if (mode === "sidetab") {
    // Tab button
    var tab = document.createElement("button");
    tab.className = "hnbcrm-sidetab hnbcrm-tab-" + tabPosition;
    tab.textContent = tabLabel;

    // Slidein panel for sidetab
    var sidetabWrap = document.createElement("div");
    sidetabWrap.className = "hnbcrm-slidein-wrap";
    if (tabPosition === "left") {
      sidetabWrap.style.right = "auto";
      sidetabWrap.style.left = "16px";
    }

    var sidetabPanel = document.createElement("div");
    sidetabPanel.className = "hnbcrm-slidein-panel";

    var sidetabSpinner = createSpinner();
    sidetabPanel.appendChild(sidetabSpinner);
    sidetabPanel.appendChild(createCloseBtn(function () { close(); }));
    sidetabPanel.appendChild(iframe);
    iframe.style.flex = "1";

    sidetabWrap.appendChild(sidetabPanel);
    document.body.appendChild(sidetabWrap);
    document.body.appendChild(tab);

    tab.addEventListener("click", function () {
      if (isOpen) {
        close();
      } else {
        open();
      }
    });

    openFn = function () {
      if (isSuppressed()) return;
      sidetabWrap.classList.add("hnbcrm-visible");
      void sidetabWrap.offsetHeight;
      sidetabWrap.classList.add("hnbcrm-open");
      isOpen = true;
    };

    closeFn = function () {
      sidetabWrap.classList.remove("hnbcrm-open");
      setTimeout(function () {
        sidetabWrap.classList.remove("hnbcrm-visible");
      }, 300);
      isOpen = false;
      setSuppression();
    };
  }

  function open(): void {
    if (openFn) openFn();
  }

  function close(): void {
    if (closeFn) closeFn();
  }

  // 7. Set up triggers
  if (mode !== "inline") {
    if (trigger === "delay" && delay > 0) {
      setTimeout(function () {
        if (!isOpen) open();
      }, delay * 1000);
    } else if (trigger === "scroll") {
      var scrollFired = false;
      window.addEventListener("scroll", function () {
        if (scrollFired || isOpen) return;
        var scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (scrollHeight <= 0) return;
        var percent = (window.scrollY / scrollHeight) * 100;
        if (percent >= scrollPercent) {
          scrollFired = true;
          open();
        }
      });
    } else if (trigger === "exit_intent") {
      // Desktop: mouseleave at top
      document.addEventListener("mouseleave", function (e: MouseEvent) {
        if (e.clientY <= 0 && !isOpen) {
          open();
        }
      });
      // Mobile: rapid upward swipe
      var touchStartY = 0;
      var touchStartTime = 0;
      document.addEventListener("touchstart", function (e: TouchEvent) {
        if (e.touches.length === 1) {
          touchStartY = e.touches[0].clientY;
          touchStartTime = Date.now();
        }
      });
      document.addEventListener("touchend", function (e: TouchEvent) {
        if (isOpen) return;
        var touchEndY = e.changedTouches[0].clientY;
        var elapsed = Date.now() - touchStartTime;
        var distance = touchStartY - touchEndY;
        if (elapsed < 300 && elapsed > 0 && distance > 0) {
          var velocity = (distance / elapsed) * 1000;
          if (velocity > 500) {
            open();
          }
        }
      });
    } else if (trigger === "click") {
      var clickTargets = document.querySelectorAll('[data-hnbcrm-open="' + slug + '"]');
      for (var i = 0; i < clickTargets.length; i++) {
        clickTargets[i].addEventListener("click", function (e) {
          e.preventDefault();
          if (isOpen) {
            close();
          } else {
            open();
          }
        });
      }
    }

    // Close on Escape key
    document.addEventListener("keydown", function (e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        close();
      }
    });
  }

  // 8. PostMessage listener
  window.addEventListener("message", function (event: MessageEvent) {
    // Validate origin
    if (event.origin !== origin) return;

    var data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "hnbcrm:resize" && typeof data.height === "number") {
      iframe.style.height = data.height + "px";
    } else if (data.type === "hnbcrm:ready") {
      ready = true;
      // Remove spinner(s)
      var spinners = document.querySelectorAll(".hnbcrm-loading");
      for (var s = 0; s < spinners.length; s++) {
        var parent = spinners[s].parentNode;
        if (parent) parent.removeChild(spinners[s]);
      }
      // Show iframe for inline mode
      if (mode === "inline") {
        iframe.style.display = "block";
      }
    } else if (data.type === "hnbcrm:submitted") {
      setSuppression();
      if (mode !== "inline") {
        setTimeout(function () {
          close();
        }, 1500);
      }
    }
  });
})();
