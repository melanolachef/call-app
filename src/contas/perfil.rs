//! The profile saved in the account (#159): nick, photo and banner follow
//! you to every device. Until now images never reached the server, so they
//! are checked here as strictly as the pages check what other people send:
//! only an embedded JPEG/PNG/WebP whose bytes really are that kind of image,
//! a GIF from the picker's service, or a small GIF of your own (#175) that
//! really is a GIF, and nothing bigger than the pages allow.

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::json;

use super::{clean_nick, current, now, off, signed_out, Contas, ContasState, Problem};
use axum::extract::FromRef;

/// Same limits as static/common.js (MAX_PHOTO, MAX_BANNER_IMAGE).
const MAX_PHOTO: usize = 40_000;
const MAX_BANNER_IMAGE: usize = 30_000;
const MAX_GIF_URL: usize = 340;
const GIF_HOSTS: &[&str] = &["klipy.com", "klipy.co"];
/// Own GIFs (#175), like ownGif() in static/common.js.
const MAX_OWN_GIF: usize = 60_000;
const OWN_GIF_MAX_SIDE: u16 = 640;
const OWN_GIF_MAX_FRAMES: usize = 300;

#[derive(Debug, PartialEq, Clone, Default)]
pub struct Profile {
    pub nick: String,
    pub photo: String,
    pub banner_color: String,
    pub banner_image: String,
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim_end_matches('=');
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in text.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
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

/// `data:image/<kind>;base64,...` whose bytes start like that kind of image.
fn embedded_image(value: &str, kinds: &[&str], max: usize) -> bool {
    if value.len() > max {
        return false;
    }
    let Some(rest) = value.strip_prefix("data:image/") else {
        return false;
    };
    let Some((kind, data)) = rest.split_once(";base64,") else {
        return false;
    };
    if !kinds.contains(&kind) {
        return false;
    }
    let Some(bytes) = base64_decode(data) else {
        return false;
    };
    match kind {
        "jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "webp" => bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// `https://<klipy host>/<path>.gif`, optionally with the page's crop
/// (`#p=x,y,size`), like profileGif() in static/common.js.
fn gif_url(value: &str) -> bool {
    if value.len() > MAX_GIF_URL {
        return false;
    }
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    let (url, crop) = rest
        .split_once('#')
        .map_or((rest, None), |(u, c)| (u, Some(c)));
    if crop.is_some_and(|crop| !crop_ok(crop)) {
        return false;
    }
    let Some((host, path)) = url.split_once('/') else {
        return false;
    };
    let host_ok = GIF_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")));
    let path_ok = path.ends_with(".gif")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~/-".contains(&b));
    host_ok && path_ok
}

/// How the page framed a GIF: `p=x,y,size`.
fn crop_ok(crop: &str) -> bool {
    let Some(numbers) = crop.strip_prefix("p=") else {
        return false;
    };
    let parts: Vec<&str> = numbers.split(',').collect();
    let numeric = |p: &&str| {
        !p.is_empty() && p.len() <= 7 && p.bytes().all(|b| b.is_ascii_digit() || b == b'.')
    };
    parts.len() == 3 && parts.iter().all(numeric)
}

#[derive(Debug, PartialEq)]
struct GifInfo {
    width: u16,
    height: u16,
    frames: usize,
}

/// Walks a GIF block by block (header, color tables, extensions, frames);
/// None if anything is out of place. Like gifInfo() in static/common.js.
fn gif_info(bytes: &[u8]) -> Option<GifInfo> {
    if bytes.len() < 13 || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return None;
    }
    let width = u16::from_le_bytes([bytes[6], bytes[7]]);
    let height = u16::from_le_bytes([bytes[8], bytes[9]]);
    let table = |flags: u8| {
        if flags & 0x80 != 0 {
            3 << ((flags & 7) + 1)
        } else {
            0
        }
    };
    let mut at = 13 + table(bytes[10]);
    // Data sub-blocks: a size byte, that many bytes, until a 0.
    let skip_blocks = |at: &mut usize| -> Option<()> {
        loop {
            let size = *bytes.get(*at)? as usize;
            *at += 1;
            if size == 0 {
                return Some(());
            }
            *at += size;
        }
    };
    let mut frames = 0;
    while let Some(&kind) = bytes.get(at) {
        match kind {
            0x3B => break,
            0x21 => {
                at += 2;
                skip_blocks(&mut at)?;
            }
            0x2C => {
                let flags = *bytes.get(at + 9)?;
                at += 10 + table(flags) + 1;
                skip_blocks(&mut at)?;
                frames += 1;
            }
            _ => return None,
        }
    }
    (frames > 0 && width > 0 && height > 0).then_some(GifInfo {
        width,
        height,
        frames,
    })
}

/// `data:image/gif;base64,...` (optionally framed, `#p=x,y,size`) holding a
/// small, well-formed GIF.
fn own_gif(value: &str) -> bool {
    if value.len() > MAX_OWN_GIF {
        return false;
    }
    let Some(rest) = value.strip_prefix("data:image/gif;base64,") else {
        return false;
    };
    let (data, crop) = rest
        .split_once('#')
        .map_or((rest, None), |(d, c)| (d, Some(c)));
    if crop.is_some_and(|crop| !crop_ok(crop)) {
        return false;
    }
    base64_decode(data)
        .and_then(|bytes| gif_info(&bytes))
        .is_some_and(|info| {
            info.width <= OWN_GIF_MAX_SIDE
                && info.height <= OWN_GIF_MAX_SIDE
                && info.frames <= OWN_GIF_MAX_FRAMES
        })
}

pub fn valid_photo(value: &str) -> bool {
    value.is_empty()
        || gif_url(value)
        || own_gif(value)
        || embedded_image(value, &["jpeg", "png", "webp"], MAX_PHOTO)
}

pub fn valid_banner_image(value: &str) -> bool {
    value.is_empty()
        || gif_url(value)
        || own_gif(value)
        || embedded_image(value, &["jpeg"], MAX_BANNER_IMAGE)
}

pub fn valid_color(value: &str) -> bool {
    value.is_empty()
        || (value.len() == 7
            && value.starts_with('#')
            && value[1..].bytes().all(|b| b.is_ascii_hexdigit()))
}

impl Contas {
    /// The saved profile, or None if this account never saved one.
    pub fn profile(&self, user: i64) -> Option<Profile> {
        self.db()
            .query_row(
                "SELECT nick, photo, banner_color, banner_image FROM users WHERE id = ?1 AND profile_at IS NOT NULL",
                params![user],
                |r| Ok(Profile { nick: r.get(0)?, photo: r.get(1)?, banner_color: r.get(2)?, banner_image: r.get(3)? }),
            )
            .ok()
    }

    pub fn save_profile(&self, user: i64, profile: &Profile) -> Result<Profile, Problem> {
        let nick = clean_nick(&profile.nick).ok_or(Problem::BadNick)?;
        if !valid_photo(&profile.photo)
            || !valid_banner_image(&profile.banner_image)
            || !valid_color(&profile.banner_color)
        {
            return Err(Problem::BadImage);
        }
        self.db()
            .execute(
                "UPDATE users SET nick = ?1, photo = ?2, banner_color = ?3, banner_image = ?4, profile_at = ?5 WHERE id = ?6",
                params![nick, profile.photo, profile.banner_color, profile.banner_image, now(), user],
            )
            .map_err(|_| Problem::Database)?;
        Ok(Profile {
            nick,
            ..profile.clone()
        })
    }
}

// ---------- rotas ----------

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    ContasState: FromRef<S>,
{
    Router::new().route("/api/me/perfil", get(read).put(write))
}

fn body(profile: Option<&Profile>) -> serde_json::Value {
    match profile {
        Some(p) => {
            json!({ "salvo": true, "nick": p.nick, "photo": p.photo, "bannerColor": p.banner_color, "bannerImage": p.banner_image })
        }
        None => json!({ "salvo": false }),
    }
}

/// `GET /api/me/perfil` -> `{salvo, nick?, photo?, bannerColor?, bannerImage?}`.
async fn read(State(contas): State<ContasState>, headers: HeaderMap) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    Json(body(contas.profile(me.id).as_ref())).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIn {
    nick: String,
    #[serde(default)]
    photo: String,
    #[serde(default)]
    banner_color: String,
    #[serde(default)]
    banner_image: String,
}

/// `PUT /api/me/perfil {nick, photo, bannerColor, bannerImage}`.
async fn write(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Json(input): Json<ProfileIn>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    let profile = Profile {
        nick: input.nick,
        photo: input.photo,
        banner_color: input.banner_color,
        banner_image: input.banner_image,
    };
    match contas.save_profile(me.id, &profile) {
        Ok(saved) => Json(body(Some(&saved))).into_response(),
        Err(problem) => problem.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contas::tests::memory;

    const PNG_1PX: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn images_must_really_be_images() {
        assert!(valid_photo(""));
        assert!(valid_photo(PNG_1PX));
        // Says PNG, but the bytes are text.
        assert!(!valid_photo(
            "data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="
        ));
        // SVG can carry scripts: never.
        assert!(!valid_photo("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="));
        assert!(!valid_photo(&format!("{PNG_1PX}{}", "A".repeat(MAX_PHOTO))));
        assert!(!valid_banner_image(PNG_1PX), "banners are JPEG only");
    }

    fn base64(bytes: &[u8]) -> String {
        const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
            for i in 0..=chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            }
        }
        while !out.len().is_multiple_of(4) {
            out.push('=');
        }
        out
    }

    /// A `width`x`height` GIF with `frames` one-pixel frames.
    fn gif(width: u16, height: u16, frames: usize) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend(width.to_le_bytes());
        bytes.extend(height.to_le_bytes());
        bytes.extend([0x80, 0, 0, 0, 0, 0, 255, 255, 255]); // 2-color table
        bytes.extend(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"); // loop forever
        for _ in 0..frames {
            bytes.extend(b"\x21\xF9\x04\x00\x0A\x00\x00\x00"); // 100 ms
            bytes.extend(b"\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00");
        }
        bytes.push(0x3B);
        bytes
    }

    fn data_url(bytes: &[u8]) -> String {
        format!("data:image/gif;base64,{}", base64(bytes))
    }

    #[test]
    fn own_gifs_are_checked_block_by_block() {
        assert_eq!(
            gif_info(&gif(48, 32, 3)),
            Some(GifInfo {
                width: 48,
                height: 32,
                frames: 3
            })
        );
        assert!(valid_photo(&data_url(&gif(128, 128, 2))));
        assert!(valid_banner_image(&format!(
            "{}#p=20,35.5,160",
            data_url(&gif(600, 200, 2))
        )));
        assert!(
            !valid_photo(&format!("{}#x=1", data_url(&gif(8, 8, 2)))),
            "only the framing"
        );
        assert!(!valid_photo(&data_url(&gif(641, 100, 2))), "too wide");
        assert!(
            !valid_photo(&data_url(&gif(10, 10, 301))),
            "too many frames"
        );
        assert!(!valid_photo(&data_url(&gif(10, 10, 0))), "no frames");
        let cut = gif(10, 10, 2);
        assert!(
            !valid_photo(&data_url(&cut[..cut.len() - 6])),
            "cut in the middle"
        );
        let mut junk = gif(10, 10, 2);
        junk.insert(junk.len() - 1, b'<');
        assert!(!valid_photo(&data_url(&junk)), "a block of unknown kind");
        assert!(!valid_photo(&data_url(b"<svg onload=alert(1)>")));
        let mut big = gif(10, 10, 2);
        let mut comment = vec![0x21, 0xFE];
        for _ in 0..200 {
            comment.push(250);
            comment.extend([b'a'; 250]);
        }
        comment.push(0);
        big.splice(big.len() - 1..big.len() - 1, comment);
        assert!(gif_info(&big).is_some(), "a comment block is fine");
        assert!(!valid_photo(&data_url(&big)), "but not over the size limit");
    }

    #[test]
    fn gifs_only_from_the_picker_service() {
        assert!(valid_photo("https://static.klipy.com/ii/abc/1a/gato.gif"));
        assert!(valid_photo(
            "https://static.klipy.com/ii/abc/gato.gif#p=20,35,160"
        ));
        assert!(!valid_photo("https://malicioso.exemplo/gato.gif"));
        assert!(!valid_photo("https://klipy.com.malicioso.exemplo/gato.gif"));
        assert!(!valid_photo("http://static.klipy.com/gato.gif"));
        assert!(!valid_photo("https://static.klipy.com/gato.gif#p=1,2"));
        assert!(!valid_photo("https://static.klipy.com/a\"onerror=x.gif"));
    }

    #[test]
    fn colors() {
        assert!(valid_color("#0A84FF"));
        assert!(!valid_color("red"));
        assert!(!valid_color("#0A84FF;background:url(x)"));
    }

    #[test]
    fn saved_profile_round_trip() {
        let contas = memory("http://nada");
        let id = contas.user_for_google("g-1").unwrap();
        assert_eq!(contas.profile(id), None, "never saved");
        let profile = Profile {
            nick: "  Lucas ".into(),
            photo: PNG_1PX.into(),
            banner_color: "#0A84FF".into(),
            banner_image: String::new(),
        };
        let saved = contas.save_profile(id, &profile).unwrap();
        assert_eq!(saved.nick, "Lucas");
        assert_eq!(contas.profile(id), Some(saved));
        let bad = Profile {
            photo: "data:image/png;base64,AAAA".into(),
            ..profile
        };
        assert_eq!(contas.save_profile(id, &bad), Err(Problem::BadImage));
    }
}
