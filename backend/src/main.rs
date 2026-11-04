use std::{
    collections::HashMap,
    env,
    io::BufRead,
    net::SocketAddr,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng as RandomOsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    FromRow, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use tower_http::{services::ServeDir, trace::TraceLayer};
use url::form_urlencoded;
use uuid::Uuid;

const SESSION_COOKIE: &str = "aura_session";
const ADMIN_PATH: &str = "/ikrame";
const SESSION_SECONDS: i64 = 60 * 60 * 24 * 7;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MIN_PASSWORD_CHARS: usize = 12;
const LOGIN_WINDOW_SECONDS: i64 = 15 * 60;
const LOGIN_IP_LIMIT: u32 = 30;
const LOGIN_ACCOUNT_LIMIT: u32 = 5;
const REGISTER_WINDOW_SECONDS: i64 = 60 * 60;
const REGISTER_IP_LIMIT: u32 = 10;
const ANALYTICS_WINDOW_SECONDS: i64 = 60;
const ANALYTICS_IP_LIMIT: u32 = 120;
const STOREFRONT_CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const APP_CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    upload_dir: PathBuf,
    secure_cookie: bool,
    trust_proxy: bool,
    limiter: RateLimiter,
    dummy_hash: Arc<String>,
}

#[derive(Clone, Default)]
struct RateLimiter {
    buckets: Arc<Mutex<HashMap<String, (u32, i64)>>>,
}

impl RateLimiter {
    fn is_limited(&self, key: &str, limit: u32, window: i64) -> bool {
        let buckets = self.buckets.lock().unwrap_or_else(|poison| poison.into_inner());
        buckets
            .get(key)
            .is_some_and(|(count, start)| *count >= limit && now() - start < window)
    }

    fn record(&self, key: &str, window: i64) {
        let mut buckets = self.buckets.lock().unwrap_or_else(|poison| poison.into_inner());
        let timestamp = now();
        if buckets.len() > 10_000 {
            buckets.retain(|_, (_, start)| timestamp - *start < 86_400);
        }
        let entry = buckets.entry(key.to_owned()).or_insert((0, timestamp));
        if timestamp - entry.1 >= window {
            *entry = (0, timestamp);
        }
        entry.0 += 1;
    }

    fn clear(&self, key: &str) {
        self.buckets.lock().unwrap_or_else(|poison| poison.into_inner()).remove(key);
    }
}

fn too_many_attempts() -> ApiError {
    ApiError(StatusCode::TOO_MANY_REQUESTS, "Too many attempts. Please try again later.")
}

fn client_ip(headers: &HeaderMap, peer: SocketAddr, trust_proxy: bool) -> String {
    if trust_proxy {
        let real_ip = headers.get("x-real-ip").and_then(|value| value.to_str().ok()).map(str::trim);
        let forwarded = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next())
            .map(str::trim);
        if let Some(ip) = real_ip.or(forwarded).filter(|ip| !ip.is_empty()) {
            return ip.to_owned();
        }
    }
    peer.ip().to_string()
}

#[derive(Clone, Debug)]
struct AuthUser {
    email: String,
    role: String,
}

#[derive(Debug)]
struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

#[derive(Serialize, FromRow, Clone)]
struct Product {
    slug: String,
    name: String,
    brand: String,
    description: String,
    price_cents: i64,
    category: String,
    image_path: Option<String>,
    active: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicProduct {
    slug: String,
    name: String,
    brand: String,
    description: String,
    price: f64,
    category: String,
    image_path: Option<String>,
}

impl From<Product> for PublicProduct {
    fn from(product: Product) -> Self {
        Self {
            slug: product.slug,
            name: product.name,
            brand: product.brand,
            description: product.description,
            price: product.price_cents as f64 / 100.0,
            category: product.category,
            image_path: product.image_path,
        }
    }
}

#[derive(Serialize)]
struct SessionInfo {
    authenticated: bool,
    email: Option<String>,
    role: Option<String>,
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct ExportManagerInput {
    email: String,
    password: String,
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct ManagerAccount {
    id: String,
    email: String,
    created_at: i64,
}

#[derive(Clone, Copy)]
enum OAuthProvider {
    Google,
    Facebook,
}

impl OAuthProvider {
    fn key(self) -> &'static str {
        match self { Self::Google => "google", Self::Facebook => "facebook" }
    }

    fn callback_path(self) -> &'static str {
        match self { Self::Google => "/auth/google/callback", Self::Facebook => "/auth/facebook/callback" }
    }

    fn env_prefix(self) -> &'static str {
        match self { Self::Google => "GOOGLE", Self::Facebook => "FACEBOOK" }
    }
}

#[derive(FromRow)]
struct OAuthStateRow {
    code_verifier: String,
}

#[derive(Deserialize)]
struct OAuthTokenReply {
    access_token: String,
}

#[derive(Deserialize)]
struct GoogleProfile {
    sub: String,
    email: String,
    email_verified: bool,
}

#[derive(Deserialize)]
struct FacebookProfile {
    id: String,
    email: Option<String>,
}

#[derive(Deserialize)]
struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct SocialProviderStatus {
    google: bool,
    facebook: bool,
}

fn oauth_config(provider: OAuthProvider) -> Option<(String, String, String)> {
    let prefix = provider.env_prefix();
    let client_id = env::var(format!("{prefix}_CLIENT_ID")).ok()?;
    let client_secret = env::var(format!("{prefix}_CLIENT_SECRET")).ok()?;
    let redirect_url = env::var(format!("{prefix}_REDIRECT_URL")).ok()?;
    let local_http = env::var("COOKIE_SECURE").is_ok_and(|value| value == "false")
        && (redirect_url.starts_with("http://localhost:") || redirect_url.starts_with("http://127.0.0.1:"));
    if client_id.trim().is_empty() || client_secret.trim().is_empty() || !(redirect_url.starts_with("https://") || local_http) {
        return None;
    }
    Some((client_id, client_secret, redirect_url))
}

