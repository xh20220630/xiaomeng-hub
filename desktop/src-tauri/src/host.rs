use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Url};

const PAIR_URL: &str = "http://localhost:4897/pair/";
const INFO_URL: &str = "http://localhost:4897/pair/info";

#[derive(Clone, Serialize)]
pub struct HostStatus {
    phase: String,
    message: String,
    logs: VecDeque<String>,
}

enum Control {
    Retry,
    Shutdown,
}

pub struct HostManager {
    snapshot: Arc<Mutex<HostStatus>>,
    sender: Sender<Control>,
    exit_ready: Arc<AtomicBool>,
}

impl HostManager {
    pub fn new(app: AppHandle, runtime: PathBuf, local_url: Url) -> Self {
        let snapshot = Arc::new(Mutex::new(HostStatus {
            phase: "starting".into(),
            message: "正在检查本机 4897 端口…".into(),
            logs: VecDeque::new(),
        }));
        let exit_ready = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let state = snapshot.clone();
        let finished = exit_ready.clone();
        thread::spawn(move || supervise(app, runtime, local_url, state, finished, receiver));
        let _ = sender.send(Control::Retry);
        Self {
            snapshot,
            sender,
            exit_ready,
        }
    }

    pub fn status(&self) -> HostStatus {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn retry(&self) -> Result<(), String> {
        self.sender
            .send(Control::Retry)
            .map_err(|_| "服务管理器已退出，请重新打开应用".into())
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(Control::Shutdown);
    }

    pub fn exit_ready(&self) -> bool {
        self.exit_ready.load(Ordering::SeqCst)
    }
}

pub fn allowed_navigation(url: &Url) -> bool {
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let pair = url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(4897)
        && url.path() == "/pair/";
    (local || pair) && url.username().is_empty() && url.password().is_none()
}

fn update(state: &Mutex<HostStatus>, phase: &str, message: &str) {
    let mut value = state.lock().unwrap();
    value.phase = phase.into();
    value.message = message.into();
}

fn navigate(app: &AppHandle, url: Url) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("应用窗口已关闭")?
        .navigate(url)
        .map_err(|error| error.to_string())
}

fn failure(app: &AppHandle, local_url: &Url, state: &Mutex<HostStatus>, message: &str) {
    update(state, "error", message);
    let _ = navigate(app, local_url.clone());
}

fn valid_info(info: &Value) -> bool {
    info["hostName"].is_string()
        && info["platform"].is_string()
        && info["authEnabled"].is_boolean()
        && info["addresses"].is_array()
        && info["devices"].is_array()
        && info["agents"].is_array()
}

fn probe(client: &Client) -> Result<(), String> {
    let response = client
        .get(INFO_URL)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("连接接口返回 HTTP {}", response.status()));
    }
    let info: Value = serde_json::from_reader(response.take(256 * 1024))
        .map_err(|_| "4897 端口未返回小梦连接信息")?;
    if !valid_info(&info) {
        return Err("4897 端口上的服务不是兼容的小梦后端".into());
    }
    if info["authEnabled"] != true {
        return Err("当前后端未启用认证，请配置 AUTH_TOKEN 后重启该服务".into());
    }
    Ok(())
}

fn port_occupied() -> bool {
    ["127.0.0.1:4897", "[::1]:4897"].iter().any(|address| {
        TcpStream::connect_timeout(
            &address.parse::<SocketAddr>().unwrap(),
            Duration::from_millis(200),
        )
        .is_ok()
    })
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn collect_logs(
    reader: impl Read + Send + 'static,
    state: Arc<Mutex<HostStatus>>,
    ready: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            // 只接受自己启动的 host 的就绪信号，避免端口抢占时误认其他服务。
            if line == format!("[host] 连接入口 {PAIR_URL}") {
                ready.store(true, Ordering::SeqCst);
            }
            let mut state = state.lock().unwrap();
            state.logs.push_back(line.chars().take(2000).collect());
            while state.logs.len() > 120 {
                state.logs.pop_front();
            }
        }
    });
}

