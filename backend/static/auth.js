async function submitAuthForm(form, endpoint, successMessage) {
  const message = form.querySelector(".form-message");
  const data = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Une erreur est survenue.");
    message.textContent = successMessage;
    message.dataset.state = "success";
    if (endpoint.endsWith("/login")) {
      window.location.assign(["admin", "manager"].includes(result.role) ? "/ikrame" : "/");
    } else {
      form.reset();
      window.setTimeout(() => window.location.assign("/login"), 900);
    }
  } catch (error) {
    message.textContent = error.message || "Le serveur est indisponible.";
    message.dataset.state = "error";
  }
}

document.querySelector("#login-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuthForm(event.currentTarget, "/api/auth/login", "Connexion réussie.");
});

document.querySelector("#register-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuthForm(event.currentTarget, "/api/auth/register", "Si cette adresse n’est pas encore utilisée, le compte est créé. Redirection vers la connexion…");
});

const socialMessages = {
  "not-configured": "Connexion sociale non configurée. Utilise email/mot de passe ou configure les clés OAuth dans backend/.env.",
  "account-exists": "Un compte avec cet email existe déjà. Connecte-toi avec ton mot de passe; les comptes ne sont jamais liés automatiquement.",
  "email-unverified": "Google n’a pas confirmé cette adresse email.",
  "email-required": "Le fournisseur doit partager une adresse email pour créer un compte.",
  cancelled: "Connexion sociale annulée.",
};

const socialError = new URLSearchParams(window.location.search).get("social");
if (socialError && socialMessages[socialError]) {
  const message = document.querySelector("#login-form .form-message");
  if (message) {
    message.textContent = socialMessages[socialError];
    message.dataset.state = "error";
  }
}

fetch("/api/auth/providers", { credentials: "same-origin" })
  .then((response) => response.ok ? response.json() : Promise.reject())
  .then((providers) => {
    document.querySelector("#google-login").hidden = !providers.google;
    document.querySelector("#facebook-login").hidden = !providers.facebook;
    const note = document.querySelector("#social-provider-note");
    if (!providers.google && !providers.facebook && note && !socialError) {
      note.textContent = "Google/Facebook deviennent disponibles après configuration des applications OAuth.";
    }
  })
  .catch(() => {
    const note = document.querySelector("#social-provider-note");
    if (note) note.textContent = "Connexion sociale indisponible pour le moment.";
  });