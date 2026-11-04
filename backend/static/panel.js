const productForm = document.querySelector("#product-form");
const productList = document.querySelector("#product-list");
const formMessage = productForm?.querySelector(".form-message");
let currentProducts = [];
let currentImagePath = "";

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const result = response.status === 204 ? null : await response.json();
  if (response.status === 401) {
    window.location.assign("/ikrame");
    throw new Error("Session expirée.");
  }
  if (!response.ok) throw new Error(result?.error || "Une erreur est survenue.");
  return result;
}

function showFormMessage(text, state = "") {
  formMessage.textContent = text;
  formMessage.dataset.state = state;
}

function localSlug(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function drawProducts() {
  productList.replaceChildren();
  document.querySelector("#product-count").textContent = `${currentProducts.length} produit${currentProducts.length === 1 ? "" : "s"}`;
  document.querySelector("#list-message").textContent = currentProducts.length ? "" : "Aucun produit pour le moment.";
  for (const product of currentProducts) {
    const card = document.createElement("article");
    card.className = "admin-product-row";
    const preview = document.createElement("div");
    preview.className = "admin-product-image";
    if (product.image_path) {
      const image = document.createElement("img");
      image.src = product.image_path;
      image.alt = "";
      preview.append(image);
    } else {
      preview.textContent = "Sans photo";
    }
    const info = document.createElement("div");
    info.className = "admin-product-info";
    const name = document.createElement("strong");
    name.textContent = product.name;
    const details = document.createElement("span");
    details.textContent = `${product.brand || "Sans marque"} · ${(product.price_cents / 100).toFixed(2)} DH · ${product.category}`;
    info.append(name, details);
    const actions = document.createElement("div");
    actions.className = "admin-product-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "text-button";
    edit.textContent = "Modifier";
    edit.addEventListener("click", () => editProduct(product));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button text-danger";
    remove.textContent = "Supprimer";
    remove.addEventListener("click", () => deleteProduct(product.slug));
    actions.append(edit, remove);
    card.append(preview, info, actions);
    productList.append(card);
  }
}

async function loadProducts() {
  currentProducts = await api("/api/panel/products");
  drawProducts();
}

function renderAnalyticsList(containerId, items) {
  const container = document.querySelector(containerId);
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "analytics-empty";
    empty.textContent = "Pas encore de données pour cette période.";
    container.append(empty);
    return;
  }
  const maximum = Math.max(...items.map((item) => item.count), 1);
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "analytics-row";
    const label = document.createElement("span");
    label.textContent = item.label;
    label.title = item.label;
    const count = document.createElement("strong");
    count.textContent = String(item.count);
    const bar = document.createElement("div");
    bar.className = "analytics-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(4, (item.count / maximum) * 100)}%`;
    bar.append(fill);
    row.append(label, count, bar);
    container.append(row);
  }
}

async function loadAnalytics() {
  const days = document.querySelector("#analytics-days").value;
  const message = document.querySelector("#analytics-message");
  try {
    const data = await api(`/api/panel/analytics?days=${days}`);
    document.querySelector("#metric-visitors").textContent = String(data.visitors);
    document.querySelector("#metric-page-views").textContent = String(data.pageViews);
    document.querySelector("#metric-link-clicks").textContent = String(data.linkClicks);
    document.querySelector("#metric-scroll-75").textContent = String(data.scroll75);
    renderAnalyticsList("#analytics-pages", data.topPages);
    renderAnalyticsList("#analytics-links", data.topLinks);
    renderAnalyticsList("#analytics-scroll", data.scrollDepths);
    message.textContent = `Période : ${data.days} jours. Aucun détail personnel n'est collecté.`;
  } catch (error) {
    message.textContent = error.message;
  }
}

async function loadManagers() {
  const managers = await api("/api/panel/managers");
  const list = document.querySelector("#manager-list");
  list.replaceChildren();
  document.querySelector("#manager-message").textContent = managers.length ? "" : "Aucun gestionnaire pour le moment.";
  for (const manager of managers) {
    const row = document.createElement("div");
    row.className = "manager-row";
    const email = document.createElement("span");
    email.textContent = manager.email;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "text-button text-danger";
    revoke.textContent = "Révoquer";
    revoke.addEventListener("click", () => revokeManager(manager.id));
    row.append(email, revoke);
    list.append(row);
  }
}

