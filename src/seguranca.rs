//! Security headers on every response: a second layer in case some text ever
//! slips into the page as HTML (Content-Security-Policy), no framing of the
//! site by others, no MIME sniffing, no referrer (room links stay private),
//! and only this site may use the camera, microphone and screen capture.

use axum::{
    extract::Request,
    http::{header, HeaderMap, HeaderValue},
    middleware::Next,
    response::Response,
};

/// Where GIFs come from (the picker, chat, profile): the same hosts the
/// pages accept (GIF_HOSTS in static/common.js).
const GIF_SOURCES: &str =
    "https://klipy.com https://*.klipy.com https://klipy.co https://*.klipy.co";

/// The policy for this host. `ws(s)://host` is spelled out because older
/// browsers don't count WebSockets as 'self'. `ipc:` and ipc.localhost are
/// how the Windows app (Tauri) talks to its Rust side from this page.
pub fn content_security_policy(host: &str) -> String {
    let host: String = host
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
        .collect();
    let sockets = if host.is_empty() {
        String::new()
    } else {
        format!(" wss://{host} ws://{host}")
    };
    [
        "default-src 'self'".to_owned(),
        "script-src 'self'".to_owned(),
        // Inline <style> blocks and style attributes are part of how the pages are built.
        "style-src 'self' 'unsafe-inline'".to_owned(),
        format!("img-src 'self' data: blob: {GIF_SOURCES}"),
        "media-src 'self' data: blob:".to_owned(),
        "font-src 'self'".to_owned(),
        format!("connect-src 'self'{sockets} {GIF_SOURCES} ipc: http://ipc.localhost"),
        "object-src 'none'".to_owned(),
        "base-uri 'none'".to_owned(),
        "form-action 'self'".to_owned(),
        "frame-ancestors 'none'".to_owned(),
    ]
    .join("; ")
}

fn add(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

pub async fn headers(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let mut response = next.run(request).await;
    let h = response.headers_mut();
    add(
        h,
        "content-security-policy",
        &content_security_policy(&host),
    );
    add(h, "x-content-type-options", "nosniff");
    add(h, "x-frame-options", "DENY");
    add(h, "referrer-policy", "no-referrer");
    add(
        h,
        "permissions-policy",
        "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), picture-in-picture=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
    );
    // Browsers only honor this over HTTPS (production); plain http ignores it.
    add(h, "strict-transport-security", "max-age=31536000");
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_names_this_host_for_websockets() {
        let csp = content_security_policy("cpx-call.fly.dev");
        assert!(csp.contains("connect-src 'self' wss://cpx-call.fly.dev ws://cpx-call.fly.dev"));
        assert!(csp.contains("script-src 'self';"));
        assert!(csp.contains("frame-ancestors 'none'"));
    }

    #[test]
    fn odd_host_header_cant_inject_into_the_policy() {
        let csp = content_security_policy("x; script-src *");
        assert!(!csp.contains("script-src *"));
        let directives: Vec<&str> = csp.split("; ").collect();
        assert_eq!(
            directives
                .iter()
                .filter(|d| d.starts_with("script-src"))
                .count(),
            1
        );
        assert!(directives.contains(&"script-src 'self'"));
    }
}
