//! Optional accounts (docs/CONTAS.md): sign in with Google to get an
//! @username that friends can find. People without an account use the app
//! as before.
//!
//! What is stored (SQLite at `DATABASE_PATH`): the Google account's opaque
//! id (`sub`, from the `openid` scope only: no e-mail, name or photo), the
//! @username, the display name, and a hash of each session token. Deleting
//! the account deletes all of it.

use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{FromRef, RawQuery, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub mod amizades;

const SESSION_COOKIE: &str = "cpx_sessao";
const STATE_COOKIE: &str = "cpx_oauth";
const BACK_COOKIE: &str = "cpx_volta";
/// Sessions unused for this long are deleted.
const SESSION_IDLE_SECS: i64 = 365 * 24 * 3600;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERNAME_MIN: usize = 3;
const USERNAME_MAX: usize = 20;
const NICK_MAX: usize = 32;
const RESERVED: &[&str] = &[
    "admin",
    "cpx",
    "cpxcall",
    "suporte",
    "sistema",
    "root",
    "moderador",
    "oficial",
];

/// Schema, one entry per version (`PRAGMA user_version`). Never edit an
/// entry that shipped: add a new one.
const MIGRATIONS: &[&str] = &[
    "
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        google_sub TEXT NOT NULL UNIQUE,
        username TEXT UNIQUE COLLATE NOCASE,
        nick TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
",
    "
    CREATE TABLE friendships (
        user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_by INTEGER NOT NULL,
        accepted_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_a, user_b),
        CHECK (user_a < user_b)
    );
    CREATE INDEX friendships_b ON friendships(user_b);
",
];

pub struct Google {
    pub client_id: String,
    pub client_secret: String,
    pub auth_url: String,
    pub token_url: String,
}

pub struct Contas {
    db: Mutex<Connection>,
    google: Google,
    /// Where Google sends people back to (`PUBLIC_URL`), e.g. https://cpx-call.fly.dev.
    public_url: String,
    /// Which room connections belong to which account (memory only).
    online: Mutex<amizades::Online>,
    /// Open "I'm here" connections per account (the lobby, #158; memory only).
    lobby: Mutex<std::collections::HashMap<i64, usize>>,
}

