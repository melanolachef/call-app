//! Automatic updates (#186). The pages already update by themselves (the app
//! loads the site); only the native part needs a new installer. On start, the
//! app asks the latest release (`latest.json`) whether there is a newer
//! version; if so, the page shows "Atualização disponível · Reiniciar", and
//! the click downloads it, checks its signature, installs without a wizard and
//! reopens the app.
//!
//! Only builds made with the updater's public key (`CPX_UPDATER_PUBKEY`, set by
//! the release workflow) look for updates; others behave as before. Signatures
//! are bound to the version (`requireSignedVersion` in tauri.conf.json), so an
//! old installer can't be passed off as a newer one.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The updater's public key, given at build time; none means no updates.
pub fn public_key() -> Option<&'static str> {
    option_env!("CPX_UPDATER_PUBKEY").filter(|key| !key.trim().is_empty())
}

/// The update found on start, waiting for the click.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// Looks for a newer version; tells the page when there is one.
pub async fn check<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) {
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(err) => Err(err),
    };
    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            if let Ok(mut pending) = app.state::<Pending>().0.lock() {
                *pending = Some(update);
            }
            // The page also asks (update_status) once it loads, in case it wasn't ready yet.
            let _ = window.eval(format!(
                "window.cpxDesktop && window.cpxDesktop.updateReady && window.cpxDesktop.updateReady({})",
                version_literal(&version)
            ));
        }
        Ok(None) => {}
        Err(err) => eprintln!("CPX Call: não deu para procurar atualização ({err})"),
    }
}

/// The version waiting to be installed, if any.
#[tauri::command]
pub fn update_status(pending: State<'_, Pending>) -> Option<String> {
    pending.0.lock().ok()?.as_ref().map(|u| u.version.clone())
}

/// Downloads, verifies and installs the update, then reopens the app.
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let update = app
        .state::<Pending>()
        .0
        .lock()
        .map_err(|_| "atualização indisponível".to_owned())?
        .take()
        .ok_or_else(|| "nenhuma atualização pendente".to_owned())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|err| format!("não deu para atualizar ({err})"))?;
    app.restart();
}

/// `text` as a JavaScript string literal for eval: only what a version is
/// made of (letters, digits, `.`, `-`, `+`) gets through, so nothing can break
/// out of the quotes.
fn version_literal(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || ".-+".contains(*c))
        .collect();
    format!("\"{kept}\"")
}

#[cfg(test)]
mod tests {
    use super::version_literal;

    #[test]
    fn versions_go_into_the_page_as_plain_strings() {
        assert_eq!(version_literal("0.3.1"), "\"0.3.1\"");
        assert_eq!(version_literal("1.0.0-beta+2"), "\"1.0.0-beta+2\"");
        assert_eq!(version_literal("0.3\");alert(1);//"), "\"0.3alert1\"");
    }
}