async function revokeManager(id) {
  if (!window.confirm("Révoquer l’accès de ce gestionnaire ?")) return;
  try {
    await api(`/api/panel/managers/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadManagers();
  } catch (error) {
    document.querySelector("#manager-message").textContent = error.message;
  }
}

function editProduct(product) {
  productForm.elements.editing_slug.value = product.slug;
  productForm.elements.name.value = product.name;
  productForm.elements.brand.value = product.brand;
  productForm.elements.price.value = (product.price_cents / 100).toFixed(2);
  productForm.elements.category.value = product.category;
  productForm.elements.description.value = product.description;
  productForm.elements.image.value = "";
  currentImagePath = product.image_path || "";
  document.querySelector("#editor-title").textContent = "Modifier le produit";
  document.querySelector("#cancel-edit").hidden = false;
  const preview = document.querySelector("#image-preview");
  preview.replaceChildren();
  if (currentImagePath) {
    const image = document.createElement("img");
    image.src = currentImagePath;
    image.alt = "Photo actuelle du produit";
    preview.append(image);
    preview.hidden = false;
  }
  productForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearEditor() {
  productForm.reset();
  productForm.elements.editing_slug.value = "";
  currentImagePath = "";
  document.querySelector("#editor-title").textContent = "Ajouter un produit";
  document.querySelector("#cancel-edit").hidden = true;
  const preview = document.querySelector("#image-preview");
  preview.replaceChildren();
  preview.hidden = true;
  showFormMessage("");
}

async function uploadImage(file) {
  if (!file) return currentImagePath;
  const body = new FormData();
  body.append("image", file);
  const result = await api("/api/panel/upload", { method: "POST", body });
  return result.imagePath;
}

productForm?.elements.name.addEventListener("input", (event) => {
  if (!productForm.elements.editing_slug.value) productForm.elements.slug.value = localSlug(event.target.value);
});

productForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = productForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    currentImagePath = await uploadImage(productForm.elements.image.files[0]);
    const editingSlug = productForm.elements.editing_slug.value;
    const payload = {
      slug: editingSlug || localSlug(productForm.elements.name.value),
      name: productForm.elements.name.value,
      brand: productForm.elements.brand.value,
      price: Number(productForm.elements.price.value),
      category: productForm.elements.category.value,
      description: productForm.elements.description.value,
      image_path: currentImagePath || null,
    };
    await api(editingSlug ? `/api/panel/products/${encodeURIComponent(editingSlug)}` : "/api/panel/products", {
      method: editingSlug ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    clearEditor();
    await loadProducts();
    showFormMessage("Produit enregistré.", "success");
  } catch (error) {
    showFormMessage(error.message || "Enregistrement impossible.", "error");
  } finally {
    submit.disabled = false;
  }
});

async function deleteProduct(slug) {
  if (!window.confirm("Supprimer ce produit du catalogue ?")) return;
  try {
    await api(`/api/panel/products/${encodeURIComponent(slug)}`, { method: "DELETE" });
    await loadProducts();
  } catch (error) {
    document.querySelector("#list-message").textContent = error.message;
  }
}

document.querySelector("#cancel-edit")?.addEventListener("click", clearEditor);
document.querySelector("#refresh-products")?.addEventListener("click", () => loadProducts().catch((error) => {
  document.querySelector("#list-message").textContent = error.message;
}));
document.querySelector("#analytics-days")?.addEventListener("change", loadAnalytics);
document.querySelector("#manager-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.querySelector(".form-message");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/panel/managers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.elements.email.value, password: form.elements.password.value }),
    });
    void result;
    form.reset();
    message.textContent = "Accès gestionnaire créé.";
    message.dataset.state = "success";
    await loadManagers();
  } catch (error) {
    message.textContent = error.message;
    message.dataset.state = "error";
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#logout-button")?.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.assign("/ikrame");
});
document.querySelector('#product-form input[name="image"]')?.addEventListener("change", (event) => {
  const file = event.target.files[0];
  const preview = document.querySelector("#image-preview");
  preview.replaceChildren();
  if (!file) {
    preview.hidden = true;
    return;
  }
  const image = document.createElement("img");
  image.src = URL.createObjectURL(file);
  image.alt = "Aperçu de la photo";
  preview.append(image);
  preview.hidden = false;
});

const contentMessage = document.querySelector("#content-message");
const pageNames = {
  "index.html": "Accueil",
  "cart.html": "Panier",
  "pages/about-us.html": "À propos",
  "pages/contact.html": "Contact",
  "pages/faq.html": "FAQ",
  "pages/marques-liste-a-z.html": "Marques (A à Z)",
  "pages/social-media.html": "Réseaux sociaux",
  "policies/privacy-policy.html": "Politique de confidentialité",
  "policies/refund-policy.html": "Politique de remboursement",
  "policies/terms-of-service.html": "Conditions d'utilisation",
  "blogs/news.html": "Blog",
  "menu": "Menu de navigation (catégories)",
};
let siteSlots = { texts: [], images: [] };
let siteOverrides = { texts: {}, images: {} };
let imagePage = "";

function setContentMessage(text, state = "") {
  contentMessage.textContent = text;
  contentMessage.dataset.state = state;
}

function pageLabel(page) {
  return pageNames[page] || page;
}

async function saveContent(key, value) {
  await api("/api/panel/content", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

async function loadSiteOverrides() {
  siteOverrides = await api(`/api/cms/content?page=${encodeURIComponent(imagePage)}`);
}

function renderTextRows() {
  const list = document.querySelector("#text-list");
  const filter = document.querySelector("#text-filter").value.trim().toLowerCase();
  const matches = siteSlots.texts.filter((item) => {
    const current = siteOverrides.texts[item.key] ?? item.default;
    return !filter || current.toLowerCase().includes(filter) || item.default.toLowerCase().includes(filter);
  });
  list.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = "Aucun texte ne correspond à la recherche.";
    list.append(empty);
    return;
  }
  for (const item of matches) {
    const row = document.createElement("article");
    row.className = "content-row";
    const textarea = document.createElement("textarea");
    textarea.rows = Math.min(6, Math.max(2, Math.ceil(item.default.length / 90)));
    textarea.value = siteOverrides.texts[item.key] ?? item.default;
    const hint = document.createElement("p");
    hint.className = "content-hint";
    hint.textContent = `Texte d'origine : ${item.default.slice(0, 140)}${item.default.length > 140 ? "…" : ""} · ${item.pages.map(pageLabel).join(", ")}`;
    const actions = document.createElement("div");
    actions.className = "content-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "button button-dark";
    save.textContent = "Enregistrer";
    save.addEventListener("click", async () => {
      const value = textarea.value.trim();
      save.disabled = true;
      try {
        await saveContent(item.key, value === item.default ? "" : value);
        if (value && value !== item.default) siteOverrides.texts[item.key] = value;
        else delete siteOverrides.texts[item.key];
        setContentMessage("Texte enregistré. Il apparaît sur le site après rechargement de la page.", "success");
      } catch (error) {
        setContentMessage(error.message, "error");
      } finally {
        save.disabled = false;
      }
    });
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "text-button";
    reset.textContent = "Remettre le texte d'origine";
    reset.addEventListener("click", async () => {
      try {
        await saveContent(item.key, "");
        delete siteOverrides.texts[item.key];
        textarea.value = item.default;
        setContentMessage("Texte d'origine rétabli.", "success");
      } catch (error) {
        setContentMessage(error.message, "error");
      }
    });
    actions.append(save, reset);
    row.append(textarea, hint, actions);
    list.append(row);
  }
}

function renderImageRows() {
  const list = document.querySelector("#image-list");
  list.replaceChildren();
  const items = siteSlots.images.filter((item) => item.page === imagePage);
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "content-row content-image-row";
    const preview = document.createElement("div");
    preview.className = "content-image-preview";
    const current = siteOverrides.images[item.key];
    if (current) {
      const image = document.createElement("img");
      image.src = current;
      image.alt = "";
      preview.append(image);
    } else {
      preview.textContent = "Pas encore de photo";
    }
    const title = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.name || "Photo";
    const hint = document.createElement("p");
    hint.className = "content-hint";
    hint.textContent = `Emplacement n° ${item.index} · JPG, PNG ou WebP, 5 Mo maximum`;
    title.append(name, hint);
    const actions = document.createElement("div");
    actions.className = "content-actions";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.hidden = true;
    input.addEventListener("change", () => uploadSiteImage(item, input.files[0]));
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "button button-dark";
    choose.textContent = current ? "Changer la photo" : "Ajouter une photo";
    choose.addEventListener("click", () => input.click());
    actions.append(choose, input);
    if (current) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button text-danger";
      remove.textContent = "Retirer la photo";
      remove.addEventListener("click", () => removeSiteImage(item));
      actions.append(remove);
    }
    row.append(preview, title, actions);
    list.append(row);
  }
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = "Aucune photo modifiable sur cette page.";
    list.append(empty);
  }
}

