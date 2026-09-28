const statusText = document.getElementById('status');
const message = document.getElementById('message');
const indicator = document.getElementById('indicator');
const retry = document.getElementById('retry');
const logs = document.getElementById('logs');
const labels = { starting: '正在启动 host 服务…', ready: '服务已就绪，正在打开连接入口…', error: '暂时无法连接宿主机', stopping: '正在关闭 host 服务…' };

function showError(error) {
  statusText.textContent = labels.error;
  message.textContent = String(error);
  indicator.classList.add('error');
  retry.hidden = false;
}

async function refresh() {
  try {
    const state = await window.__TAURI__.core.invoke('host_status');
    statusText.textContent = labels[state.phase] || labels.starting;
    message.textContent = state.message;
    indicator.classList.toggle('error', state.phase === 'error');
    retry.hidden = state.phase !== 'error';
    logs.textContent = state.logs.join('\n') || '等待服务启动…';
  } catch (error) {
    showError(error);
  }
}

retry.addEventListener('click', async () => {
  retry.disabled = true;
  try {
    await window.__TAURI__.core.invoke('retry_host');
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    retry.disabled = false;
  }
});

async function poll() {
  await refresh();
  setTimeout(poll, 500);
}
void poll();
