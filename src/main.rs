//! Screen sharing between friends: serves the pages and relays WebRTC signaling.

mod apoio;
mod contas;
mod gifs;
mod ice;
mod limits;
mod presence;
mod rooms;
mod seguranca;
mod signaling;

use std::{error::Error, net::SocketAddr, sync::Arc};

use axum::{
    extract::{FromRef, Path, RawQuery, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Router,
};

use apoio::Apoio;
use contas::Contas;
use gifs::{GifError, Gifs};
use ice::Ice;
use limits::Limits;
use presence::{normalize_code, Presence};
use rooms::{valid_room_id, Rooms};

/// What the handlers share: the rooms and the ICE (STUN/TURN) configuration.
#[derive(Clone)]
struct AppState {
    rooms: Rooms,
    ice: Arc<Ice>,
    gifs: Arc<Gifs>,
    presence: Presence,
    /// Pix for voluntary support (`/apoiar`); `None` when `PIX_KEY` isn't set.
    apoio: Option<Arc<Apoio>>,
    /// Optional accounts (`DATABASE_PATH` + Google client); `None` when off.
    contas: Option<Arc<Contas>>,
    /// Limits against abuse (src/limits.rs).
    limits: Limits,
}

impl FromRef<AppState> for Limits {
    fn from_ref(state: &AppState) -> Self {
        state.limits.clone()
    }
}

impl FromRef<AppState> for Option<Arc<Contas>> {
    fn from_ref(state: &AppState) -> Self {
        state.contas.clone()
    }
}

impl FromRef<AppState> for Option<Arc<Apoio>> {
    fn from_ref(state: &AppState) -> Self {
        state.apoio.clone()
    }
}

impl FromRef<AppState> for Presence {
    fn from_ref(state: &AppState) -> Self {
        state.presence.clone()
    }
}

impl FromRef<AppState> for Arc<Gifs> {
    fn from_ref(state: &AppState) -> Self {
        state.gifs.clone()
    }
}

impl FromRef<AppState> for Rooms {
    fn from_ref(state: &AppState) -> Self {
        state.rooms.clone()
    }
}

impl FromRef<AppState> for Arc<Ice> {
    fn from_ref(state: &AppState) -> Self {
        state.ice.clone()
    }
}

const DEFAULT_PORT: u16 = 3000;

const INDEX_HTML: &str = include_str!("../static/index.html");
const ROOM_HTML: &str = include_str!("../static/room.html");
const APOIAR_HTML: &str = include_str!("../static/apoiar.html");
const APOIAR_JS: &str = include_str!("../static/apoiar.js");
const PRIVACIDADE_HTML: &str = include_str!("../static/privacidade.html");
const TERMOS_HTML: &str = include_str!("../static/termos.html");
// The room script is kept as one file per area under static/room/ and served as a
// single /room.js (same global scope, same order), so the page loads exactly one script.
const ROOM_JS: &str = concat!(
    include_str!("../static/room/estado.js"),
    include_str!("../static/room/sessao.js"),
    include_str!("../static/room/webrtc.js"),
    include_str!("../static/room/compartilhar.js"),
    include_str!("../static/room/voz.js"),
    include_str!("../static/room/mixagem.js"),
    include_str!("../static/room/camera.js"),
    include_str!("../static/room/ptt.js"),
    include_str!("../static/room/chat.js"),
    include_str!("../static/room/fotos.js"),
    include_str!("../static/room/emojis.js"),
    include_str!("../static/room/gifs.js"),
    include_str!("../static/room/notificacoes.js"),
    include_str!("../static/room/reacoes.js"),
    include_str!("../static/room/soundpad.js"),
    include_str!("../static/room/lateral.js"),
    include_str!("../static/room/interface.js"),
    include_str!("../static/room/rede.js"),
    include_str!("../static/room/celular.js"),
    include_str!("../static/room/denuncia.js"),
    include_str!("../static/room/ajustes.js"),
    include_str!("../static/room/sala-larga.js"),
    include_str!("../static/room/inicio.js"),
);
const LOBBY_JS: &str = include_str!("../static/lobby.js");
const PAINEL_JS: &str = include_str!("../static/painel.js");
const AMIGOS_JS: &str = include_str!("../static/amigos.js");
const CONFIGURACOES_JS: &str = include_str!("../static/configuracoes.js");
const COMMON_JS: &str = include_str!("../static/common.js");
const COMMON_CSS: &str = include_str!("../static/common.css");
const THEME_JS: &str = include_str!("../static/theme.js");
const FAVICON_SVG: &str = include_str!("../static/favicon.svg");
const TOUCH_ICON_PNG: &[u8] = include_bytes!("../static/apple-touch-icon.png");
const ICON_192_PNG: &[u8] = include_bytes!("../static/icon-192.png");
const ICON_MASKABLE_PNG: &[u8] = include_bytes!("../static/icon-maskable-512.png");
const ICON_512_PNG: &[u8] = include_bytes!("../static/icon-512.png");
const MANIFEST: &str = include_str!("../static/manifest.webmanifest");
// Inter (variable, Latin subset), served from here instead of Google Fonts so
// opening the app never tells a third party who is online. License: static/fonts/OFL.txt.
const INTER_WOFF2: &[u8] = include_bytes!("../static/fonts/inter.woff2");
const MONO_WOFF2: &[u8] = include_bytes!("../static/fonts/jetbrains-mono.woff2");

/// Most rooms the lobby may ask about in one request.
const MAX_COUNT_IDS: usize = 30;
/// Friends one browser can ask about at once.
const MAX_FRIEND_CODES: usize = 64;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let port = match std::env::var("PORT") {
        Ok(value) => value
            .parse()
            .map_err(|_| format!("PORT inválida: {value:?}"))?,
        Err(_) => DEFAULT_PORT,
    };
    let max_peers = match std::env::var("MAX_PEERS") {
        Ok(value) => value
            .parse()
            .ok()
            .filter(|&n: &usize| n >= 2)
            .ok_or_else(|| format!("MAX_PEERS inválido (mínimo 2): {value:?}"))?,
        Err(_) => rooms::DEFAULT_MAX_PEERS,
    };

    let ice = Ice::from_env();
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!(
        "Servidor em http://localhost:{port} (até {max_peers} pessoas por sala, TURN {})",
        if ice.has_turn() {
            "ligado"
        } else {
            "desligado"
        }
    );
    let gifs = Gifs::from_env();
    if !gifs.enabled() {
        println!("GIFs desligados (defina GIF_API_KEY para ligar a busca)");
    }
    let apoio = Apoio::from_env();
    if apoio.is_none() {
        println!("Apoio desligado (defina PIX_KEY para abrir /apoiar)");
    }
    let contas = Contas::from_env();
    if contas.is_none() {
        println!("Contas desligadas (defina DATABASE_PATH, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e PUBLIC_URL)");
    }
    // The peer address is the client's IP for the limits (behind Fly's proxy
    // the real one comes in a header; see limits::ClientIp).
    let app = app_full(
        Rooms::new(max_peers),
        ice,
        gifs,
        apoio,
        contas,
        Limits::from_env(),
    );
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
fn app(rooms: Rooms, ice: Arc<Ice>) -> Router {
    app_with(rooms, ice, Gifs::disabled(), None)
}

#[cfg(test)]
fn app_with(rooms: Rooms, ice: Arc<Ice>, gifs: Arc<Gifs>, apoio: Option<Arc<Apoio>>) -> Router {
    app_full(rooms, ice, gifs, apoio, None, Limits::default())
}

fn app_full(
    rooms: Rooms,
    ice: Arc<Ice>,
    gifs: Arc<Gifs>,
    apoio: Option<Arc<Apoio>>,
    contas: Option<Arc<Contas>>,
    limits: Limits,
) -> Router {
    Router::new()
        .merge(contas::routes())
        .merge(contas::amizades::routes())
        .merge(contas::perfil::routes())
        .merge(contas::mensagens::routes())
        .merge(contas::grupos::routes())
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route("/room/{id}", get(room_page))
        .route("/apoiar", get(|| async { Html(APOIAR_HTML) }))
        .route("/apoiar.js", get(|| async { javascript(APOIAR_JS) }))
        .route("/privacidade", get(|| async { Html(PRIVACIDADE_HTML) }))
        .route("/termos", get(|| async { Html(TERMOS_HTML) }))
        .route("/api/apoio", get(apoio_info))
        .route("/api/apoio/qr.svg", get(apoio_qr))
        .route("/room.js", get(|| async { javascript(ROOM_JS) }))
        .route("/lobby.js", get(|| async { javascript(LOBBY_JS) }))
        .route("/painel.js", get(|| async { javascript(PAINEL_JS) }))
        .route("/amigos.js", get(|| async { javascript(AMIGOS_JS) }))
        .route(
            "/configuracoes.js",
            get(|| async { javascript(CONFIGURACOES_JS) }),
        )
        .route("/common.js", get(|| async { javascript(COMMON_JS) }))
        .route("/theme.js", get(|| async { javascript(THEME_JS) }))
        .route(
            "/common.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    COMMON_CSS,
                )
            }),
        )
        .route(
            "/favicon.svg",
            get(|| async { icon("image/svg+xml", FAVICON_SVG.as_bytes()) }),
        )
        // Phones' home-screen icon; also answers browsers that ask for /favicon.ico.
        .route(
            "/apple-touch-icon.png",
            get(|| async { icon("image/png", TOUCH_ICON_PNG) }),
        )
        // "Add to home screen": the site opens without the browser's bars.
        .route(
            "/manifest.webmanifest",
            get(|| async { icon("application/manifest+json", MANIFEST.as_bytes()) }),
        )
        .route(
            "/icon-192.png",
            get(|| async { icon("image/png", ICON_192_PNG) }),
        )
        .route(
            "/icon-512.png",
            get(|| async { icon("image/png", ICON_512_PNG) }),
        )
        // Android crops this one to a circle or squircle: the westie sits in the middle.
        .route(
            "/icon-maskable-512.png",
            get(|| async { icon("image/png", ICON_MASKABLE_PNG) }),
        )
        .route(
            "/favicon.ico",
            get(|| async { icon("image/png", TOUCH_ICON_PNG) }),
        )
        .route("/fonts/inter.woff2", get(|| async { font(INTER_WOFF2) }))
        .route(
            "/fonts/jetbrains-mono.woff2",
            get(|| async { font(MONO_WOFF2) }),
        )
        .route("/api/rooms", get(room_counts))
        .route("/api/ice", get(ice_servers))
        .route("/api/gifs", get(gif_search))
        .route("/api/friends", get(friends))
        .route("/ws/presenca", get(signaling::presence_handler))
        .route("/ws/{id}", get(signaling::ws_handler))
        // For the hosting platform's health checks.
        .route("/health", get(|| async { "ok" }))
        // Per-IP budgets for the APIs and the sign-in routes.
        .layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            limits::limit_api,
        ))
        .layer(axum::middleware::from_fn(seguranca::headers))
        .with_state(AppState {
            rooms,
            ice,
            gifs,
            presence: Presence::default(),
            apoio,
            contas,
            limits,
        })
}