#[derive(Debug, PartialEq)]
pub struct User {
    pub id: i64,
    pub username: Option<String>,
    pub nick: String,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("sem fonte de aleatoriedade do sistema");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Contas {
    /// Accounts are on only with a database path and a Google client.
    pub fn from_env() -> Option<Arc<Self>> {
        let var = |name| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let path = var("DATABASE_PATH")?;
        let google = Google {
            client_id: var("GOOGLE_CLIENT_ID")?,
            client_secret: var("GOOGLE_CLIENT_SECRET")?,
            auth_url: var("GOOGLE_AUTH_URL").unwrap_or_else(|| GOOGLE_AUTH_URL.to_owned()),
            token_url: var("GOOGLE_TOKEN_URL").unwrap_or_else(|| GOOGLE_TOKEN_URL.to_owned()),
        };
        let public_url = var("PUBLIC_URL")?;
        match Self::open(Path::new(&path), google, &public_url) {
            Ok(contas) => Some(Arc::new(contas)),
            Err(err) => {
                eprintln!("Contas desligadas: não deu para abrir o banco ({err})");
                None
            }
        }
    }

    pub fn open(path: &Path, google: Google, public_url: &str) -> rusqlite::Result<Self> {
        let db = if path.as_os_str() == ":memory:" {
            Connection::open_in_memory()?
        } else {
            Connection::open(path)?
        };
        db.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;",
        )?;
        migrate(&db)?;
        db.execute(
            "DELETE FROM sessions WHERE last_seen < ?1",
            params![now() - SESSION_IDLE_SECS],
        )?;
        Ok(Self {
            db: Mutex::new(db),
            google,
            public_url: public_url.trim_end_matches('/').to_owned(),
            online: Mutex::default(),
            lobby: Mutex::default(),
        })
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn secure(&self) -> bool {
        self.public_url.starts_with("https://")
    }

    fn redirect_uri(&self) -> String {
        format!("{}/auth/google/callback", self.public_url)
    }

    /// The account for a Google id, created on first sign-in.
    pub fn user_for_google(&self, sub: &str) -> rusqlite::Result<i64> {
        let db = self.db();
        db.execute(
            "INSERT INTO users (google_sub, created_at) VALUES (?1, ?2) ON CONFLICT(google_sub) DO NOTHING",
            params![sub, now()],
        )?;
        db.query_row(
            "SELECT id FROM users WHERE google_sub = ?1",
            params![sub],
            |r| r.get(0),
        )
    }

    /// A new session for `user_id`; returns the token for the cookie.
    pub fn new_session(&self, user_id: i64) -> rusqlite::Result<String> {
        let token = random_hex(32);
        let t = now();
        self.db().execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?1, ?2, ?3, ?3)",
            params![hash_token(&token), user_id, t],
        )?;
        Ok(token)
    }

    /// Who owns this session token (and marks it as used).
    pub fn user_by_token(&self, token: &str) -> Option<User> {
        let db = self.db();
        let hash = hash_token(token);
        let user = db
            .query_row(
                "SELECT u.id, u.username, u.nick FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1",
                params![hash],
                |r| Ok(User { id: r.get(0)?, username: r.get(1)?, nick: r.get(2)? }),
            )
            .optional()
            .ok()
            .flatten()?;
        // At most one write an hour per session.
        let _ = db.execute(
            "UPDATE sessions SET last_seen = ?1 WHERE token_hash = ?2 AND last_seen < ?1 - 3600",
            params![now(), hash],
        );
        Some(user)
    }

    pub fn end_session(&self, token: &str, everywhere: bool) {
        let db = self.db();
        let hash = hash_token(token);
        let _ = if everywhere {
            db.execute(
                "DELETE FROM sessions WHERE user_id = (SELECT user_id FROM sessions WHERE token_hash = ?1)",
                params![hash],
            )
        } else {
            db.execute("DELETE FROM sessions WHERE token_hash = ?1", params![hash])
        };
    }

    pub fn delete_user(&self, id: i64) -> rusqlite::Result<()> {
        self.db()
            .execute("DELETE FROM users WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Sets the @username and/or the display name.
    pub fn update_user(
        &self,
        id: i64,
        username: Option<&str>,
        nick: Option<&str>,
    ) -> Result<(), Problem> {
        let db = self.db();
        if let Some(username) = username {
            let username = clean_username(username).ok_or(Problem::BadUsername)?;
            let taken: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE username = ?1 AND id != ?2)",
                    params![username, id],
                    |r| r.get(0),
                )
                .map_err(|_| Problem::Database)?;
            if taken {
                return Err(Problem::UsernameTaken);
            }
            db.execute(
                "UPDATE users SET username = ?1 WHERE id = ?2",
                params![username, id],
            )
            .map_err(|_| Problem::UsernameTaken)?;
        }
        if let Some(nick) = nick {
            let nick = clean_nick(nick).ok_or(Problem::BadNick)?;
            db.execute(
                "UPDATE users SET nick = ?1 WHERE id = ?2",
                params![nick, id],
            )
            .map_err(|_| Problem::Database)?;
        }
        Ok(())
    }
}

fn migrate(db: &Connection) -> rusqlite::Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let version = usize::try_from(version).unwrap_or(0);
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        db.execute_batch(&format!(
            "BEGIN; {sql} PRAGMA user_version = {}; COMMIT;",
            i + 1
        ))?;
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub enum Problem {
    BadUsername,
    UsernameTaken,
    BadNick,
    NotFound,
    SelfFriend,
    NeedUsername,
    TooManyRequests,
    Database,
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Problem::BadUsername => (
                StatusCode::BAD_REQUEST,
                "O @usuário precisa ter de 3 a 20 letras minúsculas, números ou _, começando com letra.",
            ),
            Problem::UsernameTaken => (StatusCode::CONFLICT, "Esse @usuário já é de outra pessoa."),
            Problem::BadNick => (StatusCode::BAD_REQUEST, "O nome precisa ter de 1 a 32 caracteres."),
            Problem::NotFound => (StatusCode::NOT_FOUND, "Não encontramos ninguém com esse @usuário."),
            Problem::SelfFriend => (StatusCode::BAD_REQUEST, "Esse @usuário é o seu."),
            Problem::NeedUsername => (StatusCode::BAD_REQUEST, "Escolha seu @usuário antes de adicionar amigos."),
            Problem::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "Você tem pedidos demais esperando resposta. Espere alguns serem aceitos.",
            ),
            Problem::Database => (StatusCode::INTERNAL_SERVER_ERROR, "Algo deu errado. Tente de novo."),
        };
        (status, Json(json!({ "error": error }))).into_response()
    }
}