fn oauth_state_cookie_name(provider: OAuthProvider) -> String {
    format!("aura_oauth_{}", provider.key())
}

fn oauth_state_cookie(value: &str, provider: OAuthProvider, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{}={value}; Path={}; Max-Age=600; HttpOnly; SameSite=Lax{secure}", oauth_state_cookie_name(provider), provider.callback_path())
}

fn clear_oauth_state_cookie(provider: OAuthProvider, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{}=; Path={}; Max-Age=0; HttpOnly; SameSite=Lax{secure}", oauth_state_cookie_name(provider), provider.callback_path())
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(header::COOKIE)?.to_str().ok()?.split(';').map(str::trim)
        .find_map(|cookie| cookie.strip_prefix(&format!("{name}=")).map(str::to_owned))
}

fn social_redirect(path: &'static str) -> Response {
    Redirect::to(path).into_response()
}

async fn social_providers() -> Json<SocialProviderStatus> {
    Json(SocialProviderStatus {
        google: oauth_config(OAuthProvider::Google).is_some(),
        facebook: oauth_config(OAuthProvider::Facebook).is_some(),
    })
}

async fn start_oauth(State(state): State<AppState>, provider: OAuthProvider) -> Response {
    let Some((client_id, _, redirect_url)) = oauth_config(provider) else {
        return social_redirect("/login?social=not-configured");
    };
    let state_token = new_token();
    let verifier = new_token();
    let timestamp = now();
    if sqlx::query("INSERT INTO oauth_states (state_hash, provider, code_verifier, expires_at) VALUES (?, ?, ?, ?)")
        .bind(hash_token(&state_token)).bind(provider.key()).bind(&verifier).bind(timestamp + 600)
        .execute(&state.pool).await.is_err()
    {
        return social_redirect("/login?social=unavailable");
    }

    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut query = form_urlencoded::Serializer::new(String::new());
    query.append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_url)
        .append_pair("response_type", "code")
        .append_pair("state", &state_token);
    let authorization_url = match provider {
        OAuthProvider::Google => {
            query.append_pair("scope", "openid email profile")
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("access_type", "online");
            format!("https://accounts.google.com/o/oauth2/v2/auth?{}", query.finish())
        }
        OAuthProvider::Facebook => {
            query.append_pair("scope", "email,public_profile");
            format!("https://www.facebook.com/dialog/oauth?{}", query.finish())
        }
    };
    let mut response = Redirect::temporary(&authorization_url).into_response();
    if let Ok(cookie) = HeaderValue::from_str(&oauth_state_cookie(&state_token, provider, state.secure_cookie)) {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
}

async fn start_google_oauth(State(state): State<AppState>) -> Response {
    start_oauth(State(state), OAuthProvider::Google).await
}

async fn start_facebook_oauth(State(state): State<AppState>) -> Response {
    start_oauth(State(state), OAuthProvider::Facebook).await
}

