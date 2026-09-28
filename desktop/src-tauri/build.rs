fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["host_status", "retry_host"])),
    )
    .expect("failed to build desktop resources");
}
