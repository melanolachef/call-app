fn main() {
    // Declares the app's own commands so capabilities/remote.json can allow
    // exactly them (and nothing else) for the remote page.
    let manifest = tauri_build::AppManifest::new().commands(&["set_ptt_key"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