/// "@Rafa_01 " -> "rafa_01"; None when it breaks the rules or is reserved.
pub fn clean_username(text: &str) -> Option<String> {
    let name = text.trim().trim_start_matches('@').to_ascii_lowercase();
    let ok = (USERNAME_MIN..=USERNAME_MAX).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !RESERVED.contains(&name.as_str());
    ok.then_some(name)
}

fn clean_nick(text: &str) -> Option<String> {
    let nick: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(NICK_MAX)
        .collect();
    (!nick.is_empty()).then_some(nick)
}

/// A back path after sign-in: only this site's own pages.
fn clean_back(path: &str) -> Option<&str> {
    let ok = path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 100
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_".contains(&b));
    ok.then_some(path)
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

fn set_cookie(name: &str, value: &str, max_age: i64, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .expect("cookie with safe characters")
}

fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

/// Base64url without padding (the parts of a JWT).
fn base64url(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in text.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => break,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// The Google account id inside the ID token. The token comes straight from
/// Google's token endpoint over TLS, which OpenID Connect accepts in place of
/// checking the signature; the issuer, audience and expiry are still checked.
pub fn google_sub(id_token: &str, client_id: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&base64url(payload)?).ok()?;
    let iss = claims["iss"].as_str()?;
    let issuer_ok = iss == "https://accounts.google.com" || iss == "accounts.google.com";
    let fresh = claims["exp"].as_i64().is_some_and(|exp| exp > now());
    (issuer_ok && claims["aud"].as_str() == Some(client_id) && fresh)
        .then(|| claims["sub"].as_str().map(str::to_owned))
        .flatten()
        .filter(|sub| !sub.is_empty() && sub.len() <= 255)
}

fn exchange_code(google: &Google, code: &str, redirect_uri: &str) -> Result<String, String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .new_agent();
    let mut response = agent
        .post(&google.token_url)
        .send_form([
            ("code", code),
            ("client_id", google.client_id.as_str()),
            ("client_secret", google.client_secret.as_str()),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .map_err(|err| match err {
            ureq::Error::StatusCode(code) => format!("HTTP {code}"),
            _ => "sem resposta".to_owned(),
        })?;
    let body: Value = serde_json::from_str(
        &response
            .body_mut()
            .read_to_string()
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    body["id_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "sem id_token".to_owned())
}

// ---------- rotas ----------

type ContasState = Option<Arc<Contas>>;

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    ContasState: FromRef<S>,
{
    Router::new()
        .route("/auth/google", get(login))
        .route("/auth/google/callback", get(callback))
        .route("/auth/sair", post(logout))
        .route("/api/me", get(me).post(update_me).delete(delete_me))
}

fn off() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({}))).into_response()
}

fn signed_out() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({}))).into_response()
}

impl Contas {
    /// The signed-in account behind a request (by its session cookie).
    pub fn account_id(&self, headers: &HeaderMap) -> Option<i64> {
        current(self, headers).map(|user| user.id)
    }
}

fn current(contas: &Contas, headers: &HeaderMap) -> Option<User> {
    contas.user_by_token(cookie(headers, SESSION_COOKIE)?)
}

/// `GET /auth/google?volta=/room/x`: off to Google's account chooser.
async fn login(State(contas): State<ContasState>, RawQuery(query): RawQuery) -> Response {
    let Some(contas) = contas else { return off() };
    let query = query.unwrap_or_default();
    let back = query_param(&query, "volta")
        .and_then(clean_back)
        .unwrap_or("/");
    let state = random_hex(16);
    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope=openid&state={state}&prompt=select_account",
        contas.google.auth_url,
        encode(&contas.google.client_id),
        encode(&contas.redirect_uri()),
    );
    let secure = contas.secure();
    let mut response = Redirect::to(&url).into_response();
    let headers = response.headers_mut();
    headers.append(
        header::SET_COOKIE,
        set_cookie(STATE_COOKIE, &state, 600, secure),
    );
    headers.append(
        header::SET_COOKIE,
        set_cookie(BACK_COOKIE, back, 600, secure),
    );
    response
}

