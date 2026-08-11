/**
 * PartnerLoop storefront attribution.
 *
 * ?ref=<code>  →  first-party cookie  →  cart attribute  →  order
 *
 * The cookie alone can't earn anyone a commission: Shopify's order webhook
 * receives an order, not the shopper's browser state. Copying the code onto the
 * cart is what carries it through checkout and onto the order, where a later
 * phase reads it back.
 *
 * Written as ES5-ish, dependency-free, and defensive — this runs on every page
 * of a merchant's storefront and must never break their theme.
 */
(function () {
  "use strict";

  var REF_PARAM = "ref";
  var REF_COOKIE = "_pl_ref";
  var VISITOR_COOKIE = "_pl_vid";
  // Underscore-prefixed so themes that render cart attributes keep it hidden.
  var CART_ATTRIBUTE = "_pl_ref";
  // Same code, carried as a hidden line item property. Dynamic checkout buttons
  // ("Buy it now", Shop Pay, PayPal express) submit the product form straight to
  // checkout without ever creating a cart, so the cart attribute alone loses
  // those orders entirely. Form properties do survive that path.
  var LINE_PROPERTY = "properties[" + CART_ATTRIBUTE + "]";
  var PRODUCT_FORM_SELECTOR = 'form[action*="/cart/add"]';
  var VISITOR_COOKIE_DAYS = 365;

  var script =
    document.currentScript || document.querySelector("script[data-partnerloop-tracking]");

  var proxyBase = (script && script.getAttribute("data-proxy-base")) || "/apps/partnerloop";
  var windowDays = parseInt((script && script.getAttribute("data-window-days")) || "30", 10);
  if (!isFinite(windowDays) || windowDays <= 0) windowDays = 30;

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].trim();
      if (pair.indexOf(name + "=") === 0) {
        return decodeURIComponent(pair.substring(name.length + 1));
      }
    }
    return null;
  }

  function writeCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 86400000).toUTCString();
    var secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      name +
      "=" +
      encodeURIComponent(value) +
      "; expires=" +
      expires +
      "; path=/; SameSite=Lax" +
      secure;
  }

  function visitorId() {
    var existing = readCookie(VISITOR_COOKIE);
    if (existing) return existing;

    var id;
    try {
      id = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : null;
    } catch (error) {
      id = null;
    }
    if (!id) {
      id = "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }

    writeCookie(VISITOR_COOKIE, id, VISITOR_COOKIE_DAYS);
    return id;
  }

  /** Fire-and-forget: the shopper's page must not wait on our beacon. */
  function reportClick(code, visitor) {
    try {
      fetch(proxyBase + "/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify({
          ref: code,
          visitorId: visitor,
          landingPage: window.location.pathname + window.location.search,
          referrer: document.referrer || null,
        }),
      }).catch(function () {});
    } catch (error) {
      /* Tracking must never surface an error on a merchant's storefront. */
    }
  }

  /**
   * Keep the cart attribute in step with the cookie.
   *
   * Re-checked on every page load rather than written once, because Shopify
   * hands out a new cart when the old one is cleared or expires — which would
   * silently drop the attribution. Reading /cart.js first keeps this to a single
   * GET in the common case, and only writes when the value is actually wrong.
   */
  function syncCartAttribute(code) {
    fetch("/cart.js", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (cart) {
        if (!cart) return null;
        if (cart.attributes && cart.attributes[CART_ATTRIBUTE] === code) return null;

        var attributes = {};
        attributes[CART_ATTRIBUTE] = code;

        return fetch("/cart/update.js", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ attributes: attributes }),
        });
      })
      .catch(function () {});
  }

  /**
   * Stamp the code onto every product form as a hidden line item property.
   *
   * This is what covers dynamic checkout. Underscore-prefixed properties are
   * hidden from the shopper in cart, checkout and order confirmation, but still
   * arrive on the order where the webhook can read them.
   */
  function tagProductForms(code) {
    var forms = document.querySelectorAll(PRODUCT_FORM_SELECTOR);

    for (var i = 0; i < forms.length; i += 1) {
      var form = forms[i];
      var existing = form.querySelector('input[name="' + LINE_PROPERTY + '"]');

      if (existing) {
        existing.value = code;
        continue;
      }

      var input = document.createElement("input");
      input.type = "hidden";
      input.name = LINE_PROPERTY;
      input.value = code;
      form.appendChild(input);
    }
  }

  /**
   * Themes render product forms lazily — quick-add modals, infinite scroll,
   * section re-renders. Re-stamp when the DOM changes, debounced so a busy page
   * doesn't turn this into a hot loop.
   */
  function watchForProductForms(code) {
    if (typeof MutationObserver !== "function") return;

    var pending = null;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () {
        pending = null;
        tagProductForms(code);
      }, 200);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (error) {
      return;
    }

    var incoming = (params.get(REF_PARAM) || "").trim();
    var code = readCookie(REF_COOKIE);

    if (incoming) {
      // Last-click attribution: a fresh ?ref= always replaces whatever was
      // stored and restarts the window, so the most recent creator gets credit.
      code = incoming;
      writeCookie(REF_COOKIE, code, windowDays);
      reportClick(code, visitorId());
    }

    if (code) {
      // Two independent carriers, because a shopper reaches checkout by two
      // different routes: through the cart, or straight past it via a dynamic
      // checkout button.
      syncCartAttribute(code);
      tagProductForms(code);
      watchForProductForms(code);
    }
  }

  try {
    start();
  } catch (error) {
    /* Never let attribution take a storefront page down with it. */
  }
})();
