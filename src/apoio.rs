//! Voluntary support (`/apoiar`): a static Pix code, the same for everyone,
//! with no amount, so people pay what they want from their bank app. The
//! key, name and city come from the environment (`PIX_KEY`, `PIX_NAME`,
//! `PIX_CITY`); without a key the page says support isn't open and the
//! lobby hides its link. Nothing about who paid ever reaches the server.

use std::sync::Arc;

use qrcode::{render::svg, EcLevel, QrCode};

/// Limits of the Pix "copia e cola" (BR Code) fields.
const NAME_MAX: usize = 25;
const CITY_MAX: usize = 15;
const KEY_MAX: usize = 77;

pub struct Apoio {
    /// The "copia e cola" text.
    pub payload: String,
    /// Who receives, as the bank app will show it.
    pub name: String,
    /// The same code as a QR image, for paying from the phone while on a PC.
    pub qr_svg: String,
}

impl Apoio {
    /// Reads the Pix key from the environment; `None` when support is off.
    pub fn from_env() -> Option<Arc<Self>> {
        let var = |name| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let key = var("PIX_KEY")?;
        let name = var("PIX_NAME").unwrap_or_else(|| "CPX Call".to_owned());
        let city = var("PIX_CITY").unwrap_or_else(|| "Brasil".to_owned());
        match Self::new(&key, &name, &city) {
            Some(apoio) => Some(Arc::new(apoio)),
            None => {
                eprintln!(
                    "PIX_KEY inválida (vazia ou com mais de {KEY_MAX} caracteres): apoio desligado"
                );
                None
            }
        }
    }

    pub fn new(key: &str, name: &str, city: &str) -> Option<Self> {
        let key = key.trim();
        if key.is_empty() || key.chars().count() > KEY_MAX {
            return None;
        }
        let name = field_text(name, NAME_MAX);
        let city = field_text(city, CITY_MAX);
        let payload = pix_payload(key, &name, &city);
        let qr_svg = QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M)
            .ok()?
            .render::<svg::Color>()
            .min_dimensions(240, 240)
            .quiet_zone(true)
            .build();
        Some(Self {
            payload,
            name,
            qr_svg,
        })
    }
}

/// Name and city go in plain ASCII (bank apps choke on accents), cut to size.
fn field_text(text: &str, max: usize) -> String {
    let plain: String = text
        .trim()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'A',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'É' | 'È' | 'Ê' | 'Ë' => 'E',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'Í' | 'Ì' | 'Î' | 'Ï' => 'I',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'O',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'Ú' | 'Ù' | 'Û' | 'Ü' => 'U',
            'ç' => 'c',
            'Ç' => 'C',
            'ñ' => 'n',
            'Ñ' => 'N',
            c if c.is_ascii_graphic() || c == ' ' => c,
            _ => ' ',
        })
        .collect();
    plain
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// One EMV field: id, two-digit length, value.
fn tlv(id: &str, value: &str) -> String {
    format!("{id}{:02}{value}", value.len())
}

/// Static Pix BR Code (Banco Central's "Manual de Padrões para Iniciação do
/// Pix"): no amount, transaction id "***".
fn pix_payload(key: &str, name: &str, city: &str) -> String {
    let account = tlv("00", "br.gov.bcb.pix") + &tlv("01", key);
    let mut payload = [
        tlv("00", "01"),
        tlv("26", &account),
        tlv("52", "0000"),
        tlv("53", "986"),
        tlv("58", "BR"),
        tlv("59", name),
        tlv("60", city),
        tlv("62", &tlv("05", "***")),
    ]
    .concat();
    payload.push_str("6304");
    let crc = crc16(payload.as_bytes());
    payload.push_str(&format!("{crc:04X}"));
    payload
}

/// CRC-16/CCITT-FALSE (poly 0x1021, start 0xFFFF), as the BR Code asks.
fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &byte in data {
        crc ^= u16::from(byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_the_standard_check_value() {
        assert_eq!(crc16(b"123456789"), 0x29B1);
    }

    #[test]
    fn payload_has_every_field_and_a_valid_crc() {
        let payload = pix_payload("cpx@example.com", "Fulano de Tal", "BRASILIA");
        assert_eq!(
            &payload[..payload.len() - 4],
            "00020126370014br.gov.bcb.pix0115cpx@example.com\
             52040000530398658\
             02BR5913Fulano de Tal6008BRASILIA62070503***6304"
        );
        let (body, crc) = payload.split_at(payload.len() - 4);
        assert_eq!(crc, format!("{:04X}", crc16(body.as_bytes())));
    }

    #[test]
    fn names_lose_accents_and_are_cut() {
        assert_eq!(field_text("  São   João ", 15), "Sao Joao");
        assert_eq!(
            field_text("Ação Pública da Galera Gamer", NAME_MAX),
            "Acao Publica da Galera Ga"
        );
    }

    #[test]
    fn empty_or_huge_key_turns_support_off() {
        assert!(Apoio::new("  ", "x", "y").is_none());
        assert!(Apoio::new(&"a".repeat(KEY_MAX + 1), "x", "y").is_none());
        let apoio = Apoio::new("+5511999999999", "Lucas", "São Paulo").unwrap();
        assert!(apoio.payload.contains("0114+5511999999999"));
        assert!(apoio.payload.contains("6009Sao Paulo"));
        assert!(apoio.qr_svg.starts_with("<?xml"));
    }
}
