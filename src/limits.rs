//! Limits against abuse: anyone on the internet can reach the server, and a
//! simple script could otherwise fill the small machine's memory, burn the
//! GIF quota or use the signaling from another site. Everything lives in
//! memory and is keyed by IP only while needed; no IP is ever logged.

use std::{
    collections::HashMap,
    convert::Infallible,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// WebSockets open at once from one IP (a house full of friends shares one).
pub const MAX_CONNECTIONS_PER_IP: usize = 20;
/// WebSockets open at once on the whole server.
pub const MAX_CONNECTIONS: usize = 2000;
const WINDOW: Duration = Duration::from_secs(60);
/// Forget old per-IP counters once the table gets this big.
const PRUNE_AT: usize = 20_000;

/// What a per-minute counter is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// Opening a WebSocket (joining a room).
    Join,
    Gifs,
    Friends,
    Rooms,
    Ice,
    Apoio,
    /// Sign-in and account routes.
    Conta,
    /// Direct messages (a conversation is faster than the rest).
    Mensagem,
    /// Looking someone up by @username: low, so names can't be swept.
    Busca,
}

impl Kind {
    /// Requests per minute per IP. The pages poll /api/rooms and
    /// /api/friends every 15 s, so these leave plenty of room.
    fn per_minute(self) -> u32 {
        match self {
            Kind::Join => 30,
            Kind::Gifs => 60,
            Kind::Friends | Kind::Rooms | Kind::Apoio => 40,
            // Every open page refreshes the account and friends every 15 s,
            // and a whole house shares one IP.
            Kind::Conta => 120,
            Kind::Ice => 20,
            Kind::Mensagem => 120,
            Kind::Busca => 30,
        }
    }

    fn for_path(path: &str) -> Option<Self> {
        if path.starts_with("/api/mensagens") {
            return Some(Kind::Mensagem);
        }
        // Invites are guessable only by trying: as slow as looking up names.
        if path.starts_with("/api/usuarios/") || path.starts_with("/api/convites/") {
            return Some(Kind::Busca);
        }
        if path == "/api/me"
            || path.starts_with("/api/me/")
            || path.starts_with("/api/amigos")
            || path.starts_with("/api/grupos")
        {
            return Some(Kind::Conta);
        }
        match path {
            "/api/gifs" => Some(Kind::Gifs),
            "/api/friends" => Some(Kind::Friends),
            "/api/rooms" => Some(Kind::Rooms),
            "/api/ice" => Some(Kind::Ice),
            "/api/apoio" | "/api/apoio/qr.svg" => Some(Kind::Apoio),
            "/api/me" | "/auth/google" | "/auth/google/callback" | "/auth/sair" => {
                Some(Kind::Conta)
            }
            _ => None,
        }
    }
}

#[derive(Default)]
struct Connections {
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
}

struct Inner {
    connections: Mutex<Connections>,
    windows: Mutex<HashMap<(Kind, IpAddr), (Instant, u32)>>,
    max_per_ip: usize,
    max_total: usize,
    /// Pages on other addresses allowed to open the WebSocket (`ALLOWED_ORIGINS`).
    extra_origins: Vec<String>,
}

/// Shared by every request; cloning only clones the `Arc`.
#[derive(Clone)]
pub struct Limits(Arc<Inner>);

impl Default for Limits {
    fn default() -> Self {
        Self::new(MAX_CONNECTIONS_PER_IP, MAX_CONNECTIONS, Vec::new())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Limits {
    pub fn new(max_per_ip: usize, max_total: usize, extra_origins: Vec<String>) -> Self {
        Self(Arc::new(Inner {
            connections: Mutex::default(),
            windows: Mutex::default(),
            max_per_ip,
            max_total,
            extra_origins,
        }))
    }

    pub fn from_env() -> Self {
        let extra = std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|o| o.trim().trim_end_matches('/').to_owned())
            .filter(|o| !o.is_empty())
            .collect();
        Self::new(MAX_CONNECTIONS_PER_IP, MAX_CONNECTIONS, extra)
    }

    /// Counts one request of `kind` from `ip`; false once over the minute's limit.
    pub fn allow(&self, kind: Kind, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut windows = lock(&self.0.windows);
        if windows.len() >= PRUNE_AT {
            windows.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
        }
        let (start, count) = windows.entry((kind, ip)).or_insert((now, 0));
        if now.duration_since(*start) >= WINDOW {
            *start = now;
            *count = 0;
        }
        *count += 1;
        *count <= kind.per_minute()
    }

    /// Takes a WebSocket slot for `ip`; it is given back when the guard drops.
    pub fn connect(&self, ip: IpAddr) -> Result<Connection, &'static str> {
        let mut conns = lock(&self.0.connections);
        if conns.total >= self.0.max_total {
            return Err("servidor cheio");
        }
        let mine = conns.per_ip.entry(ip).or_default();
        if *mine >= self.0.max_per_ip {
            return Err("conexões demais do mesmo endereço");
        }
        *mine += 1;
        conns.total += 1;
        Ok(Connection {
            limits: self.clone(),
            ip,
        })
    }

