"use strict";

const PAGE_NAMES = {
  "index.html": "Accueil",
  "cart.html": "Panier",
  "pages/about-us.html": "À propos",
  "pages/contact.html": "Contact",
  "pages/faq.html": "FAQ",
  "pages/marques-liste-a-z.html": "Marques (A à Z)",
  "pages/social-media.html": "Réseaux sociaux",
  "policies/privacy-policy.html": "Politique de confidentialité",
  "policies/shipping-policy.html": "Politique d’expédition",
  "policies/terms-of-service.html": "Conditions d’utilisation",
  "blogs/news.html": "Blog",
  menu: "Menu de navigation",
};

const PAGE_ORDER = [
  "index.html",
  "cart.html",
  "pages/about-us.html",
  "pages/contact.html",
  "pages/faq.html",
  "pages/marques-liste-a-z.html",
  "pages/social-media.html",
  "blogs/news.html",
  "policies/privacy-policy.html",
  "policies/shipping-policy.html",
  "policies/terms-of-service.html",
  "menu",
];

const VIEWS = {
  overview: { eyebrow: "Tableau de bord", title: "Vue d’ensemble" },
  content: { eyebrow: "Site", title: "Contenu du site" },
  products: { eyebrow: "Catalogue", title: "Produits" },
  analytics: { eyebrow: "Audience", title: "Statistiques", owner: true },
  team: { eyebrow: "Équipe", title: "Gestionnaires", owner: true },
};

const CATEGORIES = [
  ["nouveaux-produits", "Nouveautés"],
  ["parfums-1", "Parfums"],
  ["visage", "Visage"],
  ["maquillage", "Maquillage"],
  ["soins-capillaires", "Cheveux"],
  ["corps", "Corps"],
  ["soins-dentaires", "Soins dentaires"],
];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const state = {
  isOwner: false,
  products: [],
  slots: { texts: [], images: [] },
  overrides: { texts: {}, images: {} },
  pages: [],
  currentPage: "index.html",
  activeTab: "images",
  pendingTab: null,
  brands: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function h(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs || {})) node.setAttribute(name, value);
  for (const [event, handler] of Object.entries(options.on || {})) node.addEventListener(event, handler);
  for (const child of [children].flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function icon(pathData, size = 22) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  if (response.status === 401) {
    window.location.assign("/ikrame");
    throw new Error("Session expirée. Reconnecte-toi.");
  }
  const text = response.status === 204 ? "" : await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) throw new Error(data?.error || "Une erreur est survenue.");
  return data;
}

function toast(message, type = "info") {
  const node = h("div", { className: `toast ${type}`, text: message, attrs: { role: type === "error" ? "alert" : "status" } });
  $("#toasts").append(node);
  window.setTimeout(() => {
    node.classList.add("is-leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }, 3800);
}

function pageLabel(page) {
  return PAGE_NAMES[page] || page;
}

function pageSlots(page) {
  return state.slots.images.filter((item) => item.page === page);
}

function isFilled(item) {
  return Boolean(state.overrides.images[item.key]);
}

function pageStats(page) {
  const items = pageSlots(page);
  return { total: items.length, filled: items.filter(isFilled).length };
}

function percent(filled, total) {
  return total ? Math.round((filled / total) * 100) : 0;
}

function progressBar(ratio) {
  const fill = h("span");
  const track = h("div", { className: `progress${ratio >= 1 ? " is-complete" : ""}`, attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(ratio * 100)) } }, [fill]);
  requestAnimationFrame(() => {
    fill.style.width = `${Math.round(ratio * 100)}%`;
  });
  return track;
}

function skeletonBlocks(container, count, height = 120) {
  container.replaceChildren(...Array.from({ length: count }, () => h("div", { className: "skeleton", attrs: { style: `min-height:${height}px` } })));
}

function checkImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) return "Format non accepté. Utilise une photo JPG, PNG ou WebP.";
  if (file.size > MAX_IMAGE_BYTES) return "Photo trop lourde. La taille maximum est de 5 Mo.";
  return "";
}

function uploadImage(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/panel/upload");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      const data = safeJson(request.responseText);
      if (request.status === 401) window.location.assign("/ikrame");
      if (request.status >= 200 && request.status < 300 && data?.imagePath) resolve(data.imagePath);
      else reject(new Error(data?.error || "L’envoi de la photo a échoué."));
    });
    request.addEventListener("error", () => reject(new Error("Connexion interrompue pendant l’envoi.")));
    const body = new FormData();
    body.append("image", file);
    request.send(body);
  });
}