/// Google sends people back here with `code` and `state`.
async fn callback(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(contas) = contas else { return off() };
    let query = query.unwrap_or_default();
    let back = cookie(&headers, BACK_COOKIE)
        .and_then(clean_back)
        .unwrap_or("/")
        .to_owned();
    let failed = |why: &str| {
        eprintln!("Login com Google falhou: {why}");
        Redirect::to(&format!("{back}?conta=erro")).into_response()
    };
    let (Some(code), Some(state)) = (query_param(&query, "code"), query_param(&query, "state"))
    else {
        return failed("sem código (a pessoa cancelou?)");
    };
    if cookie(&headers, STATE_COOKIE) != Some(state) {
        return failed("state não confere");
    }
    let code = percent_decode(code);
    let worker = contas.clone();
    let exchanged = tokio::task::spawn_blocking(move || {
        exchange_code(&worker.google, &code, &worker.redirect_uri())
    })
    .await;
    let id_token = match exchanged {
        Ok(Ok(token)) => token,
        Ok(Err(err)) => return failed(&err),
        Err(_) => return failed("tarefa interrompida"),
    };
    let Some(sub) = google_sub(&id_token, &contas.google.client_id) else {
        return failed("token inválido");
    };
    let session = contas
        .user_for_google(&sub)
        .and_then(|id| contas.new_session(id));
    let Ok(token) = session else {
        return failed("banco indisponível");
    };
    let secure = contas.secure();
    let mut response = Redirect::to(&format!("{back}?conta=entrou")).into_response();
    let h = response.headers_mut();
    h.append(
        header::SET_COOKIE,
        set_cookie(SESSION_COOKIE, &token, SESSION_IDLE_SECS, secure),
    );
    h.append(header::SET_COOKIE, set_cookie(STATE_COOKIE, "", 0, secure));
    h.append(header::SET_COOKIE, set_cookie(BACK_COOKIE, "", 0, secure));
    response
}

/// `GET /api/me` -> `{"id": 1, "username": "rafa"|null, "nick": "Rafa"}`;
/// 401 signed out, 404 when accounts are off.
async fn me(State(contas): State<ContasState>, headers: HeaderMap) -> Response {
    let Some(contas) = contas else { return off() };
    match current(&contas, &headers) {
        Some(user) => Json(json!({ "id": user.id, "username": user.username, "nick": user.nick }))
            .into_response(),
        None => signed_out(),
    }
}

#[derive(Deserialize)]
struct MeUpdate {
    username: Option<String>,
    nick: Option<String>,
}

/// `POST /api/me {"username"?, "nick"?}`. JSON only, which a form on another
/// site can't send without the browser asking first (no CSRF).
async fn update_me(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Json(body): Json<MeUpdate>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(user) = current(&contas, &headers) else {
        return signed_out();
    };
    match contas.update_user(user.id, body.username.as_deref(), body.nick.as_deref()) {
        Ok(()) => me(State(Some(contas)), headers).await,
        Err(problem) => problem.into_response(),
    }
}

/// `DELETE /api/me`: the account and everything tied to it.
async fn delete_me(State(contas): State<ContasState>, headers: HeaderMap) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(user) = current(&contas, &headers) else {
        return signed_out();
    };
    if contas.delete_user(user.id).is_err() {
        return Problem::Database.into_response();
    }
    clear_session(&contas)
}

#[derive(Deserialize, Default)]
struct Logout {
    #[serde(default)]
    todos: bool,
}

/// `POST /auth/sair {"todos": true?}`: this device, or every device.
async fn logout(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    body: Option<Json<Logout>>,
) -> Response {
    let Some(contas) = contas else { return off() };
    if let Some(token) = cookie(&headers, SESSION_COOKIE) {
        contas.end_session(token, body.unwrap_or_default().0.todos);
    }
    clear_session(&contas)
}