fn clear_oauth_cookie(response: &mut Response, provider: OAuthProvider, secure: bool) {
    if let Ok(cookie) = HeaderValue::from_str(&clear_oauth_state_cookie(provider, secure)) {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
}

async fn issue_social_session(state: &AppState, user_id: &str, role: &str) -> ApiResult<Response> {
    let token = new_token();
    let timestamp = now();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(hash_token(&token)).bind(user_id).bind(timestamp + SESSION_SECONDS).bind(timestamp)
        .execute(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not create session"))?;
    let destination = if role == "admin" || role == "manager" { ADMIN_PATH } else { "/" };
    let mut response = Redirect::to(destination).into_response();
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&session_cookie(&token, state.secure_cookie))
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not set session cookie"))?);
    Ok(response)
}

async fn complete_oauth(
    state: AppState,
    provider: OAuthProvider,
    headers: HeaderMap,
    query: OAuthCallbackQuery,
) -> Response {
    let Some(state_token) = query.state else { return social_redirect("/login?social=invalid-state"); };
    let state_cookie = cookie_value(&headers, &oauth_state_cookie_name(provider));
    if state_cookie.as_deref() != Some(state_token.as_str()) {
        let mut response = social_redirect("/login?social=invalid-state");
        clear_oauth_cookie(&mut response, provider, state.secure_cookie);
        return response;
    }
    if query.error.is_some() {
        let mut response = social_redirect("/login?social=cancelled");
        clear_oauth_cookie(&mut response, provider, state.secure_cookie);
        return response;
    }
    let Some(code) = query.code else { return social_redirect("/login?social=invalid-response"); };
    let Some((client_id, client_secret, redirect_url)) = oauth_config(provider) else {
        return social_redirect("/login?social=not-configured");
    };
    let state_hash = hash_token(&state_token);
    let oauth_state = sqlx::query_as::<_, OAuthStateRow>("SELECT code_verifier FROM oauth_states WHERE state_hash = ? AND provider = ? AND expires_at > ?")
        .bind(&state_hash).bind(provider.key()).bind(now())
        .fetch_optional(&state.pool).await;
    let Ok(Some(oauth_state)) = oauth_state else {
        let mut response = social_redirect("/login?social=expired-state");
        clear_oauth_cookie(&mut response, provider, state.secure_cookie);
        return response;
    };
    let _ = sqlx::query("DELETE FROM oauth_states WHERE state_hash = ?").bind(state_hash).execute(&state.pool).await;
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(8)).build() {
        Ok(client) => client,
        Err(_) => return social_redirect("/login?social=unavailable"),
    };
    let token_response = match provider {
        OAuthProvider::Google => client.post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", client_id.as_str()), ("client_secret", client_secret.as_str()),
                ("code", code.as_str()), ("code_verifier", oauth_state.code_verifier.as_str()),
                ("grant_type", "authorization_code"), ("redirect_uri", redirect_url.as_str()),
            ]).send().await,
        OAuthProvider::Facebook => client.get("https://graph.facebook.com/oauth/access_token")
            .query(&[
                ("client_id", client_id.as_str()), ("client_secret", client_secret.as_str()),
                ("code", code.as_str()), ("redirect_uri", redirect_url.as_str()),
            ]).send().await,
    };
    let token_response = match token_response {
        Ok(response) if response.status().is_success() => response,
        _ => {
            let mut response = social_redirect("/login?social=provider-error");
            clear_oauth_cookie(&mut response, provider, state.secure_cookie);
            return response;
        }
    };
    let token = match token_response.json::<OAuthTokenReply>().await {
        Ok(token) => token.access_token,
        Err(_) => return social_redirect("/login?social=provider-error"),
    };
    let (subject, email) = match provider {
        OAuthProvider::Google => {
            let profile = client.get("https://openidconnect.googleapis.com/v1/userinfo")
                .bearer_auth(&token).send().await;
            match profile {
                Ok(response) if response.status().is_success() => match response.json::<GoogleProfile>().await {
                    Ok(profile) if profile.email_verified => (profile.sub, profile.email),
                    _ => return social_redirect("/login?social=email-unverified"),
                },
                _ => return social_redirect("/login?social=provider-error"),
            }
        }
        OAuthProvider::Facebook => {
            let profile = client.get("https://graph.facebook.com/me")
                .query(&[("fields", "id,email")]).bearer_auth(&token).send().await;
            match profile {
                Ok(response) if response.status().is_success() => match response.json::<FacebookProfile>().await {
                    Ok(profile) => match profile.email {
                        Some(email) => (profile.id, email),
                        None => return social_redirect("/login?social=email-required"),
                    },
                    Err(_) => return social_redirect("/login?social=provider-error"),
                },
                _ => return social_redirect("/login?social=provider-error"),
            }
        }
    };
    let email = email.trim().to_lowercase();
    if !valid_email(&email) {
        return social_redirect("/login?social=email-required");
    }
    let identity = sqlx::query_as::<_, (String,)>("SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?")
        .bind(provider.key()).bind(&subject).fetch_optional(&state.pool).await;
    let identity = match identity {
        Ok(identity) => identity,
        Err(_) => return social_redirect("/login?social=unavailable"),
    };
    let (user_id, role) = if let Some((user_id,)) = identity {
        match sqlx::query_as::<_, (String, String)>("SELECT users.id, COALESCE(staff_roles.role, users.role) FROM users LEFT JOIN staff_roles ON staff_roles.user_id = users.id WHERE users.id = ?")
            .bind(user_id).fetch_optional(&state.pool).await {
                Ok(Some(user)) => user,
                _ => return social_redirect("/login?social=account-unavailable"),
            }
    } else {
        let email_exists: Result<Option<(String,)>, _> = sqlx::query_as("SELECT id FROM users WHERE email = ?").bind(&email).fetch_optional(&state.pool).await;
        match email_exists {
            Ok(Some(_)) => return social_redirect("/login?social=account-exists"),
            Err(_) => return social_redirect("/login?social=unavailable"),
            Ok(None) => {}
        }
        let user_id = Uuid::new_v4().to_string();
        let random_password_hash = match password_hash(&new_token()) {
            Ok(hash) => hash,
            Err(_) => return social_redirect("/login?social=unavailable"),
        };
        let mut transaction = match state.pool.begin().await {
            Ok(transaction) => transaction,
            Err(_) => return social_redirect("/login?social=unavailable"),
        };
        if sqlx::query("INSERT INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,'customer',?)")
            .bind(&user_id).bind(&email).bind(random_password_hash).bind(now()).execute(&mut *transaction).await.is_err()
            || sqlx::query("INSERT INTO oauth_identities (provider,subject,user_id,email,created_at) VALUES (?,?,?,?,?)")
                .bind(provider.key()).bind(subject).bind(&user_id).bind(email).bind(now()).execute(&mut *transaction).await.is_err()
            || transaction.commit().await.is_err()
        {
            return social_redirect("/login?social=account-exists");
        }
        (user_id, "customer".to_owned())
    };
    let mut response = match issue_social_session(&state, &user_id, &role).await {
        Ok(response) => response,
        Err(_) => social_redirect("/login?social=unavailable"),
    };
    clear_oauth_cookie(&mut response, provider, state.secure_cookie);
    response
}

async fn google_oauth_callback(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<OAuthCallbackQuery>) -> Response {
    complete_oauth(state, OAuthProvider::Google, headers, query).await
}

async fn facebook_oauth_callback(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<OAuthCallbackQuery>) -> Response {
    complete_oauth(state, OAuthProvider::Facebook, headers, query).await
}

#[derive(Deserialize)]
struct ProductInput {
    slug: Option<String>,
    name: String,
    brand: String,
    description: String,
    price: f64,
    category: String,
    image_path: Option<String>,
}

#[derive(Deserialize)]
struct ProductFilter {
    category: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyticsEventInput {
    event_id: String,
    session_id: String,
    kind: String,
    path: String,
    target: Option<String>,
    depth: Option<i64>,
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct AnalyticsCount {
    label: String,
    count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyticsOverview {
    days: i64,
    visitors: i64,
    page_views: i64,
    link_clicks: i64,
    scroll_75: i64,
    top_pages: Vec<AnalyticsCount>,
    top_links: Vec<AnalyticsCount>,
    scroll_depths: Vec<AnalyticsCount>,
}

#[derive(FromRow)]
struct UserRow {
    id: String,
    password_hash: String,
    role: String,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn password_hash(password: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not secure password"))
}

fn valid_email(email: &str) -> bool {
    let email = email.trim();
    email.len() <= 254
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.is_empty()
                && domain.contains('.')
                && !email.chars().any(char::is_whitespace)
        })
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            separator = false;
        } else if !slug.is_empty() && !separator {
            slug.push('-');
            separator = true;
        }
    }
    slug.trim_matches('-').chars().take(80).collect()
}

