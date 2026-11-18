//! Screen sharing between friends: serves the pages and relays WebRTC signaling.

mod ice;
mod rooms;
mod signaling;

use std::{error::Error, sync::Arc};

use axum::{
    extract::{FromRef, Path, RawQuery, State},
    http::header,
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Router,
};

use ice::Ice;
use rooms::{valid_room_id, Rooms};

/// What the handlers share: the rooms and the ICE (STUN/TURN) configuration.
#[derive(Clone)]
struct AppState {
    rooms: Rooms,
    ice: Arc<Ice>,
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
// The room script is kept as one file per area under static/room/ and served as a
// single /room.js (same global scope, same order), so the page loads exactly one script.
const ROOM_JS: &str = concat!(
    include_str!("../static/room/estado.js"),
    include_str!("../static/room/sessao.js"),
    include_str!("../static/room/webrtc.js"),
    include_str!("../static/room/compartilhar.js"),
    include_str!("../static/room/voz.js"),
    include_str!("../static/room/camera.js"),
    include_str!("../static/room/ptt.js"),
    include_str!("../static/room/chat.js"),
    include_str!("../static/room/emojis.js"),
    include_str!("../static/room/notificacoes.js"),
    include_str!("../static/room/reacoes.js"),
    include_str!("../static/room/lateral.js"),
    include_str!("../static/room/interface.js"),
    include_str!("../static/room/inicio.js"),
);
const LOBBY_JS: &str = include_str!("../static/lobby.js");
const COMMON_JS: &str = include_str!("../static/common.js");
const COMMON_CSS: &str = include_str!("../static/common.css");
const THEME_JS: &str = include_str!("../static/theme.js");
const FAVICON_SVG: &str = include_str!("../static/favicon.svg");
const TOUCH_ICON_PNG: &[u8] = include_bytes!("../static/apple-touch-icon.png");
// Inter (variable, Latin subset), served from here instead of Google Fonts so
// opening the app never tells a third party who is online. License: static/fonts/OFL.txt.
const INTER_WOFF2: &[u8] = include_bytes!("../static/fonts/inter.woff2");

/// Most rooms the lobby may ask about in one request.
const MAX_COUNT_IDS: usize = 30;

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
    axum::serve(listener, app(Rooms::new(max_peers), ice)).await?;
    Ok(())
}

fn app(rooms: Rooms, ice: Arc<Ice>) -> Router {
    Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route("/room/{id}", get(room_page))
        .route("/room.js", get(|| async { javascript(ROOM_JS) }))
        .route("/lobby.js", get(|| async { javascript(LOBBY_JS) }))
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
        .route(
            "/favicon.ico",
            get(|| async { icon("image/png", TOUCH_ICON_PNG) }),
        )
        .route(
            "/fonts/inter.woff2",
            get(|| async {
                (
                    [
                        (header::CONTENT_TYPE, "font/woff2"),
                        (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                    ],
                    INTER_WOFF2,
                )
            }),
        )
        .route("/api/rooms", get(room_counts))
        .route("/api/ice", get(ice_servers))
        .route("/ws/{id}", get(signaling::ws_handler))
        // For the hosting platform's health checks.
        .route("/health", get(|| async { "ok" }))
        .with_state(AppState { rooms, ice })
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

/// `GET /api/ice` -> `{"iceServers": [...]}` for `RTCPeerConnection`.
async fn ice_servers(State(ice): State<Arc<Ice>>) -> Response {
    let body = serde_json::json!({ "iceServers": ice.servers().await });
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
        tokio::spawn(async move { axum::serve(listener, router).await });
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

        assert!(get("/").await.starts_with("HTTP/1.1 200"));
        assert!(get("/room/abc123").await.contains("room.js"));
        assert!(get("/room/bad!id").await.starts_with("HTTP/1.1 303"));
        assert!(get("/room.js")
            .await
            .contains("content-type: text/javascript"));
        assert!(get("/common.js").await.contains("text/javascript"));
        assert!(get("/lobby.js").await.contains("text/javascript"));
        assert!(get("/theme.js").await.contains("text/javascript"));
        assert!(get("/common.css").await.contains("content-type: text/css"));
        assert!(get("/favicon.svg")
            .await
            .contains("content-type: image/svg+xml"));
        assert!(get("/apple-touch-icon.png")
            .await
            .contains("content-type: image/png"));
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
            json!({ "type": "welcome", "id": 1, "peers": [], "max": rooms::DEFAULT_MAX_PEERS })
        );

        let mut b = connect(&addr, "room1").await;
        assert_eq!(
            recv(&mut b).await,
            json!({ "type": "welcome", "id": 2, "peers": [1], "max": rooms::DEFAULT_MAX_PEERS })
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
    async fn ice_endpoint_with_turn_key_uses_cloudflare_once() {
        let (api, calls) = fake_cloudflare(201).await;
        let addr = start_app(app(
            Rooms::default(),
            Ice::with_turn("key123", "secret-token", &api),
        ))
        .await;
        let (_, first) = http_get(&addr, "/api/ice").await;
        let (_, second) = http_get(&addr, "/api/ice").await;
        assert_eq!(
            first["iceServers"],
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
    }

    #[tokio::test]
    async fn ice_endpoint_falls_back_to_stun_when_cloudflare_fails() {
        let (api, _) = fake_cloudflare(500).await;
        let addr = start_app(app(
            Rooms::default(),
            Ice::with_turn("key123", "secret-token", &api),
        ))
        .await;
        let (_, body) = http_get(&addr, "/api/ice").await;
        let servers = body["iceServers"].as_array().unwrap();
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