function createDropzone({ onFile, hint = "Glisse une photo ici ou clique pour choisir" }) {
  const input = h("input", { attrs: { type: "file", accept: IMAGE_TYPES.join(","), tabindex: "-1" } });
  const title = h("strong", { text: hint });
  const zone = h("div", { className: "dropzone", attrs: { role: "button", tabindex: "0", "aria-label": "Choisir une photo" } }, [
    h("span", { className: "dropzone-icon" }, [icon("M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3")]),
    title,
    h("span", { className: "hint", text: "JPG, PNG ou WebP · 5 Mo maximum" }),
    input,
  ]);
  const open = () => input.click();
  zone.addEventListener("click", open);
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  for (const type of ["dragenter", "dragover"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("is-over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove("is-over");
    });
  }
  zone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
    input.value = "";
  });
  return { zone, title };
}

async function saveContent(key, value) {
  await api("/api/panel/content", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  const bucket = key.startsWith("t:") ? state.overrides.texts : state.overrides.images;
  if (value) bucket[key] = value;
  else delete bucket[key];
}

async function loadSlots() {
  const response = await fetch("/cms-slots.json", { credentials: "same-origin" });
  if (!response.ok) throw new Error("La liste des éléments du site est introuvable.");
  state.slots = await response.json();
  const pages = [...new Set(state.slots.images.map((item) => item.page))];
  const orderOf = (page) => {
    const position = PAGE_ORDER.indexOf(page);
    return position === -1 ? PAGE_ORDER.length : position;
  };
  pages.sort((a, b) => orderOf(a) - orderOf(b) || pageLabel(a).localeCompare(pageLabel(b), "fr"));
  state.pages = pages;
  if (!state.pages.includes(state.currentPage)) state.currentPage = pages[0] || "index.html";
}

async function loadOverrides() {
  const pages = state.pages.length ? state.pages : ["index.html"];
  const responses = await Promise.all(pages.map((page) => api(`/api/cms/content?page=${encodeURIComponent(page)}`)));
  const images = {};
  let texts = {};
  for (const content of responses) {
    Object.assign(images, content.images);
    texts = { ...texts, ...content.texts };
  }
  state.overrides = { texts, images };
}

async function loadProducts() {
  state.products = await api("/api/panel/products");
}

async function loadAnalytics(days) {
  const data = await api(`/api/panel/analytics?days=${days}`);
  $("#analytics-kpis").replaceChildren(
    kpi("Visiteurs estimés", data.visitors),
    kpi("Pages vues", data.pageViews),
    kpi("Clics sur les liens", data.linkClicks),
    kpi("Défilement à 75 %", data.scroll75),
  );
  renderBars($("#analytics-pages"), data.topPages, "Pas encore de données pour cette période.");
  renderBars($("#analytics-links"), data.topLinks, "Pas encore de clics enregistrés.");
  renderBars($("#analytics-scroll"), data.scrollDepths, "Pas encore de données de défilement.");
  state.analytics = data;
}

async function loadManagers() {
  state.managers = await api("/api/panel/managers");
  renderManagers();
}

function kpi(label, value, note = "") {
  return h("article", { className: "kpi" }, [
    h("span", { className: "kpi-value", text: String(value) }),
    h("span", { className: "kpi-label", text: label }),
    note ? h("span", { className: "kpi-note", text: note }) : null,
  ]);
}

function renderBars(container, items, emptyText) {
  container.replaceChildren();
  if (!items.length) {
    container.append(h("p", { className: "muted", text: emptyText }));
    return;
  }
  const maximum = Math.max(...items.map((item) => item.count), 1);
  for (const item of items) {
    const track = h("i");
    container.append(h("div", { className: "bar-row" }, [
      h("span", { text: item.label, attrs: { title: item.label } }),
      h("strong", { text: String(item.count) }),
      h("div", { className: "bar-track" }, [track]),
    ]));
    requestAnimationFrame(() => {
      track.style.width = `${Math.max(4, (item.count / maximum) * 100)}%`;
    });
  }
}

function renderOverview() {
  const images = state.slots.images;
  const filled = images.filter(isFilled).length;
  const textCount = Object.keys(state.overrides.texts).length;
  const cards = [
    kpi("Produits en ligne", state.products.length, "Gérés dans Produits"),
    h("article", { className: "kpi" }, [
      h("span", { className: "kpi-value", text: `${filled} / ${images.length}` }),
      h("span", { className: "kpi-label", text: "Photos du site renseignées" }),
      h("span", { className: "kpi-note" }, [progressBar(filled / Math.max(images.length, 1))]),
    ]),
    kpi("Textes personnalisés", textCount, "Sur les pages principales"),
  ];
  if (state.isOwner && state.analytics) cards.push(kpi("Visiteurs estimés", state.analytics.visitors, `${state.analytics.days} derniers jours`));
  $("#kpis").replaceChildren(...cards);

  const todo = state.pages
    .map((page) => ({ page, ...pageStats(page) }))
    .filter((item) => item.total > item.filled)
    .sort((a, b) => percent(a.filled, a.total) - percent(b.filled, b.total))
    .slice(0, 6);
  const list = $("#todo-list");
  list.replaceChildren();
  if (!todo.length) {
    list.append(h("p", { className: "muted", text: "Toutes les photos sont renseignées. Bravo !" }));
    return;
  }
  for (const item of todo) {
    list.append(h("button", { className: "todo-item", attrs: { type: "button" }, on: { click: () => openContent(item.page) } }, [
      h("div", { className: "todo-item-head" }, [
        h("span", { text: pageLabel(item.page) }),
        h("span", { text: `${item.filled} / ${item.total}` }),
      ]),
      progressBar(item.filled / item.total),
    ]));
  }
}

function renderPageList() {
  const list = $("#page-list");
  list.replaceChildren(...state.pages.map((page) => {
    const stats = pageStats(page);
    const selected = page === state.currentPage;
    return h("button", {
      className: "page-item",
      attrs: { type: "button", "aria-current": selected ? "true" : "false" },
      on: { click: () => selectPage(page) },
    }, [
      h("div", { className: "page-item-head" }, [h("span", { text: pageLabel(page) }), h("span", { text: `${stats.filled}/${stats.total}` })]),
      progressBar(stats.total ? stats.filled / stats.total : 0),
    ]);
  }));
}

function renderSlots() {
  const stats = pageStats(state.currentPage);
  $("#page-title").textContent = pageLabel(state.currentPage);
  $("#page-progress").textContent = `${stats.filled} photo${stats.filled > 1 ? "s" : ""} sur ${stats.total} renseignée${stats.filled > 1 ? "s" : ""}`;
  const filter = $("#slot-search").value.trim().toLowerCase();
  const items = pageSlots(state.currentPage).filter((item) => !filter || item.name.toLowerCase().includes(filter));
  const grid = $("#slot-grid");
  grid.replaceChildren();
  if (!items.length) {
    grid.append(h("p", { className: "empty-note", text: filter ? "Aucun emplacement ne correspond à la recherche." : "Aucune photo modifiable sur cette page." }));
    return;
  }
  items.forEach((item, position) => {
    const url = state.overrides.images[item.key];
    const media = h("div", { className: "slot-media" }, [
      url ? h("img", { attrs: { src: url, alt: "", loading: "lazy" } }) : h("span", { text: "Aucune photo" }),
      h("span", { className: "cta", text: url ? "Remplacer" : "Ajouter" }),
    ]);
    grid.append(h("button", {
      className: `slot${url ? " is-filled" : ""}`,
      attrs: { type: "button", style: `animation-delay:${Math.min(position, 12) * 22}ms` },
      on: { click: () => openImageDialog(item) },
    }, [
      media,
      h("div", { className: "slot-body" }, [
        h("span", { className: "slot-title", text: item.name, attrs: { title: item.name } }),
        h("span", { className: "slot-meta" }, [h("span", { className: "dot" }), h("span", { text: url ? "Photo en ligne" : `Emplacement n° ${item.index}` })]),
      ]),
    ]));
  });
}

function renderTexts() {
  const filter = $("#text-filter").value.trim().toLowerCase();
  const list = $("#text-list");
  const items = state.slots.texts.filter((item) => {
    const current = state.overrides.texts[item.key] ?? item.default;
    return !filter || current.toLowerCase().includes(filter) || item.default.toLowerCase().includes(filter);
  });
  list.replaceChildren();
  if (!items.length) {
    list.append(h("p", { className: "empty-note", text: "Aucun texte ne correspond à la recherche." }));
    return;
  }
  for (const item of items.slice(0, 400)) list.append(textRow(item));
  if (items.length > 400) list.append(h("p", { className: "muted", text: "Affine la recherche pour voir plus de textes." }));
}

function textRow(item) {
  const textarea = h("textarea", { attrs: { rows: String(Math.min(6, Math.max(2, Math.ceil(item.default.length / 90)))), "aria-label": "Texte à modifier" } });
  textarea.value = state.overrides.texts[item.key] ?? item.default;
  const counter = h("span", { text: `${textarea.value.length} caractères` });
  textarea.addEventListener("input", () => {
    counter.textContent = `${textarea.value.length} caractères`;
  });
  const message = h("span", { className: "hint", attrs: { role: "status" } });
  const reset = h("button", { className: "btn-text danger", attrs: { type: "button" }, text: "Remettre le texte d’origine", on: { click: async () => {
    try {
      await saveContent(item.key, "");
      textarea.value = item.default;
      counter.textContent = `${textarea.value.length} caractères`;
      toast("Texte d’origine rétabli.", "success");
      reset.hidden = true;
    } catch (error) {
      toast(error.message, "error");
    }
  } } });
  reset.hidden = !state.overrides.texts[item.key];
  const save = h("button", { className: "btn btn-primary btn-sm", attrs: { type: "button" }, text: "Enregistrer", on: { click: async () => {
    const value = textarea.value.trim();
    save.disabled = true;
    try {
      await saveContent(item.key, value === item.default ? "" : value);
      reset.hidden = value === item.default || !value;
      toast("Texte enregistré.", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      save.disabled = false;
    }
  } } });
  return h("article", { className: "text-row" }, [
    textarea,
    h("div", { className: "text-meta" }, [
      h("span", { text: `Texte d’origine : ${item.default.slice(0, 120)}${item.default.length > 120 ? "…" : ""}` }),
      counter,
    ]),
    h("div", { className: "text-actions" }, [save, reset]),
    message,
  ]);
}

function renderProducts() {
  const filter = $("#product-search").value.trim().toLowerCase();
  const products = state.products.filter((product) => !filter || `${product.name} ${product.brand}`.toLowerCase().includes(filter));
  $("#product-count").textContent = `${state.products.length} produit${state.products.length > 1 ? "s" : ""} en ligne`;
  const list = $("#product-list");
  list.replaceChildren();
  if (!products.length) {
    list.append(h("p", { className: "empty-note", text: state.products.length ? "Aucun produit ne correspond à la recherche." : "Aucun produit pour le moment. Ajoute le premier avec le bouton « Nouveau produit »." }));
    return;
  }
  products.forEach((product, position) => {
    const thumb = h("div", { className: "product-thumb" }, [
      product.image_path ? h("img", { attrs: { src: product.image_path, alt: "", loading: "lazy" } }) : h("span", { text: "Sans photo" }),
    ]);
    const flags = [
      product.promo ? h("span", { className: "flag-chip", attrs: { "data-flag": "promo" }, text: "Promo" }) : null,
      product.sold_out ? h("span", { className: "flag-chip", attrs: { "data-flag": "sold_out" }, text: "Épuisé" }) : null,
    ].filter(Boolean);
    list.append(h("article", { className: "product-card", attrs: { style: `animation-delay:${Math.min(position, 12) * 22}ms` } }, [
      thumb,
      h("div", { className: "product-name", text: product.name, attrs: { title: product.name } }),
      h("div", { className: "product-meta", text: `${product.brand || "Sans marque"} · ${product.category}` }),
      h("div", { className: "product-price" }, [
        h("span", { text: `${(product.price_cents / 100).toFixed(2)} DH` }),
        ...flags,
      ]),
      h("div", { className: "product-actions" }, [
        h("button", { className: `btn-text toggle${product.promo ? " active" : ""}`, attrs: { type: "button", "aria-pressed": String(Boolean(product.promo)) }, text: "Promo", on: { click: () => setProductFlag(product, "promo", !product.promo) } }),
        h("button", { className: `btn-text toggle${product.sold_out ? " active" : ""}`, attrs: { type: "button", "aria-pressed": String(Boolean(product.sold_out)) }, text: "Épuisé", on: { click: () => setProductFlag(product, "sold_out", !product.sold_out) } }),
        h("button", { className: "btn-text", attrs: { type: "button" }, text: "Modifier", on: { click: () => openProductDialog(product) } }),
        h("button", { className: "btn-text danger", attrs: { type: "button" }, text: "Supprimer", on: { click: () => deleteProduct(product) } }),
      ]),
    ]));
  });
}

async function setProductFlag(product, flag, value) {
  try {
    await api(`/api/panel/products/${encodeURIComponent(product.slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: product.name,
        brand: product.brand || "",
        description: product.description || "",
        price: product.price_cents / 100,
        category: product.category || "",
        image_path: product.image_path || null,
        [flag]: value,
      }),
    });
    product[flag] = value;
    toast(value ? `Badge activé sur « ${product.name} ».` : `Badge retiré de « ${product.name} ».`, "success");
    renderProducts();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderManagers() {
  const list = $("#manager-list");
  list.replaceChildren();
  if (!state.managers.length) {
    list.append(h("p", { className: "muted", text: "Aucun gestionnaire pour le moment." }));
    return;
  }
  for (const manager of state.managers) {
    list.append(h("div", { className: "manager-row" }, [
      h("span", { text: manager.email }),
      h("button", { className: "btn-text danger", attrs: { type: "button" }, text: "Révoquer", on: { click: () => revokeManager(manager) } }),
    ]));
  }
}

async function loadBrands() {
  state.brands = await api("/api/brands");
  renderBrands();
}

function renderBrands() {
  const list = $("#brand-list");
  const count = $("#brand-count");
  list.replaceChildren();
  if (count) count.textContent = state.brands.length ? `${state.brands.length} marque${state.brands.length > 1 ? "s" : ""}` : "";
  if (!state.brands.length) {
    list.append(h("p", { className: "muted", text: "Aucune marque pour le moment. Ajoute la première ci-dessus." }));
    return;
  }
  for (const brand of state.brands) {
    list.append(h("div", { className: "manager-row" }, [
      h("span", { text: brand.name }),
      h("button", { className: "btn-text danger", attrs: { type: "button" }, text: "Supprimer", on: { click: () => deleteBrand(brand) } }),
    ]));
  }
}

async function deleteBrand(brand) {
  if (!window.confirm(`Supprimer « ${brand.name} » de la liste des marques ?`)) return;
  try {
    await api(`/api/panel/brands/${encodeURIComponent(brand.id)}`, { method: "DELETE" });
    toast("Marque supprimée.", "success");
    await loadBrands();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderSkeletons() {
  skeletonBlocks($("#kpis"), 3, 96);
  skeletonBlocks($("#todo-list"), 3, 60);
  skeletonBlocks($("#slot-grid"), 6, 180);
  skeletonBlocks($("#product-list"), 4, 220);
}

function openContent(page) {
  state.currentPage = page;
  location.hash = "#content";
}

function selectPage(page) {
  state.currentPage = page;
  $("#slot-search").value = "";
  renderPageList();
  renderSlots();
}

function setTab(tab) {
  state.activeTab = tab;
  const panels = { images: "#panel-images", texts: "#panel-texts", brands: "#panel-brands" };
  for (const [name, panel] of Object.entries(panels)) {
    const node = $(panel);
    if (node) node.hidden = name !== tab;
    const tabButton = $(`#tab-${name}`);
    if (tabButton) tabButton.setAttribute("aria-selected", String(name === tab));
  }
}

function openImageDialog(item) {
  const dialog = $("#image-dialog");
  const current = state.overrides.images[item.key] || "";
  let chosen = null;
  let previewUrl = "";

  const afterFrame = h("div", { className: "frame" }, [h("span", { text: "Choisis une photo pour voir l’aperçu" })]);
  const currentFrame = h("div", { className: "frame" }, [
    current ? h("img", { attrs: { src: current, alt: "" } }) : h("span", { text: "Aucune photo" }),
  ]);
  const message = h("p", { className: "form-message", attrs: { role: "status" } });
  const saveButton = h("button", { className: "btn btn-primary", attrs: { type: "button", disabled: "" }, text: "Enregistrer la photo" });
  const cancelButton = h("button", { className: "btn btn-soft", attrs: { type: "button" }, text: "Annuler" });
  const status = h("div", { className: "upload-status", attrs: { hidden: "" } });
  const statusLabel = h("div", { className: "label" });
  let progress = null;
  let removeButton = null;

  const dropzone = createDropzone({
    hint: current ? "Glisse une nouvelle photo pour la remplacer" : "Glisse une photo ici ou clique pour choisir",
    onFile: (file) => choose(file),
  });

  function choose(file) {
    const error = checkImage(file);
    if (error) {
      message.textContent = error;
      message.dataset.state = "error";
      return;
    }
    chosen = file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    afterFrame.replaceChildren(h("img", { attrs: { src: previewUrl, alt: "" } }));
    dropzone.title.textContent = `Prête : ${file.name}`;
    message.textContent = "";
    delete message.dataset.state;
    saveButton.disabled = false;
  }

  function setBusy(busy) {
    saveButton.disabled = busy || !chosen;
    cancelButton.disabled = busy;
    dropzone.zone.style.pointerEvents = busy ? "none" : "";
    if (removeButton) removeButton.disabled = busy;
  }

  saveButton.addEventListener("click", async () => {
    if (!chosen) return;
    setBusy(true);
    status.hidden = false;
    progress = progressBar(0);
    status.replaceChildren(statusLabel, progress);
    statusLabel.replaceChildren(h("span", { text: "Envoi de la photo" }), h("span", { text: "0 %" }));
    try {
      const path = await uploadImage(chosen, (ratio) => {
        const value = Math.round(ratio * 100);
        progress.firstChild.style.width = `${value}%`;
        progress.setAttribute("aria-valuenow", String(value));
        statusLabel.lastChild.textContent = `${value} %`;
      });
      statusLabel.lastChild.textContent = "Enregistrement";
      progress.firstChild.style.width = "100%";
      await saveContent(item.key, path);
      dialog.close();
      toast("Photo enregistrée. Elle est visible sur le site.", "success");
      refreshContentViews();
    } catch (error) {
      message.textContent = error.message;
      message.dataset.state = "error";
      status.hidden = true;
      setBusy(false);
    }
  });

  cancelButton.addEventListener("click", () => dialog.close());

  if (current) {
    let armed = false;
    removeButton = h("button", { className: "btn btn-danger", attrs: { type: "button" }, text: "Retirer la photo" });
    removeButton.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        removeButton.textContent = "Confirmer le retrait";
        window.setTimeout(() => {
          armed = false;
          removeButton.textContent = "Retirer la photo";
        }, 4000);
        return;
      }
      removeButton.disabled = true;
      try {
        await saveContent(item.key, "");
        dialog.close();
        toast("Photo retirée. La case est de nouveau vide.", "success");
        refreshContentViews();
      } catch (error) {
        message.textContent = error.message;
        message.dataset.state = "error";
        removeButton.disabled = false;
      }
    });
  }

  const closeButton = h("button", { className: "icon-btn", attrs: { type: "button", "aria-label": "Fermer" }, text: "×", on: { click: () => dialog.close() } });
  dialog.replaceChildren(
    h("header", { className: "dialog-head" }, [
      h("div", {}, [
        h("h2", { text: item.name, attrs: { id: "image-dialog-title" } }),
        h("p", { text: `${pageLabel(item.page)} · Emplacement n° ${item.index}` }),
      ]),
      closeButton,
    ]),
    h("div", { className: "dialog-body" }, [
      h("div", { className: "compare" }, [
        h("figure", {}, [currentFrame, h("figcaption", { text: current ? "Photo actuelle" : "Aucune photo pour l’instant" })]),
        h("figure", {}, [afterFrame, h("figcaption", { text: "Nouvelle photo" })]),
      ]),
      dropzone.zone,
      status,
      message,
    ]),
    h("footer", { className: "dialog-foot" }, [
      h("div", { className: "group" }, [removeButton].filter(Boolean)),
      h("div", { className: "group" }, [cancelButton, saveButton]),
    ]),
  );
  dialog.addEventListener("close", () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, { once: true });
  dialog.showModal();
}