fn clear_session(contas: &Contas) -> Response {
    let mut response = Json(json!({})).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(SESSION_COOKIE, "", 0, contas.secure()),
    );
    response
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    crate::percent_decode(text)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn memory(token_url: &str) -> Arc<Contas> {
        let google = Google {
            client_id: "cliente".to_owned(),
            client_secret: "segredo".to_owned(),
            auth_url: "https://google.exemplo/auth".to_owned(),
            token_url: token_url.to_owned(),
        };
        Arc::new(Contas::open(Path::new(":memory:"), google, "http://localhost:3001").unwrap())
    }

    /// An ID token as Google's token endpoint returns it (unsigned here).
    pub fn id_token(sub: &str, aud: &str, exp: i64) -> String {
        let enc = |v: &Value| {
            const A: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let bytes = v.to_string().into_bytes();
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let n = chunk.iter().fold(0u32, |a, b| (a << 8) | u32::from(*b))
                    << (8 * (3 - chunk.len()));
                for i in 0..=chunk.len() {
                    out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            out
        };
        format!(
            "{}.{}.assinatura",
            enc(&json!({ "alg": "RS256" })),
            enc(
                &json!({ "iss": "https://accounts.google.com", "aud": aud, "sub": sub, "exp": exp })
            )
        )
    }

    #[test]
    fn usernames_follow_the_rules() {
        assert_eq!(clean_username("@Rafa_01 ").as_deref(), Some("rafa_01"));
        assert_eq!(clean_username("ab"), None);
        assert_eq!(clean_username("1rafa"), None);
        assert_eq!(clean_username("rafa-01"), None);
        assert_eq!(clean_username("admin"), None);
        assert_eq!(clean_username(&"a".repeat(21)), None);
    }

    #[test]
    fn back_paths_stay_on_this_site() {
        assert_eq!(
            clean_back("/room/churrasco-k3f9x2"),
            Some("/room/churrasco-k3f9x2")
        );
        assert_eq!(clean_back("//malicioso.exemplo"), None);
        assert_eq!(clean_back("https://malicioso.exemplo"), None);
        assert_eq!(clean_back("/a?b=c"), None);
    }

    #[test]
    fn id_token_checks_audience_and_expiry() {
        let future = now() + 600;
        assert_eq!(
            google_sub(&id_token("123", "cliente", future), "cliente").as_deref(),
            Some("123")
        );
        assert_eq!(
            google_sub(&id_token("123", "outro", future), "cliente"),
            None
        );
        assert_eq!(
            google_sub(&id_token("123", "cliente", now() - 1), "cliente"),
            None
        );
        assert_eq!(google_sub("lixo", "cliente"), None);
    }

    #[test]
    fn accounts_sessions_and_usernames() {
        let contas = memory("http://nada");
        let id = contas.user_for_google("g-1").unwrap();
        assert_eq!(
            contas.user_for_google("g-1").unwrap(),
            id,
            "same Google account, same user"
        );
        let token = contas.new_session(id).unwrap();
        assert_eq!(
            contas.user_by_token(&token),
            Some(User {
                id,
                username: None,
                nick: String::new()
            })
        );
        assert_eq!(contas.user_by_token("outro"), None);

        contas
            .update_user(id, Some("Rafa"), Some("  Rafa  Lima "))
            .unwrap();
        assert_eq!(
            contas.user_by_token(&token).unwrap().username.as_deref(),
            Some("rafa")
        );
        assert_eq!(contas.user_by_token(&token).unwrap().nick, "Rafa Lima");

        let other = contas.user_for_google("g-2").unwrap();
        assert_eq!(
            contas.update_user(other, Some("RAFA"), None),
            Err(Problem::UsernameTaken)
        );
        assert_eq!(
            contas.update_user(other, Some("x"), None),
            Err(Problem::BadUsername)
        );

        let second = contas.new_session(id).unwrap();
        contas.end_session(&token, false);
        assert_eq!(contas.user_by_token(&token), None);
        assert!(contas.user_by_token(&second).is_some());
        contas.end_session(&second, true);
        assert_eq!(contas.user_by_token(&second), None);

        let token = contas.new_session(id).unwrap();
        contas.delete_user(id).unwrap();
        assert_eq!(
            contas.user_by_token(&token),
            None,
            "sessions go with the account"
        );
    }

    #[test]
    fn migrations_run_once() {
        let contas = memory("http://nada");
        let db = contas.db();
        migrate(&db).unwrap();
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }
}
