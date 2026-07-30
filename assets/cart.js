/* JP Custom Leatherworks — Storefront API cart + mini-cart drawer.
 *
 * Pages define window.SHOPIFY_CFG = {store, apiVersion, token} (the token is
 * Shopify's PUBLIC storefront token — designed to ship in page source).
 * Product pages call JPCart.add(lines) with Storefront CartLineInput objects;
 * customization picks ride along as line item attributes and show up on
 * Joe's order screen and packing slips. Checkout hands off to Shopify's
 * hosted payment page via cart.checkoutUrl.
 */
(function () {
  var CFG = window.SHOPIFY_CFG;
  if (!CFG) return; // built without a shopify-map: cart disabled

  var KEY = "jp_cart_id";
  var API = "https://" + CFG.store + ".myshopify.com/api/" +
            CFG.apiVersion + "/graphql.json";

  function sf(query, variables) {
    return fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": CFG.token
      },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out.errors) throw new Error(JSON.stringify(out.errors));
      return out.data;
    });
  }

  var CART_FIELDS = "\n" +
    "id\ncheckoutUrl\ntotalQuantity\n" +
    "cost { subtotalAmount { amount currencyCode } }\n" +
    "lines(first: 100) { nodes {\n" +
    "  id\n  quantity\n" +
    "  attributes { key value }\n" +
    "  cost { totalAmount { amount } }\n" +
    "  merchandise { ... on ProductVariant {\n" +
    "    id\n    title\n" +
    "    product { title handle featuredImage { url(transform:{maxWidth:120,maxHeight:120}) } }\n" +
    "  } }\n" +
    "} }\n";

  var Q_GET = "query($id: ID!) { cart(id: $id) {" + CART_FIELDS + "} }";
  var M_CREATE = "mutation($lines: [CartLineInput!]!) {\n" +
    "cartCreate(input: {lines: $lines}) {\n" +
    "  cart {" + CART_FIELDS + "} userErrors { field message } } }";
  var M_ADD = "mutation($id: ID!, $lines: [CartLineInput!]!) {\n" +
    "cartLinesAdd(cartId: $id, lines: $lines) {\n" +
    "  cart {" + CART_FIELDS + "} userErrors { field message } } }";
  var M_REMOVE = "mutation($id: ID!, $lineIds: [ID!]!) {\n" +
    "cartLinesRemove(cartId: $id, lineIds: $lineIds) {\n" +
    "  cart {" + CART_FIELDS + "} userErrors { field message } } }";

  var cart = null;

  function money(a) {
    var n = Math.round(parseFloat(a) * 100) / 100;
    return "$" + n.toFixed(2).replace(/\.00$/, "");
  }

  // ---------------- drawer UI (injected so every page gets it) -------------
  var css = "" +
    ".jpc-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:80;opacity:0;pointer-events:none;transition:opacity .25s}" +
    ".jpc-ov.on{opacity:1;pointer-events:auto}" +
    ".jpc{position:fixed;top:0;right:0;bottom:0;width:min(430px,94vw);background:#1c1c1c;color:#fff;z-index:81;transform:translateX(105%);transition:transform .28s;display:flex;flex-direction:column;border-left:1px solid rgba(255,255,255,.14);font-family:Jost,system-ui,sans-serif}" +
    ".jpc.on{transform:none}" +
    ".jpc-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.14)}" +
    ".jpc-head h3{font-family:Bevan,serif;color:#f7b829;font-size:1.05rem;margin:0}" +
    ".jpc-x{background:none;border:0;color:#fff;font-size:1.6rem;cursor:pointer;line-height:1}" +
    ".jpc-body{flex:1;overflow:auto;padding:8px 20px}" +
    ".jpc-line{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.08)}" +
    ".jpc-img{width:56px;height:56px;border-radius:8px;object-fit:cover;background:#242424;flex:none}" +
    ".jpc-noimg{width:56px;height:56px;border-radius:8px;background:repeating-linear-gradient(45deg,#3a3a3a 0 4px,#2b2b2b 4px 8px);flex:none}" +
    ".jpc-mid{flex:1;min-width:0}" +
    ".jpc-t{font-weight:600;font-size:.9rem;line-height:1.3}" +
    ".jpc-attrs{margin-top:4px;font-size:.72rem;color:#9b9b9b;line-height:1.5}" +
    ".jpc-attrs span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".jpc-subs{margin-top:6px;border-left:2px solid rgba(247,184,41,.4);padding-left:8px}" +
    ".jpc-sub-line{display:flex;justify-content:space-between;gap:8px;font-size:.75rem;color:#c9c9c9;line-height:1.6}" +
    ".jpc-sub-p{color:#f7b829;flex:none}" +
    ".jpc-right{text-align:right;flex:none}" +
    ".jpc-p{color:#f7b829;font-weight:700;font-size:.9rem}" +
    ".jpc-rm{background:none;border:0;color:#9b9b9b;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;margin-top:8px;padding:0}" +
    ".jpc-rm:hover{color:#fff}" +
    ".jpc-empty{padding:44px 10px;text-align:center;color:#9b9b9b;font-size:.9rem}" +
    ".jpc-foot{padding:16px 20px 20px;border-top:1px solid rgba(255,255,255,.14)}" +
    ".jpc-sub{display:flex;justify-content:space-between;font-size:.95rem;margin-bottom:6px}" +
    ".jpc-sub b{color:#f7b829}" +
    ".jpc-note{font-size:.72rem;color:#9b9b9b;margin-bottom:12px}" +
    ".jpc-go{display:block;width:100%;text-align:center;background:#f7b829;color:#1c1500;font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:.8rem;border:0;border-radius:200px;padding:13px 0;cursor:pointer;text-decoration:none}" +
    ".jpc-go:hover{background:#ffca4a}" +
    ".jpc-go[aria-disabled=true]{opacity:.4;pointer-events:none}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var ov = document.createElement("div");
  ov.className = "jpc-ov";
  var panel = document.createElement("aside");
  panel.className = "jpc";
  panel.setAttribute("aria-label", "Shopping cart");
  panel.innerHTML =
    '<div class="jpc-head"><h3>Your Cart</h3>' +
    '<button class="jpc-x" aria-label="Close cart">&times;</button></div>' +
    '<div class="jpc-body" id="jpcBody"></div>' +
    '<div class="jpc-foot">' +
    '<div class="jpc-sub"><span>Subtotal</span><b id="jpcSub">$0</b></div>' +
    '<div class="jpc-note">Free standard shipping &middot; taxes calculated at checkout</div>' +
    '<a class="jpc-go" id="jpcGo" aria-disabled="true" href="#">Checkout</a></div>';
  document.body.appendChild(ov);
  document.body.appendChild(panel);

  function open() { ov.classList.add("on"); panel.classList.add("on"); }
  function close() { ov.classList.remove("on"); panel.classList.remove("on"); }
  ov.addEventListener("click", close);
  panel.querySelector(".jpc-x").addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });

  function render() {
    var body = document.getElementById("jpcBody");
    var go = document.getElementById("jpcGo");
    var lines = cart ? cart.lines.nodes : [];
    document.querySelectorAll(".cart-pill").forEach(function (el) {
      el.textContent = "Cart · " + (cart ? cart.totalQuantity : 0);
    });
    document.getElementById("jpcSub").textContent =
      cart ? money(cart.cost.subtotalAmount.amount) : "$0";
    if (!lines.length) {
      body.innerHTML = '<div class="jpc-empty">Your cart is empty.</div>';
      go.setAttribute("aria-disabled", "true");
      go.href = "#";
      return;
    }
    go.removeAttribute("aria-disabled");
    go.href = cart.checkoutUrl;

    // Add-on lines (attribute "For: <parent product title>") fold under
    // their parent visually. Shopify still sees separate lines — checkout
    // shows them separately, which is also what Joe's order screen charges.
    var mains = [], extras = {};
    lines.forEach(function (l) {
      var parent = null;
      l.attributes.forEach(function (a) {
        if (a.key === "For") parent = a.value;
      });
      if (parent !== null) (extras[parent] = extras[parent] || []).push(l);
      else mains.push(l);
    });

    function lineHtml(l, addons) {
      var m = l.merchandise;
      var img = m.product.featuredImage
        ? '<img class="jpc-img" src="' + m.product.featuredImage.url + '" alt="">'
        : '<div class="jpc-noimg"></div>';
      var title = m.product.title +
        (m.title && m.title !== "Default Title" ? " — " + m.title : "");
      var total = parseFloat(l.cost.totalAmount.amount);
      addons.forEach(function (a) {
        total += parseFloat(a.cost.totalAmount.amount);
      });
      var subs = addons.map(function (a) {
        return '<div class="jpc-sub-line"><span>' + esc(a.merchandise.title) +
          '</span><span class="jpc-sub-p">+' +
          money(a.cost.totalAmount.amount) + "</span></div>";
      }).join("");
      var attrs = l.attributes.map(function (a) {
        return "<span>" + esc(a.key) + ": " + esc(a.value) + "</span>";
      }).join("");
      var ids = [l.id].concat(addons.map(function (a) { return a.id; }));
      return '<div class="jpc-line">' + img +
        '<div class="jpc-mid"><div class="jpc-t">' + esc(title) + "</div>" +
        (subs ? '<div class="jpc-subs">' + subs + "</div>" : "") +
        (attrs ? '<div class="jpc-attrs">' + attrs + "</div>" : "") + "</div>" +
        '<div class="jpc-right"><div class="jpc-p">' + money(total) + "</div>" +
        '<button class="jpc-rm" data-lines="' + ids.join(",") + '">Remove</button>' +
        "</div></div>";
    }

    var out = mains.map(function (l) {
      var addons = extras[l.merchandise.product.title] || [];
      delete extras[l.merchandise.product.title];
      return lineHtml(l, addons);
    }).join("");
    // orphaned add-ons (parent line already removed) render standalone
    Object.keys(extras).forEach(function (k) {
      extras[k].forEach(function (l) { out += lineHtml(l, []); });
    });
    body.innerHTML = out;

    body.querySelectorAll(".jpc-rm").forEach(function (b) {
      b.addEventListener("click", function () {
        mutate(M_REMOVE, { id: cart.id, lineIds: b.dataset.lines.split(",") },
               "cartLinesRemove");
      });
    });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function setCart(c) {
    cart = c;
    if (c) localStorage.setItem(KEY, c.id);
    render();
  }

  function mutate(m, vars, field) {
    return sf(m, vars).then(function (d) {
      var out = d[field];
      if (out.userErrors && out.userErrors.length) {
        console.error("cart error", out.userErrors);
        alert("Sorry — that didn't make it into the cart. Please try again.");
        return;
      }
      setCart(out.cart);
      return out.cart;
    });
  }

  function load() {
    var id = localStorage.getItem(KEY);
    if (!id) { render(); return; }
    sf(Q_GET, { id: id }).then(function (d) {
      if (!d.cart) localStorage.removeItem(KEY); // completed or expired
      cart = d.cart;
      render();
    }).catch(function () { render(); });
  }

  window.JPCart = {
    open: open,
    /** lines: [{merchandiseId, quantity, attributes:[{key,value}]}] */
    add: function (lines) {
      var id = localStorage.getItem(KEY);
      var p = id
        ? mutate(M_ADD, { id: id, lines: lines }, "cartLinesAdd")
        : mutate(M_CREATE, { lines: lines }, "cartCreate");
      return p.then(function (c) {
        // stale stored id (completed checkout) -> start a fresh cart
        if (!c && id) {
          localStorage.removeItem(KEY);
          return mutate(M_CREATE, { lines: lines }, "cartCreate");
        }
        return c;
      }).then(function (c) { if (c) open(); return c; });
    }
  };

  document.querySelectorAll(".cart-pill").forEach(function (el) {
    el.addEventListener("click", function (e) { e.preventDefault(); open(); });
  });
  load();
})();