fn launch(
    runtime: &Path,
    state: Arc<Mutex<HostStatus>>,
    ready: Arc<AtomicBool>,
) -> Result<Child, String> {
    let node = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
    let server = runtime.join("server");
    let entry = server.join("dist/scripts/start-host.js");
    if !node.is_file() || !entry.is_file() {
        return Err(
            "缺少后端运行资源。开发环境请运行 npm run prepare:host；安装版请重新安装。".into(),
        );
    }
    let mut paths = vec![runtime.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    let mut command = Command::new(node);
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(entry)
        .current_dir(server)
        .env("PORT", "4897")
        .env("XIAOMENG_DESKTOP_CONTROL", "1")
        .env(
            "PATH",
            std::env::join_paths(paths).map_err(|error| error.to_string())?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = hidden(&mut command)
        .spawn()
        .map_err(|error| format!("无法启动 host：{error}"))?;
    collect_logs(child.stdout.take().unwrap(), state.clone(), ready.clone());
    collect_logs(child.stderr.take().unwrap(), state, ready);
    Ok(child)
}

fn stop(child: &mut Child) {
    // stdin EOF 同时覆盖桌面正常退出和崩溃；超时后只清理自己持有的进程树。
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(b"shutdown\n");
    }
    let deadline = Instant::now() + Duration::from_secs(7);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill.exe");
        command
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = hidden(&mut command).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn supervise(
    app: AppHandle,
    runtime: PathBuf,
    local_url: Url,
    state: Arc<Mutex<HostStatus>>,
    finished: Arc<AtomicBool>,
    receiver: Receiver<Control>,
) {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(900))
        .build()
        .expect("无法初始化本机连接检查");
    let mut child: Option<Child> = None;
    let mut ready_signal = Arc::new(AtomicBool::new(false));
    let mut starting: Option<Instant> = None;
    let mut connected = false;
    let mut checked = Instant::now();
    let mut failures = 0;

    loop {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Control::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                update(&state, "stopping", "正在保存连接状态并关闭本次启动的服务…");
                if let Some(mut owned) = child.take() {
                    stop(&mut owned);
                }
                finished.store(true, Ordering::SeqCst);
                app.exit(0);
                return;
            }
            Ok(Control::Retry) if !connected && starting.is_none() => {
                update(&state, "starting", "正在检查本机 4897 端口…");
                state.lock().unwrap().logs.clear();
                match probe(&client) {
                    Ok(()) => {
                        connected = true;
                        update(
                            &state,
                            "ready",
                            "已连接现有 host 服务；退出应用时会保留该服务。",
                        );
                    }
                    Err(error) if port_occupied() => {
                        failure(
                            &app,
                            &local_url,
                            &state,
                            &format!("4897 端口已被占用：{error}。请检查现有服务后重试。"),
                        );
                    }
                    Err(_) => {
                        ready_signal = Arc::new(AtomicBool::new(false));
                        match launch(&runtime, state.clone(), ready_signal.clone()) {
                            Ok(owned) => {
                                child = Some(owned);
                                starting = Some(Instant::now());
                                update(&state, "starting", "正在启动中心服务与本机 Codex，请稍候…");
                            }
                            Err(error) => failure(&app, &local_url, &state, &error),
                        }
                    }
                }
                if connected {
                    if let Err(error) = navigate(&app, PAIR_URL.parse().unwrap()) {
                        connected = false;
                        failure(&app, &local_url, &state, &error);
                    }
                }
                failures = 0;
                checked = Instant::now();
            }
            _ => {}
        }

        if let Some(owned) = child.as_mut() {
            let exited = match owned.try_wait() {
                Ok(Some(code)) => {
                    Some(format!("host 服务已退出（{code}）。请查看启动日志后重试。"))
                }
                Err(error) => Some(format!("无法读取 host 状态：{error}")),
                Ok(None) => None,
            };
            if let Some(error) = exited {
                if let Some(mut owned) = child.take() {
                    stop(&mut owned);
                }
                starting = None;
                connected = false;
                failure(&app, &local_url, &state, &error);
            }
        }

        if let Some(started) = starting {
            if ready_signal.load(Ordering::SeqCst) && probe(&client).is_ok() {
                starting = None;
                connected = true;
                update(&state, "ready", "host 已启动，退出应用时会自动关闭。");
                if let Err(error) = navigate(&app, PAIR_URL.parse().unwrap()) {
                    if let Some(mut owned) = child.take() {
                        stop(&mut owned);
                    }
                    connected = false;
                    failure(&app, &local_url, &state, &error);
                }
                checked = Instant::now();
            } else if started.elapsed() > Duration::from_secs(30) {
                if let Some(mut owned) = child.take() {
                    stop(&mut owned);
                }
                starting = None;
                failure(
                    &app,
                    &local_url,
                    &state,
                    "host 启动超过 30 秒，已停止本次启动。请查看日志后重试。",
                );
            }
        }

        if connected && checked.elapsed() >= Duration::from_secs(2) {
            checked = Instant::now();
            failures = if probe(&client).is_ok() {
                0
            } else {
                failures + 1
            };
            if failures >= 3 {
                if let Some(mut owned) = child.take() {
                    stop(&mut owned);
                }
                connected = false;
                failure(
                    &app,
                    &local_url,
                    &state,
                    "host 连接已中断。点击重新连接以检查或启动服务。",
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_limited_to_the_launcher_and_pair_page() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            PAIR_URL,
            "http://localhost:4897/pair/#devices",
        ] {
            assert!(allowed_navigation(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "https://example.com/",
            "http://localhost:4898/pair/",
            "http://localhost:4897/api/sessions",
            "http://localhost:4897/pair/evil",
            "http://localhost.evil:4897/pair/",
            "http://user@localhost:4897/pair/",
        ] {
            assert!(!allowed_navigation(&url.parse().unwrap()), "{url}");
        }
    }

    #[test]
    fn unrelated_json_is_not_accepted_as_a_host() {
        assert!(!valid_info(&serde_json::json!({"ok": true})));
        assert!(!valid_info(
            &serde_json::json!({"hostName": "test", "authEnabled": true})
        ));
        assert!(valid_info(
            &serde_json::json!({"hostName": "test", "platform": "win32", "authEnabled": true, "addresses": [], "devices": [], "agents": []})
        ));
    }
}