fn validate_product(input: &ProductInput) -> ApiResult<(String, i64, Option<String>)> {
    let slug = slugify(input.slug.as_deref().unwrap_or(&input.name));
    let name = input.name.trim();
    if slug.is_empty() || name.is_empty() || name.len() > 160 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Product name or slug is invalid"));
    }
    if input.brand.len() > 120 || input.description.len() > 10_000 || input.category.len() > 80 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "A product field is too long"));
    }
    if !input.price.is_finite() || !(0.0..=100_000_000.0).contains(&input.price) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Price must be a valid non-negative amount"));
    }
    let image = input.image_path.as_ref().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
    if image.as_ref().is_some_and(|value| {
        !value.starts_with("/assets/products/") || value.contains("..") || value.len() > 240
    }) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Product image path is invalid"));
    }
    Ok((slug, (input.price * 100.0).round() as i64, image))
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|cookie| cookie.strip_prefix(&format!("{SESSION_COOKIE}=")).map(str::to_owned))
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn new_token() -> String {
    let mut bytes = [0_u8; 32];
    RandomOsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn session_cookie(token: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Strict{secure}")
}

fn expired_cookie(secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{secure}")
}

fn check_origin(headers: &HeaderMap) -> ApiResult<()> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError(StatusCode::FORBIDDEN, "Request origin is required"))?;
    let authority = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or("");
    if authority.is_empty() || !authority.eq_ignore_ascii_case(host) {
        return Err(ApiError(StatusCode::FORBIDDEN, "Cross-origin request rejected"));
    }
    Ok(())
}

async fn current_user(state: &AppState, headers: &HeaderMap) -> Option<AuthUser> {
    let token = cookie_token(headers)?;
    let token_hash = hash_token(&token);
    sqlx::query_as::<_, AuthUserRow>(
        "SELECT users.email, COALESCE(staff_roles.role, users.role) AS role FROM users JOIN sessions ON sessions.user_id = users.id LEFT JOIN staff_roles ON staff_roles.user_id = users.id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
    )
    .bind(token_hash)
    .bind(now())
    .fetch_optional(&state.pool)
    .await
    .ok()?
    .map(|user| AuthUser { email: user.email, role: user.role })
}

#[derive(FromRow)]
struct AuthUserRow {
    email: String,
    role: String,
}

async fn require_admin(state: &AppState, headers: &HeaderMap) -> ApiResult<AuthUser> {
    match current_user(state, headers).await {
        Some(user) if user.role == "admin" || user.role == "manager" => Ok(user),
        Some(_) => Err(ApiError(StatusCode::FORBIDDEN, "Administrator access required")),
        None => Err(ApiError(StatusCode::UNAUTHORIZED, "Please sign in")),
    }
}

async fn require_owner(state: &AppState, headers: &HeaderMap) -> ApiResult<AuthUser> {
    match current_user(state, headers).await {
        Some(user) if user.role == "admin" => Ok(user),
        Some(_) => Err(ApiError(StatusCode::FORBIDDEN, "Owner access required")),
        None => Err(ApiError(StatusCode::UNAUTHORIZED, "Please sign in")),
    }
}

async fn register(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(input): Json<Credentials>) -> ApiResult<impl IntoResponse> {
    check_origin(&headers)?;
    let ip_key = format!("register:{}", client_ip(&headers, peer, state.trust_proxy));
    if state.limiter.is_limited(&ip_key, REGISTER_IP_LIMIT, REGISTER_WINDOW_SECONDS) {
        return Err(too_many_attempts());
    }
    state.limiter.record(&ip_key, REGISTER_WINDOW_SECONDS);
    let email = input.email.trim().to_lowercase();
    if !valid_email(&email) || input.password.chars().count() < MIN_PASSWORD_CHARS || input.password.len() > 256 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Use a valid email and a password of at least 12 characters"));
    }
    let hash = password_hash(&input.password)?;
    let result = sqlx::query("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'customer', ?)")
        .bind(Uuid::new_v4().to_string())
        .bind(email)
        .bind(hash)
        .bind(now())
        .execute(&state.pool)
        .await;
    match result {
        Ok(_) => Ok((StatusCode::CREATED, Json(serde_json::json!({ "ok": true })))),
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
            Ok((StatusCode::CREATED, Json(serde_json::json!({ "ok": true }))))
        }
        Err(_) => Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not create account")),
    }
}

async fn login(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(input): Json<Credentials>) -> ApiResult<Response> {
    check_origin(&headers)?;
    let email = input.email.trim().to_lowercase();
    let ip_key = format!("login-ip:{}", client_ip(&headers, peer, state.trust_proxy));
    let account_key = format!("login-account:{email}");
    if state.limiter.is_limited(&ip_key, LOGIN_IP_LIMIT, LOGIN_WINDOW_SECONDS)
        || state.limiter.is_limited(&account_key, LOGIN_ACCOUNT_LIMIT, LOGIN_WINDOW_SECONDS)
    {
        return Err(too_many_attempts());
    }
    let user = sqlx::query_as::<_, UserRow>("SELECT users.id, users.password_hash, COALESCE(staff_roles.role, users.role) AS role FROM users LEFT JOIN staff_roles ON staff_roles.user_id = users.id WHERE users.email = ?")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not sign in"))?;
    let stored_hash = user.as_ref().map_or(state.dummy_hash.as_str(), |user| user.password_hash.as_str());
    let password_ok = PasswordHash::new(stored_hash)
        .ok()
        .is_some_and(|hash| Argon2::default().verify_password(input.password.as_bytes(), &hash).is_ok());
    let Some(user) = user.filter(|_| password_ok) else {
        state.limiter.record(&ip_key, LOGIN_WINDOW_SECONDS);
        state.limiter.record(&account_key, LOGIN_WINDOW_SECONDS);
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Email or password is incorrect"));
    };
    state.limiter.clear(&account_key);
    let _ = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?").bind(now()).execute(&state.pool).await;
    let token = new_token();
    let timestamp = now();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(hash_token(&token))
        .bind(&user.id)
        .bind(timestamp + SESSION_SECONDS)
        .bind(timestamp)
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not create session"))?;
    let mut response = Json(serde_json::json!({ "ok": true, "role": user.role })).into_response();
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&session_cookie(&token, state.secure_cookie)).map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not set session cookie"))?);
    Ok(response)
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    check_origin(&headers)?;
    if let Some(token) = cookie_token(&headers) {
        let _ = sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash_token(&token))
            .execute(&state.pool)
            .await;
    }
    let mut response = Json(serde_json::json!({ "ok": true })).into_response();
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&expired_cookie(state.secure_cookie)).map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not clear session"))?);
    Ok(response)
}