/// `GET /api/apoio` -> `{"pix": "000201...", "name": "Lucas"}`, or 404 when
/// support is off (the lobby then hides its link).
async fn apoio_info(State(apoio): State<Option<Arc<Apoio>>>) -> Response {
    let Some(apoio) = apoio else {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json")],
            "{}",
        )
            .into_response();
    };
    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "pix": apoio.payload, "name": apoio.name }).to_string(),
    )
        .into_response()
}

/// The same Pix code as a QR image.
async fn apoio_qr(State(apoio): State<Option<Arc<Apoio>>>) -> Response {
    let Some(apoio) = apoio else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        apoio.qr_svg.clone(),
    )
        .into_response()
}

async fn room_page(Path(id): Path<String>) -> Response {
    if valid_room_id(&id) {
        Html(ROOM_HTML).into_response()
    } else {
        Redirect::to("/").into_response()
    }
}

fn icon(content_type: &'static str, bytes: &'static [u8]) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    )
}

fn font(bytes: &'static [u8]) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "font/woff2"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
}

fn javascript(source: &'static str) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        source,
    )
}

/// `GET /api/rooms?ids=a,b,c` -> `{"a":3,"b":0,"c":0}`: how many people are in
/// each room the browser already knows. Only counts; no names, no listing.
async fn room_counts(State(rooms): State<Rooms>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let ids: Vec<&str> = query
        .split('&')
        .filter_map(|pair| pair.strip_prefix("ids="))
        .flat_map(|list| list.split(','))
        .filter(|id| valid_room_id(id))
        .take(MAX_COUNT_IDS)
        .collect();
    let counts: serde_json::Map<String, serde_json::Value> = rooms
        .counts(&ids)
        .into_iter()
        .map(|(id, count)| (id.to_owned(), count.into()))
        .collect();
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        serde_json::Value::Object(counts).to_string(),
    )
        .into_response()
}