async function uploadSiteImage(item, file) {
  if (!file) return;
  setContentMessage("Envoi de la photo…");
  try {
    const body = new FormData();
    body.append("image", file);
    const result = await api("/api/panel/upload", { method: "POST", body });
    await saveContent(item.key, result.imagePath);
    siteOverrides.images[item.key] = result.imagePath;
    renderImageRows();
    setContentMessage("Photo enregistrée. Ouvre la page du site et recharge-la pour la voir.", "success");
  } catch (error) {
    setContentMessage(error.message, "error");
  }
}

async function removeSiteImage(item) {
  if (!window.confirm("Retirer cette photo et remettre la case vide ?")) return;
  try {
    await saveContent(item.key, "");
    delete siteOverrides.images[item.key];
    renderImageRows();
    setContentMessage("Photo retirée.", "success");
  } catch (error) {
    setContentMessage(error.message, "error");
  }
}

async function loadSiteContent() {
  const response = await fetch("/cms-slots.json", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Impossible de charger la liste des éléments du site.");
  siteSlots = await response.json();
  const select = document.querySelector("#image-page");
  const pages = [...new Set(siteSlots.images.map((item) => item.page))];
  select.replaceChildren(...pages.map((page) => {
    const option = document.createElement("option");
    option.value = page;
    option.textContent = pageLabel(page);
    return option;
  }));
  imagePage = select.value;
  await loadSiteOverrides();
  renderTextRows();
  renderImageRows();
}

document.querySelector("#text-filter")?.addEventListener("input", renderTextRows);
document.querySelector("#image-page")?.addEventListener("change", async (event) => {
  imagePage = event.target.value;
  try {
    await loadSiteOverrides();
    renderImageRows();
  } catch (error) {
    setContentMessage(error.message, "error");
  }
});
function showContentTab(name) {
  const isTexts = name === "texts";
  document.querySelector("#content-texts-panel").hidden = !isTexts;
  document.querySelector("#content-images-panel").hidden = isTexts;
  document.querySelector("#tab-texts").setAttribute("aria-selected", String(isTexts));
  document.querySelector("#tab-images").setAttribute("aria-selected", String(!isTexts));
}
document.querySelector("#tab-texts")?.addEventListener("click", () => showContentTab("texts"));
document.querySelector("#tab-images")?.addEventListener("click", () => showContentTab("images"));

api("/api/auth/session").then(async (session) => {
  if (!session.authenticated || !["admin", "manager"].includes(session.role)) {
    window.location.assign("/ikrame");
    return;
  }
  document.querySelector("#admin-email").textContent = session.email;
  const isOwner = session.role === "admin";
  document.querySelectorAll(".owner-only").forEach((section) => { section.hidden = !isOwner; });
  const tasks = [loadProducts(), loadSiteContent().catch((error) => setContentMessage(error.message, "error"))];
  if (isOwner) tasks.push(loadAnalytics(), loadManagers());
  await Promise.all(tasks);
}).catch((error) => {
  document.querySelector("#list-message").textContent = error.message;
});