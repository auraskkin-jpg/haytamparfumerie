(async () => {
  const slug = decodeURIComponent(location.pathname.replace(/^\/marque\//, "").replace(/\/$/, ""));
  const money = (amount) => `${Number(amount).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DH`;
  const name = document.getElementById("brand-name");
  const logo = document.getElementById("brand-logo");
  const grid = document.getElementById("brand-products");
  const empty = document.getElementById("brand-empty");
  try {
    const response = await fetch(`/api/brands/${encodeURIComponent(slug)}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("brand not found");
    const brand = await response.json();
    document.title = `${brand.name || "Marque"} | Aura Skin`;
    name.textContent = brand.name || "";
    name.hidden = !brand.name;
    if (brand.image_path) {
      logo.src = brand.image_path;
      logo.alt = brand.name ? `Logo ${brand.name}` : "Logo de la marque";
      logo.hidden = false;
    }
    const products = brand.name
      ? await (await fetch(`/api/products?brand=${encodeURIComponent(brand.name)}`, { credentials: "same-origin" })).json()
      : [];
    if (!products.length) {
      empty.hidden = false;
      return;
    }
    for (const product of products) {
      const media = document.createElement("div");
      media.className = "media";
      if (product.imagePath) {
        const image = document.createElement("img");
        image.src = product.imagePath;
        image.alt = product.name;
        image.loading = "lazy";
        media.append(image);
      }
      const link = document.createElement("a");
      link.className = "item";
      link.href = `/product/${encodeURIComponent(product.slug)}`;
      const title = document.createElement("strong");
      title.textContent = product.name;
      const price = document.createElement("span");
      price.className = "price";
      price.textContent = money(product.price);
      link.append(media, title, price);
      if (product.soldOut) {
        const sold = document.createElement("em");
        sold.textContent = "Épuisé";
        link.append(sold);
      }
      grid.append(link);
    }
  } catch {
    name.textContent = "Marque introuvable";
    name.hidden = false;
  }
})();