/// `GET /api/friends?codes=7K3F9X2A,QW12ER34` ->
/// `{"7K3F9X2A": {"nick":"Rafa","room":"churrasco-k3f9x2","count":3,"secs":420}, "QW12ER34": null}`:
/// where each friend is now (null: not in a room, or invisible). Only answers
/// for codes you already have; there is no listing.
async fn friends(
    State(presence): State<Presence>,
    State(rooms): State<Rooms>,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.unwrap_or_default();
    let mut codes: Vec<String> = query
        .split('&')
        .filter_map(|pair| pair.strip_prefix("codes="))
        .flat_map(|list| list.split(','))
        .filter_map(normalize_code)
        .take(MAX_FRIEND_CODES)
        .collect();
    codes.dedup();
    let found = presence.lookup(&codes);
    let room_ids: Vec<&str> = found
        .iter()
        .filter_map(|(_, seen)| seen.as_ref().map(|s| s.room.as_str()))
        .collect();
    let counts: std::collections::HashMap<&str, usize> =
        rooms.counts(&room_ids).into_iter().collect();
    let body: serde_json::Map<String, serde_json::Value> = found
        .iter()
        .map(|(code, seen)| {
            let value = match seen {
                Some(s) => serde_json::json!({
                    "nick": s.nick,
                    "room": s.room,
                    "count": counts.get(s.room.as_str()).copied().unwrap_or(0),
                    "secs": s.secs,
                }),
                None => serde_json::Value::Null,
            };
            (code.clone(), value)
        })
        .collect();
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        serde_json::Value::Object(body).to_string(),
    )
        .into_response()
}

/// `GET /api/gifs?q=gato&pos=24` -> `{"results": [...], "next": "48"}`;
/// without `q`, what's trending. 404 when GIFs are off (no key), 503 when
/// the GIF service doesn't answer.
async fn gif_search(State(gifs): State<Arc<Gifs>>, RawQuery(query): RawQuery) -> Response {
    let query = query.unwrap_or_default();
    let param = |name: &str| {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
            .map(percent_decode)
            .unwrap_or_default()
    };
    let (status, body) = match gifs.search(&param("q"), &param("pos")).await {
        Ok(results) => (StatusCode::OK, results.to_string()),
        Err(GifError::Disabled) => (StatusCode::NOT_FOUND, r#"{"error":"off"}"#.to_owned()),
        Err(GifError::Unavailable) => (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"error":"unavailable"}"#.to_owned(),
        ),
    };
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// `a+b%C3%A3` -> `a bã` (form-style query values), lossy on bad bytes.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[i], hex) {
            (b'+', _) => out.push(b' '),
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 2;
            }
            (byte, _) => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `GET /api/ice` -> `{"iceServers": [...]}` for `RTCPeerConnection`.
