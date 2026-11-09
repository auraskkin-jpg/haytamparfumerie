(() => {
  "use strict";

  const storageKey = "aura-skin-local-cart-v1";
  const analyticsConsentKey = "aura-analytics-consent-v1";
  const analyticsSessionKey = "aura-analytics-session-v1";
  let analyticsEnabled = false;
  let analyticsListenersInstalled = false;
  const money = (amount) => `${Number(amount).toLocaleString("fr-MA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} DH`;

  function readCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(saved) ? saved.filter((item) => item && item.id && Number(item.quantity) > 0) : [];
    } catch {
      return [];
    }
  }

  function saveCart(cart) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cart));
      return true;
    } catch {
      showMessage("Le navigateur ne permet pas de sauvegarder le panier.");
      return false;
    }
  }

  function productDetails() {
    const title = document.querySelector(".product__title h1")?.textContent.trim()
      || document.querySelector("main h1")?.textContent.trim()
      || "Nom du produit";
    const priceText = document.querySelector(".price--large .price-item--regular")?.textContent || "";
    const priceMatch = priceText.replace(/\s/g, "").match(/\d+(?:[.,]\d{1,2})?/);
    return {
      id: window.location.pathname,
      title,
      price: priceMatch ? Number(priceMatch[0].replace(",", ".")) : NaN,
      href: window.location.pathname,
    };
  }

  function showMessage(text) {
    let message = document.querySelector(".local-cart-message");
    if (!message) {
      message = document.createElement("div");
      message.className = "local-cart-message";
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      document.body.append(message);
    }
    message.textContent = text;
    message.classList.add("is-visible");
    window.clearTimeout(showMessage.timer);
    showMessage.timer = window.setTimeout(() => message.classList.remove("is-visible"), 2800);
  }

  function setCartCount(cart) {
    const cartLink = document.querySelector("#cart-icon-bubble");
    if (!cartLink) return;
    let badge = cartLink.querySelector(".local-cart-count");
    const count = cart.reduce((total, item) => total + Number(item.quantity), 0);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "local-cart-count";
      cartLink.append(badge);
    }
    badge.textContent = String(count);
    badge.style.display = count === 0 ? "none" : "grid";
    badge.setAttribute("aria-label", `${count} article${count === 1 ? "" : "s"} dans le panier`);
  }

  function addProduct(product, quantity = 1) {
    if (!Number.isFinite(product.price) || product.price < 0) {
      showMessage("Ajoute d'abord un prix au produit.");
      return false;
    }
    const cart = readCart();
    const existing = cart.find((item) => item.id === product.id);
    if (existing) existing.quantity += quantity;
    else cart.push({ ...product, quantity });
    if (!saveCart(cart)) return false;
    setCartCount(cart);
    showMessage("Produit ajoute au panier.");
    return true;
  }

  function updateCartPage() {
    const list = document.querySelector("#main-cart-items .js-contents");
    if (!list) return;
    const cart = readCart();
    const isEmpty = cart.length === 0;
    const cartItems = document.querySelector("cart-items");
    const footer = document.querySelector("#main-cart-footer");
    const form = document.querySelector("#cart.cart__contents");
    cartItems?.classList.toggle("is-empty", isEmpty);
    footer?.classList.toggle("is-empty", isEmpty);
    form?.classList.toggle("critical-hidden", isEmpty);
    list.replaceChildren();

    for (const item of cart) {
      const row = document.createElement("article");
      row.className = "local-cart-row";

      const image = document.createElement("span");
      image.className = "template-image-placeholder local-cart-image";
      image.textContent = "Image a ajouter";
      image.setAttribute("aria-label", "Image a ajouter");

      const details = document.createElement("div");
      details.className = "local-cart-details";
      const title = document.createElement("a");
      title.href = item.href;
      title.textContent = item.title;
      const price = document.createElement("p");
      price.textContent = money(item.price);
      const controls = document.createElement("div");
      controls.className = "local-cart-controls";
      const quantity = document.createElement("input");
      quantity.type = "number";
      quantity.min = "1";
      quantity.max = "99";
      quantity.value = String(item.quantity);
      quantity.setAttribute("aria-label", `Quantite de ${item.title}`);
      quantity.dataset.localCartQuantity = item.id;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Supprimer";
      remove.dataset.localCartRemove = item.id;
      controls.append(quantity, remove);
      details.append(title, price, controls);

      const total = document.createElement("strong");
      total.className = "local-cart-line-total";
      total.textContent = money(item.price * item.quantity);
      row.append(image, details, total);
      list.append(row);
    }

    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const totalElement = document.querySelector("#main-cart-footer .totals__total-value");
    if (totalElement) totalElement.textContent = money(total);
    const checkout = document.querySelector("#checkout");
    if (checkout) {
      checkout.disabled = true;
      checkout.textContent = "Paiement en ligne indisponible";
    }
    setCartCount(cart);
  }

  function setProductImage(placeholder, product) {
    if (!placeholder || !product.imagePath) return;
    const image = document.createElement("img");
    image.src = product.imagePath;
    image.alt = product.name;
    image.loading = "lazy";
    image.decoding = "async";
    image.style.cssText = "display:block;width:100%;height:100%;object-fit:cover";
    placeholder.replaceWith(image);
  }

  function hideStaticBadges(root) {
    root.querySelectorAll(".price__badge-sale, .price__badge-sold-out").forEach((badge) => {
      badge.classList.add("hidden");
    });
    root.querySelectorAll(".badge").forEach((badge) => {
      if (/épuisé|sold\s*out/i.test((badge.textContent || "").trim())) {
        badge.textContent = "";
        badge.classList.add("hidden");
      }
    });
    root.querySelectorAll(".price--sold-out").forEach((node) => node.classList.remove("price--sold-out"));
  }

  function showProductFlagBadge(node, product) {
    if (!product.soldOut && !product.promo) return;
    const holder = node.querySelector(".card__badge") || (() => {
      const spot = document.createElement("div");
      spot.className = "card__badge bottom left";
      (node.querySelector(".card__inner") || node).append(spot);
      return spot;
    })();
    const badge = document.createElement("span");
    badge.className = "badge badge--bottom-left color-inverse";
    badge.textContent = product.soldOut ? "Épuisé" : "Promo";
    holder.append(badge);
  }

  function showProductPageFlagBadges(product) {
    const soldBadge = document.querySelector(".price__badge-sold-out");
    const saleBadge = document.querySelector(".price__badge-sale");
    if (soldBadge) {
      soldBadge.classList.toggle("hidden", !product.soldOut);
    }
    if (saleBadge) {
      saleBadge.classList.toggle("hidden", !product.promo);
      return;
    }
    if (!product.soldOut && !product.promo) return;
    const price = document.querySelector(".dynamic-product-info .price--large");
    if (!price || price.querySelector(".page-flag")) return;
    const badge = document.createElement("span");
    badge.className = `badge page-flag${product.soldOut ? " page-flag--soldout" : " page-flag--promo"}`;
    badge.textContent = product.soldOut ? "Épuisé" : "Promo";
    price.append(" ", badge);
  }

  function unhideFilled(node) {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (n.style.display === "none") n.style.display = "";
    }
  }

  function fillProductCard(card, product) {
    // Si le masquage des emplacements vides a déjà eu lieu, on rouvre la carte, sa liste et sa section.
    const holder = card.closest("li") || card.closest(".product-card-wrapper") || card;
    holder.style.display = "";
    const wrapper = card.closest(".product-card-wrapper, .card-wrapper");
    if (wrapper && wrapper.style.display === "none") wrapper.style.display = "";
    const list = holder.closest("ul");
    if (list && list.style.display === "none") list.style.display = "";
    const block = list ? list.closest(".shopify-section") : null;
    if (block && block.style.display === "none") block.style.display = "";
    card.querySelectorAll(".card__heading a").forEach((link) => {
      link.href = `/product/${encodeURIComponent(product.slug)}`;
      link.textContent = product.name;
    });
    card.querySelectorAll(".price-item").forEach((price) => {
      price.textContent = money(product.price);
      unhideFilled(price);
    });
    if (product.imagePath) {
      card.querySelectorAll(".card__media .template-image-placeholder, .card__media img").forEach((media) => {
        setProductImage(media, product);
      });
    } else {
      // Sans photo : aucun cadre blanc — le carré « ratio » du thème est masqué aussi.
      card.querySelectorAll(".card__inner, .card__media, .template-image-placeholder").forEach((media) => {
        media.style.display = "none";
      });
    }
    hideStaticBadges(card);
    showProductFlagBadge(card, product);
  }

  function fillProductPage(product) {
    document.title = `${product.name} | Aura Skin`;
    document.querySelectorAll("#dynamic-product-name, .product__title h1, .product__title h2").forEach((title) => {
      title.textContent = product.name;
      unhideFilled(title);
    });
    document.querySelectorAll("#dynamic-product-brand, .product__text.subtitle").forEach((brand) => {
      brand.textContent = product.brand || "";
      unhideFilled(brand);
    });
    document.querySelectorAll("#dynamic-product-price, .price--large .price-item, .price-item--regular").forEach((price) => {
      price.textContent = money(product.price);
      unhideFilled(price);
    });
    document.querySelectorAll("#dynamic-product-description, .product__description").forEach((description) => {
      description.textContent = product.description;
      unhideFilled(description);
    });
    if (product.imagePath) {
      document.querySelectorAll("#dynamic-product-image, .product__media-item .template-image-placeholder, .product__media img").forEach((image) => {
        setProductImage(image, product);
      });
    } else {
      document.querySelectorAll(".product__media-item, .product__media, #dynamic-product-image").forEach((media) => {
        media.style.display = "none";
      });
    }
    hideStaticBadges(document.querySelector("product-info") || document.body);
    showProductPageFlagBadges(product);
    const codButton = document.querySelector("#CodPopupOpen");
    if (codButton) {
      if (product.name) codButton.dataset.productTitle = product.name;
      if (Number.isFinite(product.price)) codButton.dataset.price = product.price.toFixed(2);
      if (product.imagePath) codButton.dataset.productImage = product.imagePath;
    }
  }

  async function loadBackendProducts() {
    if (!/^https?:$/.test(window.location.protocol)) return;
    const path = window.location.pathname;
    const productPath = path.match(/^\/(?:product|products)\/([^/]+?)(?:\.html)?\/?$/);
    if (productPath) {
      const slug = decodeURIComponent(productPath[1]);
      try {
        const response = await fetch(`/api/products/${encodeURIComponent(slug)}`, { credentials: "same-origin" });
        if (response.ok) fillProductPage(await response.json());
      } catch {
        // Keep the static product placeholders if the local backend is unavailable.
      }
      return;
    }

    const collectionPath = path.match(/^\/collections\/([^/]+?)(?:\.html)?\/?$/);
    const endpoint = collectionPath
      ? `/api/products?category=${encodeURIComponent(decodeURIComponent(collectionPath[1]).toLowerCase())}`
      : "/api/products";
    try {
      const response = await fetch(endpoint, { credentials: "same-origin" });
      if (!response.ok) return;
      const products = await response.json();
      if (!products.length) return;
      const cards = [...document.querySelectorAll(".product-card-wrapper")];
      cards.slice(0, products.length).forEach((card, index) => fillProductCard(card, products[index]));
      cards.slice(products.length)
        .filter((card) => card.querySelector(".card__heading a")?.textContent.trim() === "Nom du produit")
        .forEach((card) => { card.style.display = "none"; });
    } catch {
      // Keep the static product placeholders if the local backend is unavailable.
    }
  }

  function contentPagePath() {
    let path = window.location.pathname.replace(/^\/+/, "");
    if (!path || path.endsWith("/")) path += "index.html";
    else if (!/\.[a-z0-9]+$/i.test(path)) path += ".html";
    return path;
  }

  function hideEmptyImageSlots() {
    document.querySelectorAll(".template-image-placeholder:not(.cms-filled)").forEach((slot) => {
      slot.style.display = "none";
      const container = slot.closest("li, .product-card-wrapper, .card-wrapper, .slideshow__slide, .hp-bslider__slide, .collection-banner-tile, .hp-banner, .image-content, .media-wrapper");
      if (container && !container.innerText.trim()) container.style.display = "none";
    });
    // Cartes du thème non remplies : « Nom du produit / Prix à ajouter » ne sont que du texte du modèle.
    document.querySelectorAll(".card__heading").forEach((heading) => {
      if (heading.textContent.trim() !== "Nom du produit") return;
      const card = heading.closest("li") || heading.closest(".product-card-wrapper, .card-wrapper");
      if (card) card.style.display = "none";
    });
    document.querySelectorAll(".price").forEach((price) => {
      if (price.textContent.trim() !== "Prix à ajouter") return;
      const card = price.closest("li") || price.closest(".product-card-wrapper, .card-wrapper");
      if (card) card.style.display = "none";
    });
    // Sections de diaporama entièrement vides (aucune photo remplie, aucun texte).
    document.querySelectorAll(".slideshow, .hp-bslider").forEach((section) => {
      if (section.querySelector(".template-image-placeholder.cms-filled")) return;
      const placeholders = [...section.querySelectorAll(".template-image-placeholder")];
      if (!placeholders.length || placeholders.some((slot) => slot.style.display !== "none")) return;
      if (section.innerText.trim()) return;
      section.style.display = "none";
    });
    // Tout texte du modèle finissant par « à ajouter » disparaît, avec son conteneur si vide à côté.
    document.querySelectorAll("body *").forEach((node) => {
      if (node.children.length) return;
      const text = node.textContent.trim();
      if (!text || text.length > 90 || !text.endsWith("à ajouter")) return;
      node.style.display = "none";
      const parent = node.parentElement;
      if (parent && parent.textContent.trim() === text) parent.style.display = "none";
    });
    // Pages collection : le squelette « boutique » du modèle (filtres, tri, compteurs et
    // pagination) n'est pas relié au vrai catalogue — il s'efface, seuls les produits restent.
    if (/^\/collections\//.test(window.location.pathname)) {
      document.querySelectorAll([
        "[id^='FacetsWrapper']",
        "[id^='FacetFiltersForm']",
        ".facets-container",
        "facet-filters-form",
        ".facet-filters",
        ".active-facets",
        ".mobile-facets",
        ".product-count",
        ".pagination-wrapper",
      ].join(", ")).forEach((node) => {
        node.style.display = "none";
      });
    }
    // Carrousels dont toutes les cartes sont masquées : on cache la liste et ses flèches.
    document.querySelectorAll("ul").forEach((list) => {
      const items = [...list.children];
      if (!items.length || items.some((item) => item.style.display !== "none")) return;
      const section = list.closest(".shopify-section, section") || list;
      list.style.display = "none";
      section.querySelectorAll(".slider-buttons, [class*='slider-controls']").forEach((controls) => {
        controls.style.display = "none";
      });
    });
    // Dernier passage : une section sans contenu réel disparaît, titres fantômes compris
    // (« Nouveautés », « LATTAFA PARFUMS », bouton « Tout afficher »…).
    document.querySelectorAll(".shopify-section").forEach((section) => {
      if (section.style.display === "none") return;
      const structural = (node) => {
        if (node.classList.contains("aura-image-blocks")) return false;
        if (node.offsetParent === null || getComputedStyle(node).display === "none") return true;
        if (!node.children.length) {
          const text = node.textContent.trim();
          if (!text) return true;
          const lowered = text.toLowerCase();
          if (["tout afficher", "tout voir", "view all"].includes(lowered) || ["‹", "›", "❮", "❯", "→"].includes(text)) return true;
          return !!node.closest("h1, h2, h3, h4, h5, h6, .collection__title, .title") && text.length <= 90;
        }
        return [...node.children].every(structural);
      };
      if (structural(section)) section.style.display = "none";
    });
  }

  async function renderImageBlocks() {
    try {
      const response = await fetch(`/api/cms/blocks?page=${encodeURIComponent(contentPagePath())}`, { credentials: "same-origin" });
      if (!response.ok) return;
      const blocks = await response.json();
      if (!Array.isArray(blocks) || !blocks.length) return;
      const main = document.querySelector("#MainContent") || document.querySelector("main") || document.body;
      const top = blocks.filter((block) => block.position !== "bottom");
      const bottom = blocks.filter((block) => block.position === "bottom");
      if (top.length) main.prepend(imageBlockSection(top));
      if (bottom.length) main.append(imageBlockSection(bottom));
    } catch {
      // Le site reste normal si les images publiées sont indisponibles.
    }
  }

  function imageBlockSection(blocks) {
    // Les bannières et les photos ne se mélangent pas : chaque groupe suit l'ordre 1-2-3.
    const fragment = document.createDocumentFragment();
    let group = null;
    const flush = () => {
      if (!group) return;
      const section = document.createElement("section");
      section.className = "aura-image-blocks" + (group.hero ? " aura-image-blocks--hero" : "");
      for (const node of group.nodes) section.append(node);
      fragment.append(section);
      group = null;
    };
    for (const block of blocks) {
      const hero = block.style === "hero";
      if (group && group.hero !== hero && group.nodes.length) flush();
      if (!group) group = { hero, nodes: [] };
      const image = document.createElement("img");
      image.src = block.image_path;
      image.alt = block.alt || "";
      image.loading = "lazy";
      image.decoding = "async";
      if (block.link) {
        const link = document.createElement("a");
        link.href = block.link;
        if (/^https:/.test(block.link)) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        link.append(image);
        group.nodes.push(link);
      } else {
        group.nodes.push(image);
      }
    }
    flush();
    return fragment;
  }

  async function applySiteContent() {
    if (!document.querySelector("[data-cms-text], [data-cms-image]")) return;
    try {
      const response = await fetch(`/api/cms/content?page=${encodeURIComponent(contentPagePath())}`, { credentials: "same-origin" });
      if (!response.ok) return;
      const content = await response.json();
      document.querySelectorAll("[data-cms-text]").forEach((element) => {
        const value = content.texts[element.dataset.cmsText];
        if (value) element.textContent = value;
      });
      document.querySelectorAll("[data-cms-image]").forEach((element) => {
        const value = content.images[element.dataset.cmsImage];
        if (!value) return;
        if (element.matches("a, button")) {
          const thumb = document.createElement("img");
          thumb.src = value;
          thumb.alt = "";
          thumb.className = "cms-nav-thumb";
          element.prepend(thumb);
          return;
        }
        element.classList.add("cms-filled");
        element.style.backgroundImage = `url("${value}")`;
        element.textContent = "";
      });
    } catch {
      // Keep the original placeholders if the backend is unavailable.
    }
  }

  function renderStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .aura-image-blocks{display:flex;flex-wrap:wrap;gap:18px;justify-content:center;align-items:center;padding:28px 5%;margin:0}
      .aura-image-blocks figure,.aura-image-blocks a{margin:0;display:block}
      .aura-image-blocks img{display:block;max-width:100%;height:auto;max-height:520px;border-radius:14px;object-fit:contain;cursor:pointer}
      .aura-image-blocks--hero{display:block;padding:0;margin:0}
      .aura-image-blocks--hero a,.aura-image-blocks--hero figure{width:100%}
      .aura-image-blocks--hero img{width:100%;height:min(78vh,660px);min-height:300px;max-height:none;border-radius:0;object-fit:cover}
      .cms-nav-thumb{width:26px;height:26px;object-fit:cover;border-radius:50%;margin-right:8px;vertical-align:middle;display:inline-block}
      .template-image-placeholder.cms-filled{background-size:cover;background-position:center;background-repeat:no-repeat;border:0;color:transparent;font-size:0}
      .local-cart-count{position:absolute;top:0;right:0;min-width:18px;height:18px;padding:0 4px;display:grid;place-items:center;border-radius:50%;background:#c64f67;color:#fff;font:700 11px/1 sans-serif}
      .local-cart-message{position:fixed;right:20px;bottom:20px;z-index:2000;padding:12px 18px;background:#292421;color:#fff;font:14px/1.4 sans-serif;opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;pointer-events:none}
      .local-cart-message.is-visible{opacity:1;transform:translateY(0)}
      .local-cart-row{display:grid;grid-template-columns:100px minmax(0,1fr) auto;gap:18px;align-items:center;padding:18px 0;border-bottom:1px solid #e8dfd9}
      .local-cart-image{width:100px;aspect-ratio:1/1}
      .local-cart-details>a{font-weight:600}
      .local-cart-details>p{margin:6px 0}
      .local-cart-controls{display:flex;align-items:center;gap:10px}
      .local-cart-controls input{width:64px;min-height:38px;padding:6px;border:1px solid #bbb;text-align:center}
      .local-cart-controls button{border:0;background:transparent;text-decoration:underline;cursor:pointer}
      .local-cart-line-total{white-space:nowrap}
      #cart-icon-bubble{position:relative}
      .analytics-consent-banner{position:fixed;right:16px;bottom:16px;left:16px;z-index:3000;max-width:760px;margin:0 auto;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid #e4c4bf;background:#fff;color:#292421;box-shadow:0 12px 40px rgba(50,30,28,.16);font:13px/1.45 sans-serif}
      .analytics-consent-copy{margin:0;max-width:460px}
      .analytics-consent-actions{display:flex;flex-wrap:wrap;gap:8px}
      .analytics-consent-actions button{min-height:38px;padding:0 13px;border:1px solid #292421;background:#292421;color:#fff;font:700 12px/1 sans-serif;cursor:pointer}
      .analytics-consent-actions button[data-choice="reject"]{background:#fff;color:#292421}
      .analytics-preferences{margin:18px auto 0;padding:6px;border:0;background:transparent;color:#766d67;font:11px/1.4 sans-serif;text-decoration:underline;cursor:pointer}
      @media(max-width:600px){.local-cart-row{grid-template-columns:72px minmax(0,1fr);gap:12px}.local-cart-image{width:72px}.local-cart-line-total{grid-column:2}}
      @media(max-width:600px){.analytics-consent-banner{align-items:stretch;flex-direction:column;gap:12px}.analytics-consent-actions button{flex:1}}
    `;
    document.head.append(style);
  }

  function storedConsent() {
    try {
      return localStorage.getItem(analyticsConsentKey);
    } catch {
      return null;
    }
  }

  function analyticsSessionId() {
    try {
      let id = sessionStorage.getItem(analyticsSessionKey);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(analyticsSessionKey, id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  function sendAnalytics(kind, data = {}) {
    if (!analyticsEnabled) return;
    const path = window.location.pathname.slice(0, 240);
    const payload = {
      eventId: crypto.randomUUID(),
      sessionId: analyticsSessionId(),
      kind,
      path,
      ...data,
    };
    fetch("/api/analytics/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  function beginAnalytics() {
    if (window.location.pathname.startsWith("/ikrame")) return;
    analyticsEnabled = true;
    sendAnalytics("page_view");
    if (analyticsListenersInstalled) return;
    analyticsListenersInstalled = true;
    document.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!link) return;
      try {
        const target = new URL(link.href, window.location.href);
        sendAnalytics("link_click", { target: target.origin === window.location.origin ? target.pathname.slice(0, 240) : "/external-link" });
      } catch {
        // Ignore invalid or script-only links.
      }
    }, { passive: true });

    const recordedDepths = new Set();
    let scrollFrame = 0;
    window.addEventListener("scroll", () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        const scrollable = document.documentElement.scrollHeight - window.innerHeight;
        if (scrollable <= 0) return;
        const percent = Math.min(100, Math.round((window.scrollY / scrollable) * 100));
        for (const depth of [25, 50, 75, 100]) {
          if (percent >= depth && !recordedDepths.has(depth)) {
            recordedDepths.add(depth);
            sendAnalytics("scroll", { depth });
          }
        }
      });
    }, { passive: true });
  }

  function showAnalyticsConsent() {
    if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return;
    if (window.location.pathname.startsWith("/ikrame")) return;
    if (document.querySelector(".analytics-consent-banner")) return;
    const consent = storedConsent();
    if (consent === "accepted") {
      beginAnalytics();
      return;
    }
    if (consent === "rejected") return;

    const banner = document.createElement("aside");
    banner.className = "analytics-consent-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Choix des statistiques anonymes");
    const copy = document.createElement("p");
    copy.className = "analytics-consent-copy";
    copy.textContent = "Autoriser des statistiques anonymes de visites, clics et défilement ? Aucun nom, email ou texte de lien n’est enregistré.";
    const actions = document.createElement("div");
    actions.className = "analytics-consent-actions";
    for (const [choice, label] of [["reject", "Refuser"], ["accept", "Accepter"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.choice = choice;
      button.textContent = label;
      button.addEventListener("click", () => {
        try {
          localStorage.setItem(analyticsConsentKey, choice === "accept" ? "accepted" : "rejected");
        } catch {
          banner.remove();
          return;
        }
        banner.remove();
        if (choice === "accept") beginAnalytics();
        else analyticsEnabled = false;
      });
      actions.append(button);
    }
    banner.append(copy, actions);
    document.body.append(banner);
  }

  async function loadBrands() {
    const list = document.querySelector("#vendor-list");
    if (!list) return;
    try {
      const response = await fetch("/api/brands", { credentials: "same-origin" });
      if (!response.ok) return;
      const brands = await response.json();
      const fragment = document.createDocumentFragment();
      if (!Array.isArray(brands) || !brands.length) {
        const note = document.createElement("p");
        note.className = "brands-empty";
        note.textContent = "Aucune marque pour le moment.";
        fragment.append(note);
      } else {
        for (const brand of brands) {
          const item = document.createElement("div");
          item.className = "vendor-item";
          item.setAttribute("data-vendor", brand.name || "");
          const link = document.createElement("a");
          link.className = "vendor-link";
          if (brand.slug) link.href = `/marque/${encodeURIComponent(brand.slug)}`;
          if (brand.image_path) {
            const image = document.createElement("img");
            image.src = brand.image_path;
            image.alt = brand.name ? `Logo ${brand.name}` : "Logo de la marque";
            image.className = "vendor-image";
            image.width = 100;
            image.height = 100;
            image.loading = "lazy";
            link.append(image);
          }
          if (brand.name) {
            const title = document.createElement("h3");
            title.textContent = brand.name;
            link.append(title);
          }
          item.append(link);
          fragment.append(item);
        }
      }
      list.replaceChildren(fragment);
    } catch {
      // La page reste fonctionnelle si la liste des marques est indisponible.
    }
  }

  function addAnalyticsPreferencesLink() {
    const footer = document.querySelector(".hpf-footer");
    if (!footer || footer.querySelector(".analytics-preferences")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "analytics-preferences";
    button.textContent = "Préférences de confidentialité";
    button.addEventListener("click", () => {
      try {
        localStorage.removeItem(analyticsConsentKey);
      } catch {
        return;
      }
      showAnalyticsConsent();
    });
    footer.append(button);
  }

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("#CodAddToCartFormTop, .cod-atc-form-top")) return;
    event.preventDefault();
    const quantity = Math.max(1, Number(form.querySelector('[name="quantity"]')?.value) || 1);
    addProduct(productDetails(), quantity);
  });

  document.addEventListener("click", (event) => {
    const buyButton = event.target.closest("#CodPopupOpen");
    if (buyButton) {
      event.preventDefault();
      addProduct(productDetails());
      return;
    }
    const removeButton = event.target.closest("[data-local-cart-remove]");
    if (removeButton) {
      const cart = readCart().filter((item) => item.id !== removeButton.dataset.localCartRemove);
      saveCart(cart);
      updateCartPage();
      return;
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target.closest("[data-local-cart-quantity]");
    if (!input) return;
    const quantity = Math.min(99, Math.max(1, Number(input.value) || 1));
    const cart = readCart();
    const item = cart.find((entry) => entry.id === input.dataset.localCartQuantity);
    if (item) item.quantity = quantity;
    saveCart(cart);
    updateCartPage();
  });

  document.addEventListener("DOMContentLoaded", () => {
    renderStyles();
    const buyLabel = document.querySelector("#CodPopupOpen .cod-btn__text");
    if (buyLabel) buyLabel.textContent = "Ajouter au panier";
    hideStaticBadges(document);
    const cart = readCart();
    setCartCount(cart);
    updateCartPage();
    loadBackendProducts();
    loadBrands();
    applySiteContent().finally(hideEmptyImageSlots);
    renderImageBlocks();
    showAnalyticsConsent();
    addAnalyticsPreferencesLink();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === storageKey) updateCartPage();
  });
})();