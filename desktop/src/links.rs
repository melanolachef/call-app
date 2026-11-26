//! Links the page can't open by itself. The WebView ignores new-window
//! requests (`target="_blank"`, `window.open`), so in the app a "Apoiar" or an
//! external link did nothing; the page hands https and mailto links here and
//! the system opens them (default browser or mail app). Nothing else passes.

/// Opens `url` with the system's default handler.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !allowed(&url) {
        return Err("link recusado".to_owned());
    }
    open(&url)
}

/// Only web pages and e-mail: never files, programs or other schemes.
fn allowed(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("mailto:"))
        && url.len() <= 4096
        && !url.chars().any(char::is_control)
}

#[cfg(windows)]
fn open(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, target) = (wide("open"), wide(url));
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute reports success with a value above 32.
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!("o sistema não abriu o link ({})", result as isize))
    }
}

#[cfg(not(windows))]
fn open(_url: &str) -> Result<(), String> {
    Err("abrir links só existe no Windows".to_owned())
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn opens_only_web_pages_and_email() {
        assert!(allowed("https://cpx-call.fly.dev/apoiar"));
        assert!(allowed("mailto:denuncia@example.com?subject=oi"));
        for bad in [
            "http://exemplo.com",
            "file:///C:/Windows/System32/calc.exe",
            r"C:\Windows\System32\calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "https://exemplo.com/\nfile:///x",
        ] {
            assert!(!allowed(bad), "{bad}");
        }
        assert!(!allowed(&format!("https://{}", "a".repeat(5000))));
    }
}
