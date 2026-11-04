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

api("/api/auth/session").then(async (session) => {
  if (!session.authenticated || !["admin", "manager"].includes(session.role)) {
    window.location.assign("/ikrame");
    return;
  }
  document.querySelector("#admin-email").textContent = session.email;
  const isOwner = session.role === "admin";
  document.querySelectorAll(".owner-only").forEach((section) => { section.hidden = !isOwner; });
  const tasks = [loadProducts()];
  if (isOwner) tasks.push(loadAnalytics(), loadManagers());
  await Promise.all(tasks);
}).catch((error) => {
  document.querySelector("#list-message").textContent = error.message;
});