/// `GET /api/ice`: STUN only. TURN credentials go to people inside a room,
/// in the WebSocket's welcome (#150); this stays for pages opened before.
async fn ice_servers() -> Response {
    let body = serde_json::json!({ "iceServers": ice::stun_servers() });
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::net::TcpStream;
    use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    async fn start_server() -> String {
        start_server_with(Rooms::default()).await
    }

    async fn start_server_with(rooms: Rooms) -> String {
        start_app(app(rooms, Ice::stun_only())).await
    }

    async fn start_app(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        format!("127.0.0.1:{}", addr.port())
    }

    async fn connect(addr: &str, room: &str) -> Client {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/{room}"))
            .await
            .unwrap();
        ws
    }

    async fn recv(ws: &mut Client) -> Value {
        loop {
            match ws.next().await.expect("connection closed").unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Close(_) => panic!("connection closed"),
                _ => {}
            }
        }
    }

    async fn send(ws: &mut Client, value: Value) {
        ws.send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pages_are_served() {
        let addr = start_server().await;
        let get = |path: &str| {
            let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
            let addr = addr.clone();
            async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut stream = TcpStream::connect(addr).await.unwrap();
                stream.write_all(request.as_bytes()).await.unwrap();
                // Bytes, not a String: some responses (the PNG icon) aren't UTF-8.
                let mut response = Vec::new();
                stream.read_to_end(&mut response).await.unwrap();
                String::from_utf8_lossy(&response).into_owned()
            }
        };

        let home = get("/").await;
        assert!(home.starts_with("HTTP/1.1 200"));
        assert!(home.contains("content-security-policy: default-src 'self'"));
        assert!(home.contains("x-frame-options: DENY"));
        assert!(get("/apoiar.js").await.contains("text/javascript"));
        assert!(get("/apoiar").await.contains("Apoiar o CPX Call"));
        assert!(get("/privacidade")
            .await
            .contains("cpxcallcontato@gmail.com"));
        assert!(get("/termos").await.contains("Termos de uso"));
        assert!(get("/room/abc123").await.contains("room.js"));
        assert!(get("/room/bad!id").await.starts_with("HTTP/1.1 303"));
        assert!(get("/room.js")
            .await
            .contains("content-type: text/javascript"));
        assert!(get("/common.js").await.contains("text/javascript"));
        assert!(get("/lobby.js").await.contains("text/javascript"));
        assert!(get("/configuracoes.js").await.contains("text/javascript"));
        assert!(get("/painel.js").await.contains("text/javascript"));
        assert!(get("/amigos.js").await.contains("text/javascript"));
        assert!(get("/theme.js").await.contains("text/javascript"));
        assert!(get("/common.css").await.contains("content-type: text/css"));
        assert!(get("/favicon.svg")
            .await
            .contains("content-type: image/svg+xml"));
        assert!(get("/apple-touch-icon.png")
            .await
            .contains("content-type: image/png"));
        assert!(get("/manifest.webmanifest")
            .await
            .contains("content-type: application/manifest+json"));
        assert!(get("/icon-512.png")
            .await
            .contains("content-type: image/png"));
        assert!(get("/icon-maskable-512.png")
            .await
            .contains("content-type: image/png"));
        assert!(get("/fonts/jetbrains-mono.woff2")
            .await
            .contains("content-type: font/woff2"));
        assert!(get("/fonts/inter.woff2")
            .await
            .contains("content-type: font/woff2"));
        let health = get("/health").await;
        assert!(health.starts_with("HTTP/1.1 200") && health.ends_with("ok"));
    }

    #[tokio::test]
    async fn signaling_over_websocket() {
        let addr = start_server().await;

        let mut a = connect(&addr, "room1").await;
        assert_eq!(
            recv(&mut a).await,
            json!({ "type": "welcome", "id": 1, "peers": [], "max": rooms::DEFAULT_MAX_PEERS, "ice": ice::stun_servers(), "owner": null, "locked": false })
        );

        let mut b = connect(&addr, "room1").await;
        assert_eq!(
            recv(&mut b).await,
            json!({ "type": "welcome", "id": 2, "peers": [1], "max": rooms::DEFAULT_MAX_PEERS, "ice": ice::stun_servers(), "owner": null, "locked": false })
        );
        assert_eq!(
            recv(&mut a).await,
            json!({ "type": "peer-joined", "id": 2 })
        );

        send(&mut b, json!("not a signal")).await; // ignored
        send(
            &mut b,
            json!({ "to": 1, "data": { "description": "offer" } }),
        )
        .await;
        assert_eq!(
            recv(&mut a).await,
            json!({ "type": "signal", "from": 2, "data": { "description": "offer" } })
        );

        b.close(None).await.unwrap();
        assert_eq!(recv(&mut a).await, json!({ "type": "peer-left", "id": 2 }));
    }

    async fn http_get(addr: &str, path: &str) -> (String, Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        (head.to_owned(), serde_json::from_str(body).unwrap())
    }

    /// A stand-in for Cloudflare's credentials API; counts the calls it gets.
    async fn fake_cloudflare(status: u16) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use axum::{extract::Path, http::HeaderMap, http::StatusCode, routing::post};
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let router = Router::new().route(
            "/v1/turn/keys/{id}/credentials/generate-ice-servers",
            post(move |Path(id): Path<String>, headers: HeaderMap, body: String| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    assert_eq!(id, "key123");
                    assert_eq!(headers["authorization"], "Bearer secret-token");
                    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({ "ttl": 86400 }));
                    let reply = json!({ "iceServers": [
                        { "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
                        { "urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
                          "username": "user", "credential": "pass" }
                    ]});
                    (StatusCode::from_u16(status).unwrap(), reply.to_string())
                }
            }),
        );
        (format!("http://{}", start_app(router).await), calls)
    }

    /// A Tenor-style GIF API that counts its calls and checks the key.
    async fn fake_gif_api() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let router = Router::new().route(
            "/v2/{kind}",
            get(move |Path(kind): Path<String>, RawQuery(query): RawQuery| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let query = query.unwrap_or_default();
                    assert!(query.contains("key=gif-key"));
                    let title = if kind == "search" {
                        assert!(query.contains("q=gato+pulando") || query.contains("q=gato%20pulando"));
                        "gato pulando"
                    } else {
                        "em alta"
                    };
                    json!({ "results": [{ "id": "7", "content_description": title, "media_formats": {
                        "gif": { "url": "https://static.klipy.com/x.gif", "dims": [320, 180] } } }], "next": "24" })
                    .to_string()
                }
            }),
        );
        (format!("http://{}", start_app(router).await), calls)
    }

    #[tokio::test]
    async fn friends_see_where_you_are_while_connected() {
        let secret = "ab".repeat(32);
        let code = presence::friend_code(&secret);
        let addr = start_server().await;
        let mut rafa = connect(&addr, "churrasco-k3f9x2").await;
        recv(&mut rafa).await; // welcome
        let mut bia = connect(&addr, "churrasco-k3f9x2").await;
        recv(&mut bia).await;
        send(
            &mut rafa,
            json!({ "presence": { "secret": secret, "nick": "Rafa" } }),
        )
        .await;

        let path = format!(
            "/api/friends?codes={},ZZZZZZZZ,invalid",
            code.to_lowercase()
        );
        let mut seen = Value::Null;
        for _ in 0..50 {
            (_, seen) = http_get(&addr, &path).await;
            if !seen[&code].is_null() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(seen[&code]["nick"], "Rafa");
        assert_eq!(seen[&code]["room"], "churrasco-k3f9x2");
        assert_eq!(seen[&code]["count"], 2);
        assert!(seen["ZZZZZZZZ"].is_null(), "unknown code: nobody there");
        assert!(seen.get("invalid").is_none(), "not a code: ignored");

        send(&mut rafa, json!({ "presence": null })).await; // invisible
        let mut gone = false;
        for _ in 0..50 {
            let (_, now) = http_get(&addr, &path).await;
            if now[&code].is_null() {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(gone, "invisible: hidden from friends");
    }

    /// A raw HTTP request with optional cookie and JSON body; returns head and body.
    async fn http(
        addr: &str,
        method: &str,
        path: &str,
        cookie: &str,
        body: &str,
    ) -> (String, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n");
        if !cookie.is_empty() {
            request += &format!("Cookie: {cookie}\r\n");
        }
        if !body.is_empty() {
            request += &format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            );
        }
        request += "\r\n";
        request += body;
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        (head.to_owned(), body.to_owned())
    }

    /// "name=value" from a Set-Cookie header in `head`.
    fn set_cookie(head: &str, name: &str) -> String {
        head.lines()
            .filter_map(|l| l.strip_prefix("set-cookie: "))
            .find(|l| l.starts_with(&format!("{name}=")))
            .and_then(|l| l.split(';').next())
            .unwrap_or_default()
            .to_owned()
    }

    fn app_limited(rooms: Rooms, limits: Limits) -> Router {
        app_full(
            rooms,
            Ice::stun_only(),
            Gifs::disabled(),
            None,
            None,
            limits,
        )
    }

    #[tokio::test]
    async fn websocket_from_another_site_is_refused() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let addr = start_server().await;
        let mut request = format!("ws://{addr}/ws/sala1")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", "https://malicioso.exemplo".parse().unwrap());
        let err = tokio_tungstenite::connect_async(request).await.unwrap_err();
        assert!(err.to_string().contains("403"), "{err}");

        // Same site (Origin matches Host) is fine.
        let mut request = format!("ws://{addr}/ws/sala1")
            .into_client_request()
            .unwrap();
        let origin = format!("http://{addr}");
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
        assert!(tokio_tungstenite::connect_async(request).await.is_ok());
    }

    #[tokio::test]
    async fn too_many_connections_from_one_address() {
        let addr = start_app(app_limited(
            Rooms::default(),
            Limits::new(2, 100, Vec::new()),
        ))
        .await;
        let _a = connect(&addr, "sala1").await;
        let _b = connect(&addr, "sala2").await;
        let err = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/sala3"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("429"), "{err}");
        drop(_a);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(
            tokio_tungstenite::connect_async(format!("ws://{addr}/ws/sala3"))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn no_new_rooms_when_the_server_is_full() {
        let addr = start_app(app_limited(Rooms::with_max_rooms(12, 1), Limits::default())).await;
        let mut first = connect(&addr, "sala1").await;
        assert_eq!(recv(&mut first).await["type"], "welcome");
        let mut second = connect(&addr, "sala2").await;
        assert_eq!(recv(&mut second).await["type"], "busy");
    }

    #[tokio::test]
    async fn api_budget_per_minute() {
        let addr = start_server().await;
        for _ in 0..20 {
            let (head, _) = http(&addr, "GET", "/api/ice", "", "").await;
            assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        }
        let (head, _) = http(&addr, "GET", "/api/ice", "", "").await;
        assert!(head.starts_with("HTTP/1.1 429"), "{head}");
        assert!(head.contains("retry-after: 60"));
    }

    #[tokio::test]
    async fn friends_by_username_and_where_they_are() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let contas = contas::tests::memory("http://nada");
        let session = |sub: &str, username: &str| {
            let id = contas.user_for_google(sub).unwrap();
            contas
                .update_user(id, Some(username), Some(username))
                .unwrap();
            (
                id,
                format!("cpx_sessao={}", contas.new_session(id).unwrap()),
            )
        };
        let (_, lucas) = session("g-1", "lucas");
        let (rafa_id, rafa) = session("g-2", "rafa");
        let addr = start_app(app_full(
            Rooms::default(),
            Ice::stun_only(),
            Gifs::disabled(),
            None,
            Some(contas.clone()),
            Limits::default(),
        ))
        .await;

        let (head, body) = http(&addr, "GET", "/api/usuarios/Rafa", &lucas, "").await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        let found: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            (found["username"].as_str(), found["relacao"].as_str()),
            (Some("rafa"), Some("nenhuma"))
        );
        let (head, _) = http(&addr, "GET", "/api/usuarios/ninguem", &lucas, "").await;
        assert!(head.starts_with("HTTP/1.1 404"));
        let (head, _) = http(&addr, "GET", "/api/usuarios/rafa", "", "").await;
        assert!(
            head.starts_with("HTTP/1.1 401"),
            "signed out can't look anyone up"
        );

        let (_, body) = http(
            &addr,
            "POST",
            "/api/amigos",
            &lucas,
            r#"{"username":"@rafa"}"#,
        )
        .await;
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["relacao"],
            "enviado"
        );
        let (_, body) = http(&addr, "GET", "/api/amigos", &rafa, "").await;
        let rafa_view: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(rafa_view["recebidos"][0]["username"], "lucas");
        let lucas_id = rafa_view["recebidos"][0]["id"].as_i64().unwrap();

        // Only the one who received the request can accept it.
        let path = format!("/api/amigos/{rafa_id}/aceitar");
        let (head, _) = http(&addr, "POST", &path, &lucas, "").await;
        assert!(head.starts_with("HTTP/1.1 404"));
        let path = format!("/api/amigos/{lucas_id}/aceitar");
        let (head, _) = http(&addr, "POST", &path, &rafa, "").await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");

        // Rafa joins a room: Lucas sees where. Invisible: he doesn't.
        let mut request = format!("ws://{addr}/ws/churrasco-k3f9x2")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("cookie", rafa.parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        recv(&mut ws).await; // welcome
        let secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        send(
            &mut ws,
            json!({ "presence": { "secret": secret, "nick": "Rafa" } }),
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let (_, body) = http(&addr, "GET", "/api/amigos", &lucas, "").await;
        let friend = &serde_json::from_str::<Value>(&body).unwrap()["amigos"][0];
        assert_eq!(
            (friend["sala"].as_str(), friend["pessoas"].as_u64()),
            (Some("churrasco-k3f9x2"), Some(1))
        );

        send(&mut ws, json!({ "presence": null })).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let (_, body) = http(&addr, "GET", "/api/amigos", &lucas, "").await;
        assert!(serde_json::from_str::<Value>(&body).unwrap()["amigos"][0]
            .get("sala")
            .is_none());

        let path = format!("/api/amigos/{rafa_id}");
        http(&addr, "DELETE", &path, &lucas, "").await;
        let (_, body) = http(&addr, "GET", "/api/amigos", &lucas, "").await;
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["amigos"],
            json!([])
        );
    }

    #[tokio::test]
    async fn friends_see_you_online_while_the_page_is_open() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let contas = contas::tests::memory("http://nada");
        let session = |sub: &str, username: &str| {
            let id = contas.user_for_google(sub).unwrap();
            contas
                .update_user(id, Some(username), Some(username))
                .unwrap();
            let user = contas
                .user_by_token(&contas.new_session(id).unwrap())
                .unwrap();
            (
                user,
                format!("cpx_sessao={}", contas.new_session(id).unwrap()),
            )
        };
        let (lucas, lucas_cookie) = session("g-1", "lucas");
        let (bia, bia_cookie) = session("g-2", "bia");
        contas.request(&lucas, "bia").unwrap();
        contas.accept(bia.id, lucas.id).unwrap();
        let addr = start_app(app_full(
            Rooms::default(),
            Ice::stun_only(),
            Gifs::disabled(),
            None,
            Some(contas.clone()),
            Limits::default(),
        ))
        .await;
        let online = || async {
            let (_, body) = http(&addr, "GET", "/api/amigos", &bia_cookie, "").await;
            serde_json::from_str::<Value>(&body).unwrap()["amigos"][0]["online"] == json!(true)
        };
        assert!(!online().await);

        let err = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/presenca"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("401"), "signed out: {err}");

        let mut request = format!("ws://{addr}/ws/presenca")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("cookie", lucas_cookie.parse().unwrap());
        let (ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(online().await, "page open: online");
        drop(ws);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!online().await, "closed: gone");
    }

    #[tokio::test]
    async fn room_owner_locks_and_kicks_over_websocket() {
        let addr = start_server().await;
        const OWNER: &str = "0123456789abcdef0123456789abcdef";
        const OTHER: &str = "fedcba9876543210fedcba9876543210";
        let join = |key: &str| {
            let url = format!("ws://{addr}/ws/sala-dono?dono={key}");
            async move { tokio_tungstenite::connect_async(url).await.unwrap().0 }
        };
        let mut owner = join(OWNER).await;
        let welcome = recv(&mut owner).await;
        assert_eq!(
            (welcome["owner"].as_u64(), welcome["locked"].as_bool()),
            (Some(1), Some(false))
        );
        let mut other = join(OTHER).await;
        assert_eq!(recv(&mut other).await["owner"], 1);
        recv(&mut owner).await; // peer-joined

        // Not the owner: ignored. The owner: everyone learns the room is locked.
        send(&mut other, json!({ "admin": { "lock": true } })).await;
        send(&mut owner, json!({ "admin": { "lock": true } })).await;
        assert_eq!(
            recv(&mut owner).await,
            json!({ "type": "room", "owner": 1, "locked": true })
        );
        let mut late = join("11111111111111111111111111111111").await;
        assert_eq!(recv(&mut late).await["type"], "locked");

        send(&mut owner, json!({ "admin": { "kick": 2 } })).await;
        loop {
            if recv(&mut other).await["type"] == "kicked" {
                break;
            }
        }
        let mut again = join(OTHER).await;
        assert_eq!(recv(&mut again).await["type"], "kicked");
    }

    #[tokio::test]
    async fn accounts_are_off_without_configuration() {
        let addr = start_server().await;
        let (head, _) = http(&addr, "GET", "/api/me", "", "").await;
        assert!(head.starts_with("HTTP/1.1 404"));
    }

    #[tokio::test]
    async fn sign_in_with_google_and_pick_a_username() {
        // Google's token endpoint: hands back an ID token for account "g-42".
        let google = Router::new().route(
            "/token",
            axum::routing::post(|body: String| async move {
                assert!(body.contains("code=codigo-do-google"));
                assert!(body.contains("client_secret=segredo"));
                let exp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64
                    + 600;
                json!({ "id_token": contas::tests::id_token("g-42", "cliente", exp) }).to_string()
            }),
        );
        let token_url = format!("http://{}/token", start_app(google).await);
        let addr = start_app(app_full(
            Rooms::default(),
            Ice::stun_only(),
            Gifs::disabled(),
            None,
            Some(contas::tests::memory(&token_url)),
            Limits::default(),
        ))
        .await;

        let (head, _) = http(&addr, "GET", "/api/me", "", "").await;
        assert!(head.starts_with("HTTP/1.1 401"), "signed out");

        let (head, _) = http(&addr, "GET", "/auth/google?volta=/room/abc123", "", "").await;
        assert!(head.starts_with("HTTP/1.1 303"));
        assert!(head.contains("location: https://google.exemplo/auth?client_id=cliente"));
        assert!(head.contains("scope=openid&"));
        let state_cookie = set_cookie(&head, "cpx_oauth");
        let back_cookie = set_cookie(&head, "cpx_volta");
        let state = state_cookie.split_once('=').unwrap().1.to_owned();

        // A wrong state is refused.
        let (head, _) = http(
            &addr,
            "GET",
            "/auth/google/callback?code=x&state=outro",
            &state_cookie,
            "",
        )
        .await;
        assert!(head.contains("location: /?conta=erro"));

        let cookies = format!("{state_cookie}; {back_cookie}");
        let path = format!("/auth/google/callback?code=codigo-do-google&state={state}");
        let (head, _) = http(&addr, "GET", &path, &cookies, "").await;
        assert!(
            head.contains("location: /room/abc123?conta=entrou"),
            "{head}"
        );
        let session = set_cookie(&head, "cpx_sessao");
        assert!(session.len() > 20);

        let (head, body) = http(&addr, "GET", "/api/me", &session, "").await;
        assert!(head.starts_with("HTTP/1.1 200"));
        let me: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(me["username"], Value::Null);

        let (head, body) = http(
            &addr,
            "POST",
            "/api/me",
            &session,
            r#"{"username":"Rafa","nick":"Rafa"}"#,
        )
        .await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["username"],
            "rafa"
        );

        let (head, _) = http(&addr, "POST", "/api/me", &session, r#"{"username":"x"}"#).await;
        assert!(head.starts_with("HTTP/1.1 400"));

        let (head, _) = http(&addr, "POST", "/auth/sair", &session, "").await;
        assert!(head.contains("cpx_sessao=;"));
        let (head, _) = http(&addr, "GET", "/api/me", &session, "").await;
        assert!(head.starts_with("HTTP/1.1 401"), "session ended");
    }

    #[tokio::test]
    async fn support_is_off_without_pix_key() {
        let addr = start_server().await;
        let (head, _) = http_get(&addr, "/api/apoio").await;
        assert!(head.starts_with("HTTP/1.1 404"));
    }

    #[tokio::test]
    async fn support_gives_the_pix_code_and_its_qr() {
        let apoio = Apoio::new("cpx@example.com", "Lucas", "Sao Paulo").map(Arc::new);
        let addr = start_app(app_with(
            Rooms::default(),
            Ice::stun_only(),
            Gifs::disabled(),
            apoio,
        ))
        .await;
        let (head, body) = http_get(&addr, "/api/apoio").await;
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body["name"], "Lucas");
        assert!(body["pix"].as_str().unwrap().starts_with("000201263"));
    }

    #[tokio::test]
    async fn gif_endpoint_off_without_key() {
        let addr = start_server().await;
        let (head, _) = http_get(&addr, "/api/gifs?q=gato").await;
        assert!(head.starts_with("HTTP/1.1 404"));
    }

    #[tokio::test]
    async fn gif_endpoint_searches_and_caches() {
        let (api, calls) = fake_gif_api().await;
        let addr = start_app(app_with(
            Rooms::default(),
            Ice::stun_only(),
            Gifs::with_key("gif-key", &api),
            None,
        ))
        .await;
        let (_, trending) = http_get(&addr, "/api/gifs").await;
        assert_eq!(trending["results"][0]["title"], "em alta");
        let (_, first) = http_get(&addr, "/api/gifs?q=Gato+pulando").await;
        let (_, second) = http_get(&addr, "/api/gifs?q=gato%20pulando").await;
        assert_eq!(first["results"][0]["title"], "gato pulando");
        assert_eq!(
            first["results"][0]["gif"]["url"],
            "https://static.klipy.com/x.gif"
        );
        assert_eq!(first["next"], "24");
        assert_eq!(first, second);
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "the same search (any case/encoding) is answered from memory"
        );
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("gato+pulando%21"), "gato pulando!");
        assert_eq!(percent_decode("p%C3%A3o"), "pão");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[tokio::test]
    async fn ice_endpoint_without_turn_key_gives_stun() {
        let addr = start_server().await;
        let (head, body) = http_get(&addr, "/api/ice").await;
        assert!(head.contains("cache-control: no-store"));
        let servers = body["iceServers"].as_array().unwrap();
        assert!(servers.iter().all(|s| s.get("username").is_none()));
        assert!(servers[0]["urls"][0].as_str().unwrap().starts_with("stun:"));
    }

    #[tokio::test]
    async fn turn_credentials_only_inside_a_room() {
        let (api, calls) = fake_cloudflare(201).await;
        let addr = start_app(app(
            Rooms::default(),
            Ice::with_turn("key123", "secret-token", &api),
        ))
        .await;
        // The public endpoint never hands out TURN.
        let (_, public) = http_get(&addr, "/api/ice").await;
        assert!(public["iceServers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("username").is_none()));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);

        let mut a = connect(&addr, "sala1").await;
        let first = recv(&mut a).await["ice"].clone();
        let mut b = connect(&addr, "sala2").await;
        let second = recv(&mut b).await["ice"].clone();
        assert_eq!(
            first,
            json!([
                { "urls": ["stun:stun.cloudflare.com:3478"] },
                { "urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
                  "username": "user", "credential": "pass" }
            ])
        );
        assert_eq!(first, second);
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "credentials are reused"
        );
        drop((a, b));
    }

    #[tokio::test]
    async fn ice_endpoint_falls_back_to_stun_when_cloudflare_fails() {
        let (api, _) = fake_cloudflare(500).await;
        let addr = start_app(app(
            Rooms::default(),
            Ice::with_turn("key123", "secret-token", &api),
        ))
        .await;
        let mut ws = connect(&addr, "sala1").await;
        let welcome = recv(&mut ws).await;
        let servers = welcome["ice"].as_array().unwrap();
        assert!(!servers.is_empty());
        assert!(servers.iter().all(|s| s.get("username").is_none()));
    }

    #[tokio::test]
    async fn room_counts_endpoint() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let addr = start_server().await;
        let mut ws = connect(&addr, "countme").await;
        recv(&mut ws).await; // welcome: we are in

        let mut stream = TcpStream::connect(&addr).await.unwrap();
        let request = "GET /api/rooms?ids=countme,empty,bad!id HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();

        assert!(response.contains("content-type: application/json"));
        assert!(response.contains("cache-control: no-store"));
        let body = response.split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({ "countme": 1, "empty": 0 })
        );
    }

    #[tokio::test(start_paused = true)]
    async fn quiet_connections_get_pinged() {
        let addr = start_server().await;
        let mut ws = connect(&addr, "quiet").await;
        recv(&mut ws).await; // welcome
                             // Nothing else happens in the room; time jumps ahead while idle.
        loop {
            match ws.next().await.expect("connection closed").unwrap() {
                Message::Ping(_) => break,
                Message::Close(_) => panic!("closed instead of pinging"),
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn participant_over_the_limit_gets_room_full() {
        let addr = start_server_with(Rooms::new(3)).await;
        let mut clients = Vec::new();
        for _ in 0..3 {
            let mut ws = connect(&addr, "busy").await;
            recv(&mut ws).await;
            clients.push(ws);
        }

        let mut extra = connect(&addr, "busy").await;
        assert_eq!(recv(&mut extra).await, json!({ "type": "full", "max": 3 }));
        assert!(matches!(
            extra.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
    }
}
