//! The window's title bar drawn by the page instead of Windows, so it follows
//! the app's theme and background (the native one is always white or grey).
//!
//! The window starts with the native bar and only drops it when the page asks
//! (`enable`): if the site never loads (offline, server down), the window keeps
//! a bar that can still be moved and closed. Pages from older servers never
//! ask, and pages talking to an older app get an error and keep the native bar,
//! so a window never shows two bars or none. Without the native frame, Tauri
//! still resizes the window from its edges and keeps the shadow on Windows.

use tauri::WebviewWindow;

/// One command for every title bar button, so the remote page is allowed this
/// and nothing else of the window API. Returns whether the window is maximized
/// afterwards, for the maximize/restore icon.
#[tauri::command]
pub fn window_control(window: WebviewWindow, action: &str) -> Result<bool, String> {
    match action {
        "enable" => window.set_decorations(false),
        "minimize" => window.minimize(),
        "toggle_maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // Must be called while the mouse button is down (mousedown on the bar).
        "drag" => window.start_dragging(),
        "close" => window.close(),
        "state" => Ok(()),
        _ => return Err(format!("unknown window action: {action}")),
    }
    .map_err(|e| e.to_string())?;
    // `close` may have already destroyed the window.
    Ok(action != "close" && window.is_maximized().unwrap_or(false))
}
