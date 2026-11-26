//! ICE servers handed to the browsers: public STUN always, plus Cloudflare
//! TURN credentials when a TURN key is configured (`TURN_KEY_ID` and
//! `TURN_KEY_API_TOKEN`). TURN relays the video for people whose network
//! blocks direct connections (VPN, 4G, company networks).

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::sync::Mutex;

const DEFAULT_API_BASE: &str = "https://rtc.live.cloudflare.com";
/// Credential lifetime asked from Cloudflare, in seconds (one day).
const CREDENTIAL_TTL_SECS: u64 = 86_400;
/// Reuse generated credentials for half their lifetime, so a call that just
/// started still has hours of validity left.
const REUSE_FOR: Duration = Duration::from_secs(CREDENTIAL_TTL_SECS / 2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

struct TurnKey {
    id: String,
    token: String,
}

pub struct Ice {
    turn: Option<TurnKey>,
    api_base: String,
    cache: Mutex<Option<(Instant, Value)>>,
}

impl Ice {
    /// Reads the TURN key from the environment; without it, STUN only.
    pub fn from_env() -> Arc<Self> {
        let var = |name| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let turn = match (var("TURN_KEY_ID"), var("TURN_KEY_API_TOKEN")) {
            (Some(id), Some(token)) => Some(TurnKey { id, token }),
            _ => None,
        };
        let api_base = var("TURN_API_BASE").unwrap_or_else(|| DEFAULT_API_BASE.to_owned());
        Arc::new(Self::new(turn, api_base))
    }

    pub fn stun_only() -> Arc<Self> {
        Arc::new(Self::new(None, DEFAULT_API_BASE.to_owned()))
    }

    #[cfg(test)]
    pub fn with_turn(id: &str, token: &str, api_base: &str) -> Arc<Self> {
        let key = TurnKey {
            id: id.to_owned(),
            token: token.to_owned(),
        };
        Arc::new(Self::new(Some(key), api_base.to_owned()))
    }

    fn new(turn: Option<TurnKey>, api_base: String) -> Self {
        Self {
            turn,
            api_base,
            cache: Mutex::new(None),
        }
    }

    pub fn has_turn(&self) -> bool {
        self.turn.is_some()
    }

    /// The `iceServers` list for `RTCPeerConnection`. Falls back to STUN only
    /// if Cloudflare can't be reached, so a call is never blocked by TURN.
    pub async fn servers(&self) -> Value {
        let Some(key) = &self.turn else {
            return stun_servers();
        };
        let mut cache = self.cache.lock().await;
        if let Some((at, servers)) = cache.as_ref() {
            if at.elapsed() < REUSE_FOR {
                return servers.clone();
            }
        }
        let url = format!(
            "{}/v1/turn/keys/{}/credentials/generate-ice-servers",
            self.api_base, key.id
        );
        let token = key.token.clone();
        let fetched = tokio::task::spawn_blocking(move || fetch(&url, &token)).await;
        match fetched {
            Ok(Ok(servers)) => {
                *cache = Some((Instant::now(), servers.clone()));
                servers
            }
            Ok(Err(err)) => {
                // The error never includes the token.
                eprintln!("TURN: não foi possível gerar credenciais ({err}); usando só STUN");
                stun_servers()
            }
            Err(_) => stun_servers(),
        }
    }
}

pub fn stun_servers() -> Value {
    json!([{ "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }])
}

fn fetch(url: &str, token: &str) -> Result<Value, String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .new_agent();
    let mut response = agent
        .post(url)
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .send(json!({ "ttl": CREDENTIAL_TTL_SECS }).to_string())
        .map_err(|err| err.to_string())?;
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|err| err.to_string())?;
    parse_ice_servers(&body)
}

/// Extracts `iceServers` from Cloudflare's response, dropping URLs on port 53
/// (browsers block it and those candidates just time out).
pub fn parse_ice_servers(body: &str) -> Result<Value, String> {
    let response: Value = serde_json::from_str(body).map_err(|err| err.to_string())?;
    let servers = response
        .get("iceServers")
        .and_then(Value::as_array)
        .ok_or("resposta sem iceServers")?;
    let cleaned: Vec<Value> = servers
        .iter()
        .filter_map(|server| {
            let urls: Vec<&str> = server
                .get("urls")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .filter(|url| !uses_port_53(url))
                .collect();
            if urls.is_empty() {
                return None;
            }
            let mut server = server.clone();
            server["urls"] = json!(urls);
            Some(server)
        })
        .collect();
    if cleaned.is_empty() {
        return Err("lista de iceServers vazia".into());
    }
    Ok(Value::Array(cleaned))
}

fn uses_port_53(url: &str) -> bool {
    let without_query = url.split('?').next().unwrap_or(url);
    without_query.ends_with(":53")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cloudflare_response_and_drops_port_53() {
        let body = r#"{"iceServers":[
            {"urls":["stun:stun.cloudflare.com:3478","stun:stun.cloudflare.com:53"]},
            {"urls":["turn:turn.cloudflare.com:3478?transport=udp","turn:turn.cloudflare.com:53?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],
             "username":"u","credential":"c"}
        ]}"#;
        assert_eq!(
            parse_ice_servers(body).unwrap(),
            json!([
                { "urls": ["stun:stun.cloudflare.com:3478"] },
                { "urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
                  "username": "u", "credential": "c" }
            ])
        );
    }

    #[test]
    fn rejects_unexpected_responses() {
        assert!(parse_ice_servers("not json").is_err());
        assert!(parse_ice_servers(r#"{"errors":["nope"]}"#).is_err());
        assert!(parse_ice_servers(r#"{"iceServers":[{"urls":["stun:x:53"]}]}"#).is_err());
    }

    #[tokio::test]
    async fn stun_only_without_a_key() {
        let ice = Ice::stun_only();
        assert!(!ice.has_turn());
        assert_eq!(ice.servers().await, stun_servers());
    }
}
