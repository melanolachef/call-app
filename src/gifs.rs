//! GIF search for the chat, through the server: the API key stays here and
//! the GIF service never sees who is searching (only the server's address).
//! Uses KLIPY's Tenor-compatible API (`GIF_API_KEY`, optionally
//! `GIF_API_BASE`); without a key the feature is off and the page hides it.
//!
//! Nothing is stored: recent answers are kept in memory for a few minutes,
//! so a room full of people opening the GIF tab costs one call, and the
//! free key's hourly limit lasts.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::sync::Mutex;

const DEFAULT_API_BASE: &str = "https://api.klipy.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const CACHE_FOR: Duration = Duration::from_secs(10 * 60);
const CACHE_MAX: usize = 300;
const PAGE_SIZE: u32 = 24;
pub const QUERY_MAX: usize = 50;
const POS_MAX: usize = 64;

pub struct Gifs {
    key: Option<String>,
    api_base: String,
    cache: Mutex<HashMap<(String, String), (Instant, Value)>>,
}

/// Why a search gave nothing.
#[derive(Debug, PartialEq)]
pub enum GifError {
    Disabled,
    Unavailable,
}

impl Gifs {
    pub fn from_env() -> Arc<Self> {
        let var = |name| {
            std::env::var(name)
                .ok()
                .filter(|v: &String| !v.trim().is_empty())
        };
        let api_base = var("GIF_API_BASE").unwrap_or_else(|| DEFAULT_API_BASE.to_owned());
        Arc::new(Self::new(var("GIF_API_KEY"), api_base))
    }

    pub fn disabled() -> Arc<Self> {
        Arc::new(Self::new(None, DEFAULT_API_BASE.to_owned()))
    }

    #[cfg(test)]
    pub fn with_key(key: &str, api_base: &str) -> Arc<Self> {
        Arc::new(Self::new(Some(key.to_owned()), api_base.to_owned()))
    }

    fn new(key: Option<String>, api_base: String) -> Self {
        Self {
            key,
            api_base: api_base.trim_end_matches('/').to_owned(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.key.is_some()
    }

    /// Trending when `query` is empty, a search otherwise. `pos` is the
    /// service's cursor for the next page ("" for the first).
    pub async fn search(&self, query: &str, pos: &str) -> Result<Value, GifError> {
        let Some(key) = &self.key else {
            return Err(GifError::Disabled);
        };
        let query: String = query
            .trim()
            .chars()
            .take(QUERY_MAX)
            .collect::<String>()
            .to_lowercase();
        let pos: String = pos.chars().take(POS_MAX).collect();
        let cache_key = (query.clone(), pos.clone());
        {
            let mut cache = self.cache.lock().await;
            cache.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
            if let Some((_, value)) = cache.get(&cache_key) {
                return Ok(value.clone());
            }
        }

        let mut params = vec![
            ("key", key.clone()),
            ("client_key", "cpx-call".to_owned()),
            ("limit", PAGE_SIZE.to_string()),
            ("media_filter", "gif,tinygif".to_owned()),
            ("contentfilter", "medium".to_owned()),
            ("locale", "pt_BR".to_owned()),
        ];
        if !pos.is_empty() {
            params.push(("pos", pos.clone()));
        }
        let path = if query.is_empty() {
            "featured"
        } else {
            params.push(("q", query.clone()));
            "search"
        };
        let url = format!("{}/v2/{path}", self.api_base);
        let fetched = tokio::task::spawn_blocking(move || fetch(&url, &params)).await;
        let value = match fetched {
            Ok(Ok(body)) => parse_results(&body).map_err(|err| {
                eprintln!("GIFs: resposta inesperada ({err})");
                GifError::Unavailable
            })?,
            Ok(Err(err)) => {
                // The error text never includes the key (it is only in the query).
                eprintln!("GIFs: serviço indisponível ({err})");
                return Err(GifError::Unavailable);
            }
            Err(_) => return Err(GifError::Unavailable),
        };
        let mut cache = self.cache.lock().await;
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(cache_key, (Instant::now(), value.clone()));
        Ok(value)
    }
}

fn fetch(url: &str, params: &[(&str, String)]) -> Result<String, String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .new_agent();
    let mut request = agent.get(url);
    for (name, value) in params {
        request = request.query(name, value);
    }
    let mut response = request.call().map_err(|err| match err {
        ureq::Error::StatusCode(code) => format!("HTTP {code}"),
        _ => "sem resposta".to_owned(),
    })?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|err| err.to_string())
}

/// Keeps only what the page shows, from a Tenor-style answer:
/// `{ results: [{ id, title, preview: {url,w,h}, gif: {url,w,h} }], next }`.
/// Only https media survives.
pub fn parse_results(body: &str) -> Result<Value, String> {
    let response: Value = serde_json::from_str(body).map_err(|err| err.to_string())?;
    let results = response
        .get("results")
        .and_then(Value::as_array)
        .ok_or("resposta sem results")?;
    let media = |item: &Value, format: &str| -> Option<Value> {
        let entry = item.get("media_formats")?.get(format)?;
        let url = entry.get("url")?.as_str()?;
        if !url.starts_with("https://") || url.len() > 500 {
            return None;
        }
        let dims = entry.get("dims").and_then(Value::as_array);
        let dim = |i: usize| {
            dims.and_then(|d| d.get(i))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        Some(json!({ "url": url, "w": dim(0), "h": dim(1) }))
    };
    let items: Vec<Value> = results
        .iter()
        .filter_map(|item| {
            let gif = media(item, "gif")?;
            let preview = media(item, "tinygif").unwrap_or_else(|| gif.clone());
            let title: String = item
                .get("content_description")
                .or_else(|| item.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(80)
                .collect();
            let id = item.get("id").map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            });
            Some(json!({ "id": id, "title": title, "preview": preview, "gif": gif }))
        })
        .collect();
    let next = response.get("next").and_then(Value::as_str).unwrap_or("");
    Ok(json!({ "results": items, "next": next }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_https_media_and_what_is_shown() {
        let body = json!({
            "results": [
                { "id": "1", "content_description": "gato dançando",
                  "media_formats": {
                      "gif": { "url": "https://static.klipy.com/a.gif", "dims": [480, 270] },
                      "tinygif": { "url": "https://static.klipy.com/a-small.gif", "dims": [220, 124] },
                      "mp4": { "url": "https://static.klipy.com/a.mp4" } } },
                { "id": 2, "media_formats": { "gif": { "url": "http://insecure/b.gif" } } },
                { "id": "3", "media_formats": { "gif": { "url": "https://static.klipy.com/c.gif", "dims": [100, 100] } } }
            ],
            "next": "24"
        })
        .to_string();
        let parsed = parse_results(&body).unwrap();
        let results = parsed["results"].as_array().unwrap();
        assert_eq!(results.len(), 2, "the http one is dropped");
        assert_eq!(results[0]["title"], "gato dançando");
        assert_eq!(
            results[0]["preview"]["url"],
            "https://static.klipy.com/a-small.gif"
        );
        assert_eq!(results[0]["gif"]["w"], 480);
        assert_eq!(
            results[1]["preview"], results[1]["gif"],
            "no preview: the gif itself"
        );
        assert_eq!(parsed["next"], "24");
        assert!(parse_results("{}").is_err());
    }
}
