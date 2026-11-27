//! CPX Call for Windows: the same room as the browser, in its own window, plus
//! what a browser can't do: shortcuts that work while a game has the focus.
//!
//! The window loads the site (https://cpx-call.fly.dev, or `CPX_URL` while
//! developing), so the app never needs an update for web changes. The page
//! tells the app which push-to-talk key to watch (`set_ptt_key`); a low-level
//! keyboard hook *observes* that key and Ctrl+Shift+M without consuming them
//! (the game still gets them) and forwards them to the page. Nothing else is
//! read: every other key is ignored right in the hook. The page also draws the
//! window's title bar in the app's colors (`titlebar`), and the app updates
//! itself when a new version is released (`update`).

// No console window behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keys;
mod links;
mod titlebar;
mod update;

use tauri::{Manager, Url};

/// The page asks the app to watch this key (a `KeyboardEvent.code`, e.g.
/// "KeyV"); an empty code stops watching (push-to-talk off or out of voice).
#[tauri::command]
fn set_ptt_key(code: String) {
    keys::set_ptt_key(&code);
}

fn main() {
    let mut builder = tauri::Builder::default();
    // Updates only for builds that carry the updater's public key (releases).
    if let Some(key) = update::public_key() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(key).build());
    }
    builder
        .manage(update::Pending::default())
        .invoke_handler(tauri::generate_handler![
            set_ptt_key,
            titlebar::window_control,
            links::open_url,
            update::update_status,
            update::install_update
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the main window is declared in tauri.conf.json");
            // Development: CPX_URL=http://localhost:3000 points the app at a local server.
            if let Some(url) = std::env::var("CPX_URL")
                .ok()
                .and_then(|u| Url::parse(&u).ok())
            {
                window.navigate(url)?;
            }
            if update::public_key().is_some() {
                tauri::async_runtime::spawn(update::check(app.handle().clone(), window.clone()));
            }
            keys::start(window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running CPX Call");
}