async fn session(State(state): State<AppState>, headers: HeaderMap) -> Json<SessionInfo> {
    match current_user(&state, &headers).await {
        Some(user) => Json(SessionInfo { authenticated: true, email: Some(user.email), role: Some(user.role) }),
        None => Json(SessionInfo { authenticated: false, email: None, role: None }),
    }
}

async fn list_products(State(state): State<AppState>, Query(filter): Query<ProductFilter>) -> ApiResult<Json<Vec<PublicProduct>>> {
    let rows = if let Some(category) = filter.category.filter(|value| !value.is_empty()) {
        sqlx::query_as::<_, Product>("SELECT slug, name, brand, description, price_cents, category, image_path, active FROM products WHERE active = 1 AND category = ? ORDER BY created_at DESC LIMIT 200")
            .bind(category)
            .fetch_all(&state.pool)
            .await
    } else {
        sqlx::query_as::<_, Product>("SELECT slug, name, brand, description, price_cents, category, image_path, active FROM products WHERE active = 1 ORDER BY created_at DESC LIMIT 200")
            .fetch_all(&state.pool)
            .await
    }
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load products"))?;
    Ok(Json(rows.into_iter().map(PublicProduct::from).collect()))
}

async fn get_product(State(state): State<AppState>, Path(slug): Path<String>) -> ApiResult<Json<PublicProduct>> {
    let row = sqlx::query_as::<_, Product>("SELECT slug, name, brand, description, price_cents, category, image_path, active FROM products WHERE slug = ? AND active = 1")
        .bind(slug)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load product"))?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "Product not found"))?;
    Ok(Json(PublicProduct::from(row)))
}