function openProductDialog(product) {
  const dialog = $("#product-dialog");
  const editing = Boolean(product);
  let chosen = null;
  let previewUrl = "";
  let currentPath = product?.image_path || "";

  const nameInput = h("input", { attrs: { name: "name", required: "", maxlength: "160", autocomplete: "off" } });
  const brandInput = h("input", { attrs: { name: "brand", maxlength: "120", autocomplete: "off" } });
  const priceInput = h("input", { attrs: { name: "price", type: "number", min: "0", max: "100000000", step: "0.01", required: "" } });
  const categorySelect = h("select", { attrs: { name: "category", required: "" } }, CATEGORIES.map(([value, label]) => h("option", { attrs: { value }, text: label })));
  const descriptionInput = h("textarea", { attrs: { name: "description", rows: "4", maxlength: "10000" } });
  const promoSwitch = h("input", { attrs: { type: "checkbox", role: "switch" } });
  const soldOutSwitch = h("input", { attrs: { type: "checkbox", role: "switch" } });
  promoSwitch.checked = Boolean(product?.promo);
  soldOutSwitch.checked = Boolean(product?.sold_out);
  const flagRow = h("div", { className: "flag-row" }, [
    h("label", { className: "switch" }, [promoSwitch, h("span", { className: "switch-track", attrs: { "aria-hidden": "true" } }), h("span", { className: "switch-label", text: "Badge Promo" })]),
    h("label", { className: "switch" }, [soldOutSwitch, h("span", { className: "switch-track", attrs: { "aria-hidden": "true" } }), h("span", { className: "switch-label", text: "Épuisé" })]),
  ]);
  nameInput.value = product?.name || "";
  brandInput.value = product?.brand || "";
  priceInput.value = product ? (product.price_cents / 100).toFixed(2) : "";
  categorySelect.value = product?.category || "nouveaux-produits";
  descriptionInput.value = product?.description || "";

  const previewFrame = h("div", { className: "frame" }, [
    currentPath ? h("img", { attrs: { src: currentPath, alt: "" } }) : h("span", { text: "Aucune photo" }),
  ]);
  const message = h("p", { className: "form-message", attrs: { role: "status" } });
  const saveButton = h("button", { className: "btn btn-primary", attrs: { type: "submit" }, text: editing ? "Enregistrer les modifications" : "Ajouter le produit" });
  const cancelButton = h("button", { className: "btn btn-soft", attrs: { type: "button" }, text: "Annuler" });

  const dropzone = createDropzone({
    hint: currentPath ? "Glisse une nouvelle photo pour la remplacer" : "Glisse une photo ici ou clique pour choisir",
    onFile: (file) => {
      const error = checkImage(file);
      if (error) {
        message.textContent = error;
        message.dataset.state = "error";
        return;
      }
      chosen = file;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      previewFrame.replaceChildren(h("img", { attrs: { src: previewUrl, alt: "" } }));
      dropzone.title.textContent = `Prête : ${file.name}`;
      message.textContent = "";
      delete message.dataset.state;
    },
  });

  const form = h("form", { className: "dialog-form", attrs: { novalidate: "" } }, [
    h("div", { className: "dialog-body" }, [
      h("div", { className: "compare" }, [
        h("figure", {}, [previewFrame, h("figcaption", { text: currentPath ? "Photo actuelle" : "Aucune photo" })]),
        dropzone.zone,
      ]),
      h("label", { className: "field" }, ["Nom du produit", nameInput]),
      h("div", { className: "form-row" }, [
        h("label", { className: "field" }, ["Marque", brandInput]),
        h("label", { className: "field" }, ["Prix (DH)", priceInput]),
      ]),
      h("label", { className: "field" }, ["Catégorie", categorySelect]),
      flagRow,
      h("label", { className: "field" }, ["Description", descriptionInput]),
      message,
    ]),
    h("footer", { className: "dialog-foot" }, [
      h("div", { className: "group" }, [cancelButton]),
      h("div", { className: "group" }, [saveButton]),
    ]),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    saveButton.disabled = true;
    cancelButton.disabled = true;
    message.textContent = chosen ? "Envoi de la photo…" : "Enregistrement…";
    delete message.dataset.state;
    try {
      const imagePath = chosen ? await uploadImage(chosen, () => {}) : currentPath;
      const slug = editing ? product.slug : localSlug(nameInput.value);
      await api(editing ? `/api/panel/products/${encodeURIComponent(product.slug)}` : "/api/panel/products", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name: nameInput.value,
          brand: brandInput.value,
          price: Number(priceInput.value),
          category: categorySelect.value,
          description: descriptionInput.value,
          image_path: imagePath || null,
          promo: promoSwitch.checked,
          sold_out: soldOutSwitch.checked,
        }),
      });
      dialog.close();
      toast(editing ? "Produit modifié." : "Produit ajouté au catalogue.", "success");
      await loadProducts();
      renderProducts();
      renderOverview();
    } catch (error) {
      message.textContent = error.message;
      message.dataset.state = "error";
      saveButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  cancelButton.addEventListener("click", () => dialog.close());
  dialog.replaceChildren(
    h("header", { className: "dialog-head" }, [
      h("div", {}, [
        h("h2", { text: editing ? "Modifier le produit" : "Nouveau produit", attrs: { id: "product-dialog-title" } }),
        h("p", { text: editing ? product.name : "Remplis les informations et ajoute une photo." }),
      ]),
      h("button", { className: "icon-btn", attrs: { type: "button", "aria-label": "Fermer" }, text: "×", on: { click: () => dialog.close() } }),
    ]),
    form,
  );
  dialog.addEventListener("close", () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, { once: true });
  dialog.showModal();
  nameInput.focus();
}

