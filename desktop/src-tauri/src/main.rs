#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

use host::HostManager;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn host_status(state: tauri::State<'_, HostManager>) -> host::HostStatus {
    state.status()
}

#[tauri::command]
fn retry_host(state: tauri::State<'_, HostManager>) -> Result<(), String> {
    state.retry()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![host_status, retry_host])
        .setup(|app| {
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("小梦 Host")
                    .inner_size(1180.0, 850.0)
                    .min_inner_size(760.0, 620.0)
                    .center()
                    .on_navigation(host::allowed_navigation)
                    .build()?;
            let local_url = window.url()?;
            let runtime = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            app.manage(HostManager::new(app.handle().clone(), runtime, local_url));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法初始化小梦桌面应用");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let host = app.state::<HostManager>();
            if !host.exit_ready() {
                api.prevent_exit();
                host.shutdown();
            }
        }
    });
}