async fn admin_products(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Vec<Product>>> {
    require_admin(&state, &headers).await?;
    let rows = sqlx::query_as::<_, Product>("SELECT slug, name, brand, description, price_cents, category, image_path, active FROM products ORDER BY created_at DESC LIMIT 500")
        .fetch_all(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load products"))?;
    Ok(Json(rows))
}

fn csv_cell(value: &str) -> String {
    let value = if value.trim_start().starts_with(['=', '+', '-', '@']) {
        format!("'{}", value)
    } else {
        value.to_owned()
    };
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn csv_download(filename: &'static str, content: String) -> Response {
    let mut response = Response::new(axum::body::Body::from(format!("\u{feff}{content}")));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/csv; charset=utf-8"));
    response.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_static(filename));
    response
}

async fn export_products(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_owner(&state, &headers).await?;
    let products = sqlx::query_as::<_, Product>("SELECT slug, name, brand, description, price_cents, category, image_path, active FROM products ORDER BY name COLLATE NOCASE")
        .fetch_all(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not export products"))?;
    let mut csv = String::from("slug,name,brand,price_dh,category,description,image_path,active\r\n");
    for product in products {
        let fields = [
            product.slug,
            product.name,
            product.brand,
            format!("{:.2}", product.price_cents as f64 / 100.0),
            product.category,
            product.description,
            product.image_path.unwrap_or_default(),
            if product.active == 1 { "yes".to_owned() } else { "no".to_owned() },
        ];
        csv.push_str(&fields.iter().map(|field| csv_cell(field)).collect::<Vec<_>>().join(","));
        csv.push_str("\r\n");
    }
    Ok(csv_download("attachment; filename=products.csv", csv))
}

async fn export_customer_emails(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_owner(&state, &headers).await?;
    let emails: Vec<(String,)> = sqlx::query_as("SELECT email FROM users WHERE role = 'customer' AND id NOT IN (SELECT user_id FROM staff_roles) ORDER BY email COLLATE NOCASE")
        .fetch_all(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not export customer emails"))?;
    let mut csv = String::from("Email\r\n");
    for (email,) in emails {
        csv.push_str(&csv_cell(&email));
        csv.push_str("\r\n");
    }
    Ok(csv_download("attachment; filename=customer-emails.csv", csv))
}

async fn list_managers(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Vec<ManagerAccount>>> {
    require_owner(&state, &headers).await?;
    let managers = sqlx::query_as::<_, ManagerAccount>("SELECT users.id, users.email, staff_roles.created_at FROM users JOIN staff_roles ON staff_roles.user_id = users.id WHERE staff_roles.role = 'manager' ORDER BY users.created_at DESC")
        .fetch_all(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load managers"))?;
    Ok(Json(managers))
}

async fn create_manager(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<ExportManagerInput>) -> ApiResult<impl IntoResponse> {
    check_origin(&headers)?;
    require_owner(&state, &headers).await?;
    let email = input.email.trim().to_lowercase();
    if !valid_email(&email) || input.password.chars().count() < 12 || input.password.len() > 256 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Use a valid email and a password of at least 12 characters"));
    }
    let password_hash = password_hash(&input.password)?;
    let user_id = Uuid::new_v4().to_string();
    let timestamp = now();
    let mut transaction = state.pool.begin().await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not create manager"))?;
    let inserted = sqlx::query("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'customer', ?)")
        .bind(&user_id)
        .bind(&email)
        .bind(password_hash)
        .bind(timestamp)
        .execute(&mut *transaction)
        .await;
    if let Err(sqlx::Error::Database(error)) = inserted {
        if error.is_unique_violation() {
            return Err(ApiError(StatusCode::CONFLICT, "An account with that email already exists"));
        }
        return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not create manager"));
    }
    sqlx::query("INSERT INTO staff_roles (user_id, role, created_at) VALUES (?, 'manager', ?)")
        .bind(user_id)
        .bind(timestamp)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not assign manager role"))?;
    transaction.commit().await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not create manager"))?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "ok": true }))))
}

async fn revoke_manager(State(state): State<AppState>, Path(user_id): Path<String>, headers: HeaderMap) -> ApiResult<Json<serde_json::Value>> {
    check_origin(&headers)?;
    require_owner(&state, &headers).await?;
    let result = sqlx::query("DELETE FROM users WHERE id = ? AND role = 'customer' AND id IN (SELECT user_id FROM staff_roles WHERE role = 'manager')")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not revoke manager"))?;
    if result.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Manager not found"));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn create_product(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<ProductInput>) -> ApiResult<impl IntoResponse> {
    check_origin(&headers)?;
    require_admin(&state, &headers).await?;
    let (slug, price, image) = validate_product(&input)?;
    let timestamp = now();
    let result = sqlx::query("INSERT INTO products (slug, name, brand, description, price_cents, category, image_path, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .bind(slug)
        .bind(input.name.trim())
        .bind(input.brand.trim())
        .bind(input.description.trim())
        .bind(price)
        .bind(slugify(&input.category))
        .bind(image)
        .bind(timestamp)
        .bind(timestamp)
        .execute(&state.pool)
        .await;
    match result {
        Ok(_) => Ok((StatusCode::CREATED, Json(serde_json::json!({ "ok": true })))),
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
            Err(ApiError(StatusCode::CONFLICT, "A product with that slug already exists"))
        }
        Err(_) => Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not save product")),
    }
}

async fn update_product(State(state): State<AppState>, Path(slug): Path<String>, headers: HeaderMap, Json(input): Json<ProductInput>) -> ApiResult<Json<serde_json::Value>> {
    check_origin(&headers)?;
    require_admin(&state, &headers).await?;
    let (_, price, image) = validate_product(&input)?;
    let result = sqlx::query("UPDATE products SET name = ?, brand = ?, description = ?, price_cents = ?, category = ?, image_path = ?, updated_at = ? WHERE slug = ?")
        .bind(input.name.trim())
        .bind(input.brand.trim())
        .bind(input.description.trim())
        .bind(price)
        .bind(slugify(&input.category))
        .bind(image)
        .bind(now())
        .bind(slug)
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not update product"))?;
    if result.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Product not found"));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_product(State(state): State<AppState>, Path(slug): Path<String>, headers: HeaderMap) -> ApiResult<Json<serde_json::Value>> {
    check_origin(&headers)?;
    require_admin(&state, &headers).await?;
    let result = sqlx::query("DELETE FROM products WHERE slug = ?")
        .bind(slug)
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete product"))?;
    if result.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Product not found"));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn valid_analytics_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 240
        && !path.contains(['?', '#', '\\'])
        && !path.chars().any(char::is_control)
}

async fn record_analytics_event(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(event): Json<AnalyticsEventInput>,
) -> ApiResult<impl IntoResponse> {
    check_origin(&headers)?;
    let ip_key = format!("analytics:{}", client_ip(&headers, peer, state.trust_proxy));
    if state.limiter.is_limited(&ip_key, ANALYTICS_IP_LIMIT, ANALYTICS_WINDOW_SECONDS) {
        return Err(too_many_attempts());
    }
    state.limiter.record(&ip_key, ANALYTICS_WINDOW_SECONDS);
    if event.event_id.len() > 80
        || !event.event_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-')
        || event.session_id.len() > 80
        || event.session_id.is_empty()
        || !event.session_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-')
        || !valid_analytics_path(&event.path)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Invalid analytics event"));
    }
    let target = event.target.filter(|target| valid_analytics_path(target));
    let depth = match event.kind.as_str() {
        "page_view" if event.depth.is_none() && target.is_none() => None,
        "link_click" if event.depth.is_none() && target.is_some() => None,
        "scroll" if target.is_none() && matches!(event.depth, Some(25 | 50 | 75 | 100)) => event.depth,
        _ => return Err(ApiError(StatusCode::BAD_REQUEST, "Invalid analytics event type")),
    };
    sqlx::query("INSERT OR IGNORE INTO analytics_events (event_id, session_id, kind, path, target, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(event.event_id)
        .bind(event.session_id)
        .bind(event.kind)
        .bind(event.path)
        .bind(target)
        .bind(depth)
        .bind(now())
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not record analytics event"))?;
    Ok((StatusCode::ACCEPTED, Json(serde_json::json!({ "ok": true }))))
}

async fn admin_analytics(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<AnalyticsOverview>> {
    require_owner(&state, &headers).await?;
    let days = params.get("days").and_then(|value| value.parse::<i64>().ok()).unwrap_or(30).clamp(7, 90);
    let since = now() - days * 86_400;
    let visitors: (i64,) = sqlx::query_as("SELECT COUNT(DISTINCT session_id) FROM analytics_events WHERE kind = 'page_view' AND created_at >= ?")
        .bind(since).fetch_one(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load analytics"))?;
    let page_views: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM analytics_events WHERE kind = 'page_view' AND created_at >= ?")
        .bind(since).fetch_one(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load analytics"))?;
    let link_clicks: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM analytics_events WHERE kind = 'link_click' AND created_at >= ?")
        .bind(since).fetch_one(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load analytics"))?;
    let scroll_75: (i64,) = sqlx::query_as("SELECT COUNT(DISTINCT session_id) FROM analytics_events WHERE kind = 'scroll' AND depth >= 75 AND created_at >= ?")
        .bind(since).fetch_one(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load analytics"))?;
    let top_pages = sqlx::query_as::<_, AnalyticsCount>("SELECT path AS label, COUNT(*) AS count FROM analytics_events WHERE kind = 'page_view' AND created_at >= ? GROUP BY path ORDER BY count DESC LIMIT 10")
        .bind(since).fetch_all(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load popular pages"))?;
    let top_links = sqlx::query_as::<_, AnalyticsCount>("SELECT target AS label, COUNT(*) AS count FROM analytics_events WHERE kind = 'link_click' AND created_at >= ? GROUP BY target ORDER BY count DESC LIMIT 10")
        .bind(since).fetch_all(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load link clicks"))?;
    let scroll_depths = sqlx::query_as::<_, AnalyticsCount>("SELECT CAST(depth AS TEXT) || '%' AS label, COUNT(DISTINCT session_id) AS count FROM analytics_events WHERE kind = 'scroll' AND created_at >= ? GROUP BY depth ORDER BY depth")
        .bind(since).fetch_all(&state.pool).await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load scroll depth"))?;
    Ok(Json(AnalyticsOverview {
        days, visitors: visitors.0, page_views: page_views.0, link_clicks: link_clicks.0,
        scroll_75: scroll_75.0, top_pages, top_links, scroll_depths,
    }))
}

async fn upload_product_image(State(state): State<AppState>, headers: HeaderMap, mut multipart: Multipart) -> ApiResult<Json<serde_json::Value>> {
    check_origin(&headers)?;
    require_admin(&state, &headers).await?;
    while let Some(field) = multipart.next_field().await.map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid image upload"))? {
        if field.name() != Some("image") {
            continue;
        }
        let content_type = field.content_type().unwrap_or("").to_ascii_lowercase();
        let extension = match content_type.as_str() {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/webp" => "webp",
            _ => return Err(ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Only JPEG, PNG or WebP images are accepted")),
        };
        let bytes = field.bytes().await.map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Could not read uploaded image"))?;
        let signature_valid = match extension {
            "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "webp" => bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
            _ => false,
        };
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES || !signature_valid {
            return Err(ApiError(StatusCode::BAD_REQUEST, "Image is invalid or exceeds 5 MB"));
        }
        tokio::fs::create_dir_all(&state.upload_dir).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not prepare image storage"))?;
        let filename = format!("{}.{}", Uuid::new_v4(), extension);
        tokio::fs::write(state.upload_dir.join(&filename), &bytes).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not save image"))?;
        return Ok(Json(serde_json::json!({ "imagePath": format!("/assets/products/{filename}") })));
    }
    Err(ApiError(StatusCode::BAD_REQUEST, "Choose an image file"))
}

async fn admin_page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let mut response = match current_user(&state, &headers).await {
        Some(user) if user.role == "admin" || user.role == "manager" => Html(include_str!("../static/admin.html")).into_response(),
        _ => Html(include_str!("../static/login.html")).into_response(),
    };
    response.headers_mut().insert(HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex, nofollow"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn login_page() -> Html<&'static str> { Html(include_str!("../static/login.html")) }
async fn register_page() -> Html<&'static str> { Html(include_str!("../static/register.html")) }
async fn panel_css() -> axum::response::Response { ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], include_str!("../static/panel.css")).into_response() }
async fn auth_js() -> axum::response::Response { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../static/auth.js")).into_response() }
async fn panel_js() -> axum::response::Response { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../static/panel.js")).into_response() }
async fn product_css() -> axum::response::Response { ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], include_str!("../static/product.css")).into_response() }

async fn dynamic_product_page(State(state): State<AppState>, Path(slug): Path<String>) -> ApiResult<Html<&'static str>> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT slug FROM products WHERE slug = ? AND active = 1")
        .bind(slug)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not load product"))?;
    exists.ok_or(ApiError(StatusCode::NOT_FOUND, "Product not found"))?;
    Ok(Html(include_str!("../static/product.html")))
}

async fn health() -> Json<serde_json::Value> { Json(serde_json::json!({ "ok": true })) }

fn is_app_page(path: &str) -> bool {
    [ADMIN_PATH, "/login", "/register", "/product/", "/api/", "/auth/"].iter().any(|prefix| path.starts_with(prefix))
}

async fn security_headers(request: axum::extract::Request, next: Next) -> Response {
    let csp = if is_app_page(request.uri().path()) { APP_CSP } else { STOREFRONT_CSP };
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(csp));
    headers.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=31536000"));
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), payment=()"),
    );
    response
}

async fn bootstrap_admin(pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error>> {
    if env::var_os("ADMIN_PASSWORD").is_some() {
        return Err("ADMIN_PASSWORD is no longer accepted. Run `aura-store-backend hash-password` and set ADMIN_PASSWORD_HASH instead.".into());
    }
    let email = env::var("ADMIN_EMAIL").ok();
    let hash = env::var("ADMIN_PASSWORD_HASH").ok();
    match (email, hash) {
        (None, None) => Ok(()),
        (Some(email), Some(hash)) => {
            let email = email.trim().to_lowercase();
            if !valid_email(&email) {
                return Err("ADMIN_EMAIL must be a valid email address".into());
            }
            if !hash.starts_with("$argon2id$") || PasswordHash::new(&hash).is_err() {
                return Err("ADMIN_PASSWORD_HASH must be an Argon2id hash from `aura-store-backend hash-password`".into());
            }
            let existing: Option<(String,)> = sqlx::query_as("SELECT role FROM users WHERE email = ?")
                .bind(&email)
                .fetch_optional(pool)
                .await?;
            if existing.is_some_and(|(role,)| role != "admin") {
                return Err("ADMIN_EMAIL belongs to a non-admin account; use a different administrator email".into());
            }
            sqlx::query("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash")
                .bind(Uuid::new_v4().to_string())
                .bind(&email)
                .bind(hash)
                .bind(now())
                .execute(pool)
                .await?;
            println!("Bootstrapped administrator account from environment.");
            Ok(())
        }
        _ => Err("Set both ADMIN_EMAIL and ADMIN_PASSWORD_HASH, or neither".into()),
    }
}

#[cfg(unix)]
fn restrict_database_files(database_url: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = database_url.strip_prefix("sqlite://").unwrap_or(database_url).split('?').next().unwrap_or_default();
    for suffix in ["", "-wal", "-shm"] {
        let file = format!("{path}{suffix}");
        if std::fs::metadata(&file).is_ok() {
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(not(unix))]
fn restrict_database_files(_database_url: &str) {}

fn resolve_path(variable: &str, candidates: &[&str]) -> PathBuf {
    if let Ok(value) = env::var(variable) {
        return PathBuf::from(value);
    }
    candidates.iter().map(PathBuf::from).find(|path| path.exists()).unwrap_or_else(|| PathBuf::from(candidates[0]))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().nth(1).as_deref() == Some("hash-password") {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        let password = line.trim_end_matches(['\r', '\n']);
        if password.chars().count() < MIN_PASSWORD_CHARS || password.len() > 256 {
            return Err("Password must be 12 to 256 characters".into());
        }
        println!("{}", password_hash(password).map_err(|error| std::io::Error::other(error.1))?);
        return Ok(());
    }

    let _ = dotenvy::dotenv();
    let static_dir = resolve_path("STATIC_DIR", &["../modele-boutique", "modele-boutique"]);
    let upload_dir = resolve_path("PRODUCT_UPLOAD_DIR", &["../assets/products", "assets/products"]);
    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://../backend/store.db?mode=rwc".to_owned());
    let options = SqliteConnectOptions::from_str(&database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(options).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    restrict_database_files(&database_url);
    bootstrap_admin(&pool).await?;
    let _ = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?").bind(now()).execute(&pool).await;
    let _ = sqlx::query("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now()).execute(&pool).await;

    let secure_cookie = env::var("COOKIE_SECURE").map(|value| value != "false").unwrap_or(true);
    let trust_proxy = env::var("TRUST_PROXY").is_ok_and(|value| value == "true");
    let dummy_hash = Arc::new(password_hash(&new_token()).map_err(|error| std::io::Error::other(error.1))?);
    let state = AppState {
        pool,
        upload_dir: upload_dir.clone(),
        secure_cookie,
        trust_proxy,
        limiter: RateLimiter::default(),
        dummy_hash,
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/login", get(login_page))
        .route("/register", get(register_page))
        .route(ADMIN_PATH, get(admin_page))
        .route(&format!("{ADMIN_PATH}/panel.css"), get(panel_css))
        .route("/auth.js", get(auth_js))
        .route(&format!("{ADMIN_PATH}/panel.js"), get(panel_js))
        .route("/product.css", get(product_css))
        .route("/product/{slug}", get(dynamic_product_page))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/session", get(session))
        .route("/api/auth/providers", get(social_providers))
        .route("/auth/google", get(start_google_oauth))
        .route("/auth/google/callback", get(google_oauth_callback))
        .route("/auth/facebook", get(start_facebook_oauth))
        .route("/auth/facebook/callback", get(facebook_oauth_callback))
        .route("/api/products", get(list_products))
        .route("/api/products/{slug}", get(get_product))
        .route("/api/analytics/events", post(record_analytics_event))
        .route("/api/panel/products", get(admin_products).post(create_product))
        .route("/api/panel/products/{slug}", put(update_product).delete(delete_product))
        .route("/api/panel/analytics", get(admin_analytics))
        .route("/api/panel/managers", get(list_managers).post(create_manager))
        .route("/api/panel/managers/{id}", axum::routing::delete(revoke_manager))
        .route("/api/panel/export/products.csv", get(export_products))
        .route("/api/panel/export/customer-emails.csv", get(export_customer_emails))
        .route("/api/panel/upload", post(upload_product_image))
        .nest_service("/assets/products", ServeDir::new(upload_dir))
        .fallback_service(ServeDir::new(static_dir))
        .layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES + 32 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let default_bind = env::var("PORT").map(|port| format!("0.0.0.0:{port}")).unwrap_or_else(|_| "127.0.0.1:8080".into());
    let address: SocketAddr = env::var("BIND_ADDRESS").unwrap_or(default_bind).parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("Aura store backend listening at http://{address}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_lowercase_and_path_safe() {
        assert_eq!(slugify("Skin 1004 Cream!"), "skin-1004-cream");
        assert!(!slugify("../../secret").contains('/'));
    }

    #[test]
    fn rejects_invalid_price_and_external_image() {
        let input = ProductInput {
            slug: Some("good-product".into()), name: "Good".into(), brand: String::new(),
            description: String::new(), price: f64::NAN, category: "soins".into(),
            image_path: None,
        };
        assert!(validate_product(&input).is_err());
        let input = ProductInput { price: 10.0, image_path: Some("https://example.com/image.jpg".into()), ..input };
        assert!(validate_product(&input).is_err());
    }

    #[test]
    fn csv_escapes_cells_and_neutralizes_formulas() {
        assert_eq!(csv_cell("=1+1"), "\"'=1+1\"");
        assert_eq!(csv_cell("A \"quote\""), "\"A \"\"quote\"\"\"");
    }

    #[test]
    fn rate_limiter_blocks_after_limit_and_clears() {
        let limiter = RateLimiter::default();
        for _ in 0..3 {
            assert!(!limiter.is_limited("k", 3, 60));
            limiter.record("k", 60);
        }
        assert!(limiter.is_limited("k", 3, 60));
        limiter.clear("k");
        assert!(!limiter.is_limited("k", 3, 60));
    }

    #[test]
    fn client_ip_ignores_forwarded_headers_unless_proxy_is_trusted() {
        let peer: SocketAddr = "203.0.113.9:4000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("198.51.100.1, 10.0.0.2"));
        assert_eq!(client_ip(&headers, peer, false), "203.0.113.9");
        assert_eq!(client_ip(&headers, peer, true), "10.0.0.2");
    }

    #[test]
    fn app_pages_get_strict_csp_and_storefront_keeps_its_own() {
        assert!(is_app_page("/ikrame"));
        assert!(!is_app_page("/admin"));
        assert!(is_app_page("/api/auth/login"));
        assert!(!is_app_page("/index.html"));
        assert!(!APP_CSP.contains("script-src 'self' 'unsafe-inline'"));
        assert!(STOREFRONT_CSP.contains("script-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn analytics_paths_are_local_and_have_no_query_data() {
        assert!(valid_analytics_path("/collections/visage.html"));
        assert!(!valid_analytics_path("//example.com/path"));
        assert!(!valid_analytics_path("/page?email=private@example.test"));
    }
}