function localSlug(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function deleteProduct(product) {
  if (!window.confirm(`Supprimer « ${product.name} » du catalogue ?`)) return;
  try {
    await api(`/api/panel/products/${encodeURIComponent(product.slug)}`, { method: "DELETE" });
    toast("Produit supprimé.", "success");
    await loadProducts();
    renderProducts();
    renderOverview();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function revokeManager(manager) {
  if (!window.confirm(`Révoquer l’accès de ${manager.email} ?`)) return;
  try {
    await api(`/api/panel/managers/${encodeURIComponent(manager.id)}`, { method: "DELETE" });
    toast("Accès révoqué.", "success");
    await loadManagers();
  } catch (error) {
    toast(error.message, "error");
  }
}

function refreshContentViews() {
  renderOverview();
  renderPageList();
  renderSlots();
}

function renderActions(view) {
  const container = $("#view-actions");
  container.replaceChildren();
  if (view === "products") {
    container.append(h("button", { className: "btn btn-primary", attrs: { type: "button" }, text: "Nouveau produit", on: { click: () => openProductDialog(null) } }));
  }
  if (view === "content") {
    container.append(h("a", { className: "btn btn-soft", attrs: { href: "/", target: "_blank", rel: "noopener noreferrer" }, text: "Voir le site ↗" }));
  }
}

function showView(name) {
  let view = VIEWS[name] ? name : "overview";
  if (VIEWS[view].owner && !state.isOwner) view = "overview";
  for (const section of $$("[data-panel]")) {
    section.hidden = section.dataset.panel !== view;
  }
  for (const link of $$(".dash-nav a")) {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("#view-eyebrow").textContent = VIEWS[view].eyebrow;
  $("#view-title").textContent = VIEWS[view].title;
  renderActions(view);
  if (view === "content" && state.pendingTab) {
    setTab(state.pendingTab);
    state.pendingTab = null;
  }
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
}

function currentView() {
  return location.hash.replace("#", "") || "overview";
}

function wireEvents() {
  window.addEventListener("hashchange", () => showView(currentView()));
  $("#tab-images").addEventListener("click", () => setTab("images"));
  $("#tab-texts").addEventListener("click", () => setTab("texts"));
  $("#tab-brands").addEventListener("click", () => setTab("brands"));
  $("#slot-search").addEventListener("input", renderSlots);
  $("#text-filter").addEventListener("input", renderTexts);
  $("#product-search").addEventListener("input", renderProducts);
  $("#analytics-days").addEventListener("change", async (event) => {
    try {
      await loadAnalytics(event.target.value);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/ikrame");
    }
  });
  $$("[data-go]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.tab) state.pendingTab = button.dataset.tab;
      location.hash = `#${button.dataset.go}`;
    });
  });
  $("#manager-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api("/api/panel/managers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.elements.email.value, password: form.elements.password.value }),
      });
      form.reset();
      toast("Accès gestionnaire créé.", "success");
      await loadManagers();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  $("#brand-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = $("#brand-name");
    const button = form.querySelector('button[type="submit"]');
    const name = input.value.trim();
    if (!name) return;
    button.disabled = true;
    try {
      await api("/api/panel/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      input.value = "";
      toast(`Marque « ${name} » ajoutée.`, "success");
      await loadBrands();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
}

async function init() {
  wireEvents();
  let session;
  try {
    session = await api("/api/auth/session");
  } catch {
    return;
  }
  if (!session.authenticated || !["admin", "manager"].includes(session.role)) {
    window.location.assign("/ikrame");
    return;
  }
  state.isOwner = session.role === "admin";
  $("#admin-email").textContent = session.email;
  for (const node of $$(".owner-only")) node.hidden = !state.isOwner;
  setTab(state.activeTab);
  showView(currentView());
  renderSkeletons();

  try {
    await loadSlots();
    await loadOverrides();
    renderPageList();
    renderSlots();
    renderTexts();
  } catch (error) {
    toast(error.message, "error");
  }
  const tasks = [loadProducts(), loadBrands()];
  if (state.isOwner) tasks.push(loadAnalytics(state.analyticsDays || 30), loadManagers());
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") toast(result.reason?.message || "Chargement incomplet.", "error");
  }
  renderProducts();
  renderOverview();
}

init();
