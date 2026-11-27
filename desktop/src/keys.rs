//! Shortcuts that work while another window (a game) has the focus.
//!
//! A low-level keyboard hook sees every key press system-wide, so it is kept
//! as narrow as possible: it compares the key with the push-to-talk key the
//! page asked for and with Ctrl+Shift+M / Ctrl+Shift+D, and drops everything else on the
//! spot. It never blocks a key (the game still receives it). While the app's
//! own window is in front, the page handles its keys itself, so the hook stays
//! quiet to avoid doing everything twice.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::SeqCst};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;

use tauri::WebviewWindow;

/// What the page is told.
enum Event {
    Ptt(bool),
    ToggleMute,
    ToggleDeafen,
}

/// Virtual-key code of the push-to-talk key; 0 = not watching.
static PTT_VK: AtomicU32 = AtomicU32::new(0);
static PTT_HELD: AtomicBool = AtomicBool::new(false);
static EVENTS: OnceLock<Sender<Event>> = OnceLock::new();

pub fn set_ptt_key(code: &str) {
    let vk = vk_from_code(code).unwrap_or(0);
    // Changing or clearing the key while it is held must not leave the mic open.
    if PTT_VK.swap(vk, SeqCst) != vk && PTT_HELD.swap(false, SeqCst) {
        send(Event::Ptt(false));
    }
}

fn send(event: Event) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send(event);
    }
}

/// Starts forwarding shortcuts to `window`'s page.
pub fn start(window: WebviewWindow) {
    let (tx, rx) = channel();
    let _ = EVENTS.set(tx);
    #[cfg(windows)]
    hook::start(&window);
    // The hook callback must return fast, so the page is called from here.
    std::thread::spawn(move || {
        for event in rx {
            let call = match event {
                Event::Ptt(down) => format!("ptt({down})"),
                Event::ToggleMute => "toggleMute()".to_owned(),
                Event::ToggleDeafen => "toggleDeafen()".to_owned(),
            };
            let _ = window.eval(format!("window.cpxDesktop && window.cpxDesktop.{call}"));
        }
    });
}

/// `KeyboardEvent.code` → Windows virtual-key code, for the keys a person may
/// pick for push-to-talk in the voice settings.
fn vk_from_code(code: &str) -> Option<u32> {
    let one = |prefix: &str| code.strip_prefix(prefix).filter(|rest| rest.len() == 1);
    if let Some(c) = one("Key").and_then(|r| r.chars().next()) {
        return c.is_ascii_uppercase().then_some(c as u32); // VK_A..VK_Z = 'A'..'Z'
    }
    if let Some(c) = one("Digit").and_then(|r| r.chars().next()) {
        return c.is_ascii_digit().then_some(c as u32); // VK_0..VK_9 = '0'..'9'
    }
    if let Some(n) = code
        .strip_prefix("Numpad")
        .and_then(|r| r.parse::<u32>().ok())
    {
        return (n <= 9).then_some(0x60 + n);
    }
    if let Some(n) = code.strip_prefix('F').and_then(|r| r.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then_some(0x70 + n - 1);
    }
    Some(match code {
        "Space" => 0x20,
        "Tab" => 0x09,
        "CapsLock" => 0x14,
        "ShiftLeft" => 0xA0,
        "ShiftRight" => 0xA1,
        "ControlLeft" => 0xA2,
        "ControlRight" => 0xA3,
        "AltLeft" => 0xA4,
        "AltRight" => 0xA5,
        "Backquote" => 0xC0,
        "Minus" => 0xBD,
        "Equal" => 0xBB,
        "BracketLeft" => 0xDB,
        "BracketRight" => 0xDD,
        "Backslash" => 0xDC,
        "IntlBackslash" => 0xE2,
        "Semicolon" => 0xBA,
        "Quote" => 0xDE,
        "Comma" => 0xBC,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Pause" => 0x13,
        "ScrollLock" => 0x91,
        _ => return None,
    })
}

#[cfg(windows)]
mod hook {
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering::SeqCst};

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SHIFT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, SetWindowsHookExW, HC_ACTION,
        KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use super::{send, Event, PTT_HELD, PTT_VK};

    static OUR_WINDOW: AtomicIsize = AtomicIsize::new(0);
    static M_HELD: AtomicBool = AtomicBool::new(false);
    static D_HELD: AtomicBool = AtomicBool::new(false);
    const VK_M: u32 = b'M' as u32;
    const VK_D: u32 = b'D' as u32;

    pub fn start(window: &tauri::WebviewWindow) {
        if let Ok(hwnd) = window.hwnd() {
            OUR_WINDOW.store(hwnd.0 as isize, SeqCst);
        }
        // A low-level hook runs on the thread that installed it, which must
        // keep pumping messages.
        std::thread::spawn(|| unsafe {
            let module = GetModuleHandleW(null_mut());
            if SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0).is_null() {
                eprintln!("CPX Call: não deu para instalar os atalhos globais");
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {}
        });
    }

    fn held(vk: u16) -> bool {
        // The high bit says the key is down right now.
        unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
    }

    unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let key = &*(lparam as *const KBDLLHOOKSTRUCT);
            let msg = wparam as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            let app_in_front = GetForegroundWindow() as isize == OUR_WINDOW.load(SeqCst);
            let ptt = PTT_VK.load(SeqCst);

            if ptt != 0 && key.vkCode == ptt {
                if down && !app_in_front && !PTT_HELD.swap(true, SeqCst) {
                    send(Event::Ptt(true)); // key repeat doesn't resend
                } else if up && PTT_HELD.swap(false, SeqCst) {
                    send(Event::Ptt(false)); // even if the app came to the front meanwhile
                }
            }
            // Ctrl+Shift+M (mic) and Ctrl+Shift+D (headphones), once per press.
            for (vk, flag, event) in [
                (VK_M, &M_HELD, Event::ToggleMute),
                (VK_D, &D_HELD, Event::ToggleDeafen),
            ] {
                if key.vkCode != vk {
                    continue;
                }
                if down
                    && !flag.swap(true, SeqCst)
                    && !app_in_front
                    && held(VK_CONTROL)
                    && held(VK_SHIFT)
                {
                    send(event);
                } else if up {
                    flag.store(false, SeqCst);
                }
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::vk_from_code;

    #[test]
    fn maps_the_usual_push_to_talk_keys() {
        assert_eq!(vk_from_code("KeyV"), Some(0x56));
        assert_eq!(vk_from_code("Digit4"), Some(0x34));
        assert_eq!(vk_from_code("F13"), Some(0x7C));
        assert_eq!(vk_from_code("Numpad0"), Some(0x60));
        assert_eq!(vk_from_code("Backquote"), Some(0xC0));
        assert_eq!(vk_from_code("AltLeft"), Some(0xA4));
        assert_eq!(vk_from_code("Space"), Some(0x20));
    }

    #[test]
    fn rejects_unknown_codes() {
        for code in [
            "",
            "Keyv",
            "KeyAB",
            "Digit",
            "F0",
            "F25",
            "Numpad10",
            "MediaPlay",
        ] {
            assert_eq!(vk_from_code(code), None, "{code}");
        }
    }
}