    /// Browsers send `Origin`: only this site (same host) or one listed in
    /// `ALLOWED_ORIGINS` may open the WebSocket. Without the header (not a
    /// browser) there is nothing to check.
    pub fn origin_allowed(&self, headers: &HeaderMap) -> bool {
        let Some(origin) = headers.get(header::ORIGIN) else {
            return true;
        };
        let Ok(origin) = origin.to_str() else {
            return false;
        };
        let origin = origin.trim_end_matches('/');
        let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
        let origin_host = origin.split_once("://").map(|(_, rest)| rest);
        (host.is_some() && origin_host == host) || self.0.extra_origins.iter().any(|o| o == origin)
    }
}

/// A WebSocket slot; dropping it frees the slot.
pub struct Connection {
    limits: Limits,
    ip: IpAddr,
}

impl Drop for Connection {
    fn drop(&mut self) {
        let mut conns = lock(&self.limits.0.connections);
        conns.total = conns.total.saturating_sub(1);
        if let Some(mine) = conns.per_ip.get_mut(&self.ip) {
            *mine -= 1;
            if *mine == 0 {
                conns.per_ip.remove(&self.ip);
            }
        }
    }
}

/// The client's address. On Fly.io the proxy puts it in `Fly-Client-IP`
/// (only trusted there: anyone can send that header elsewhere); otherwise
/// the TCP peer.
pub struct ClientIp(pub IpAddr);

fn behind_fly() -> bool {
    static FLY: OnceLock<bool> = OnceLock::new();
    *FLY.get_or_init(|| std::env::var_os("FLY_APP_NAME").is_some())
}

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let from_fly = behind_fly()
            .then(|| parts.headers.get("fly-client-ip"))
            .flatten()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse().ok());
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        Ok(ClientIp(
            from_fly
                .or(peer)
                .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        ))
    }
}

/// 429 with a small JSON body (the pages read the APIs as JSON).
pub fn too_many() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::RETRY_AFTER, "60"),
        ],
        "{}",
    )
        .into_response()
}

/// Middleware for the `/api/*` routes: a per-minute budget per IP.
pub async fn limit_api(
    State(limits): State<Limits>,
    ClientIp(ip): ClientIp,
    request: Request,
    next: Next,
) -> Response {
    if let Some(kind) = Kind::for_path(request.uri().path()) {
        if !limits.allow(kind, ip) {
            return too_many();
        }
    }
    next.run(request).await
}

/// Token bucket for one connection's messages: `rate` per second, up to `burst`.
pub struct Bucket {
    tokens: f64,
    rate: f64,
    burst: f64,
    last: Instant,
}

impl Bucket {
    pub fn new(rate: f64, burst: f64) -> Self {
        Self {
            tokens: burst,
            rate,
            burst,
            last: Instant::now(),
        }
    }

    /// Spends `cost` if there is enough; false (and nothing spent) otherwise.
    pub fn take(&mut self, cost: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const IP: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
    const OTHER: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2));

    #[test]
    fn per_minute_budget_is_per_ip_and_per_kind() {
        let limits = Limits::default();
        for _ in 0..Kind::Ice.per_minute() {
            assert!(limits.allow(Kind::Ice, IP));
        }
        assert!(!limits.allow(Kind::Ice, IP));
        assert!(limits.allow(Kind::Ice, OTHER));
        assert!(limits.allow(Kind::Gifs, IP));
    }

    #[test]
    fn connection_slots_are_given_back() {
        let limits = Limits::new(2, 3, Vec::new());
        let a = limits.connect(IP).unwrap();
        let _b = limits.connect(IP).unwrap();
        assert!(limits.connect(IP).is_err(), "third from the same IP");
        let _c = limits.connect(OTHER).unwrap();
        assert!(limits.connect(OTHER).is_err(), "server full");
        drop(a);
        assert!(limits.connect(IP).is_ok());
    }

    #[test]
    fn origin_must_match_the_host() {
        let limits = Limits::new(1, 1, vec!["https://outro.exemplo".to_owned()]);
        let headers = |origin: Option<&'static str>| {
            let mut h = HeaderMap::new();
            h.insert(header::HOST, HeaderValue::from_static("cpx-call.fly.dev"));
            if let Some(o) = origin {
                h.insert(header::ORIGIN, HeaderValue::from_static(o));
            }
            h
        };
        assert!(limits.origin_allowed(&headers(None)));
        assert!(limits.origin_allowed(&headers(Some("https://cpx-call.fly.dev"))));
        assert!(limits.origin_allowed(&headers(Some("https://outro.exemplo"))));
        assert!(!limits.origin_allowed(&headers(Some("https://malicioso.exemplo"))));
        assert!(
            !limits.origin_allowed(&headers(Some("https://cpx-call.fly.dev.malicioso.exemplo")))
        );
    }

    #[test]
    fn bucket_refills_over_time() {
        let mut bucket = Bucket::new(1000.0, 2.0);
        assert!(bucket.take(1.0));
        assert!(bucket.take(1.0));
        assert!(!bucket.take(1.0));
        std::thread::sleep(Duration::from_millis(5));
        assert!(bucket.take(1.0));
    }
}
