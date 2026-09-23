const $ = (id) => document.getElementById(id);
let current = null;
let creating = false;
let polling = false;
let paired = false;
let revokeId = null;
let connectionIssue = false;

async function request(path, options = {}) {
  const response = await fetch(`/pair${path}`, { ...options, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '暂时无法连接宿主机，请确认后端服务已启动');
  }
  return response.json();
}
function feedback(message = '') {
  $('feedback').textContent = message;
  $('feedback').hidden = !message;
}
function placeholder(symbol, message, success = false) {
  $('qr-image').hidden = true;
  $('qr-placeholder').hidden = false;
  $('qr-placeholder').querySelector('span').textContent = symbol;
  $('qr-placeholder').querySelector('p').textContent = message;
  $('qr-frame').classList.toggle('success', success);
}
function status(message, success = false) {
  $('status-text').textContent = message;
  $('status-dot').classList.toggle('success', success);
}
function devices(items) {
  $('device-count').textContent = items.length;
  const list = $('device-list');
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<span>⌁</span><strong>等待你的第一台设备</strong><p>扫一扫，就能在手机上继续工作。</p>';
    list.append(empty);
  }
  for (const device of items) {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.innerHTML = '<span class="device-icon">▯</span><div class="device-info"><strong></strong><small></small></div><button class="text-button">解除绑定</button>';
    row.querySelector('strong').textContent = device.name;
    row.querySelector('small').textContent = `${device.platform === 'ios' ? 'iOS' : device.platform === 'android' ? 'Android' : '设备'} · ${new Date(device.createdAt).toLocaleDateString('zh-CN')} 已绑定`;
    row.querySelector('button').addEventListener('click', () => {
      revokeId = device.id;
      $('revoke-name').textContent = device.name;
      $('revoke-dialog').showModal();
    });
    list.append(row);
  }
}
async function loadInfo(initial = false) {
  const info = await request('/info');
  devices(info.devices);
  const online = (info.agents || []).filter((agent) => agent.online);
  $('agent-status').textContent = online.length ? `${online.length} 个 Agent 在线` : '宿主机已启动，尚无 Agent 在线';
  $('agent-hint').textContent = online.length ? '绑定后可以在 APP 中查看这些 Agent 的项目与任务。' : '在 server 目录使用 npm run host 同时启动中心服务和 Codex 接入端；仅打开 Codex 桌面不会自动接入。';
  $('agent-names').textContent = online.map((agent) => agent.name).join(' · ');
  if (!initial) return;
  $('top-host').textContent = info.hostName;
  $('host-name').textContent = info.hostName;
  $('host-platform').textContent = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[info.platform] || info.platform;
  $('address').replaceChildren();
  for (const address of info.addresses) {
    const option = document.createElement('option');
    option.value = address.url;
    option.textContent = `${address.url} · ${address.name}`;
    $('address').append(option);
  }
  if (!info.authEnabled || !info.addresses.length) {
    placeholder('⌘', '完成配置后，即可扫码连接');
    status('等待宿主机配置');
    feedback(!info.authEnabled ? '请先设置后端环境变量 AUTH_TOKEN 并重启服务，然后刷新本页。二维码不会包含这个主令牌。' : '未找到可用局域网地址。请连接 Wi-Fi / 以太网，并让后端监听 0.0.0.0（默认配置）。');
    return;
  }
  $('address').disabled = false;
  $('refresh').disabled = false;
  await generate();
}
async function generate() {
  if (creating) return;
  creating = true;
  current = null;
  paired = false;
  $('refresh').disabled = true;
  $('copy').disabled = true;
  $('address').disabled = true;
  $('countdown').textContent = '';
  placeholder('⌘', '正在生成二维码…');
  status('正在准备连接');
  feedback();
  try {
    current = await request('/sessions', { method: 'POST', body: JSON.stringify({ serverUrl: $('address').value }) });
    $('qr-image').src = current.qrDataUrl;
    $('qr-image').hidden = false;
    $('qr-placeholder').hidden = true;
    $('copy').disabled = false;
    status('等待手机扫码');
    tick();
  } catch (error) {
    placeholder('↻', '生成失败，请点击刷新重试');
    status('暂时无法生成二维码');
    feedback(error.message);
  } finally {
    creating = false;
    $('refresh').disabled = false;
    $('address').disabled = false;
  }
}
function expire() {
  current = null;
  $('countdown').textContent = '';
  $('copy').disabled = true;
  placeholder('↻', '二维码已失效，刷新后重新扫码');
  status('请刷新二维码');
}
function tick() {
  if (!current || paired) return;
  const seconds = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
  if (!seconds) return expire();
  $('countdown').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后失效`;
}
async function poll() {
  if (!current || paired || polling || creating) return;
  const session = current;
  polling = true;
  try {
    const result = await request(`/sessions/${session.id}`);
    if (session !== current) return;
    if (result.status === 'expired') return expire();
    if (connectionIssue) { feedback(); connectionIssue = false; }
    if (result.status === 'paired') {
      paired = true;
      $('countdown').textContent = '';
      $('copy').disabled = true;
      placeholder('✓', `${result.deviceName} 已绑定`, true);
      status('绑定成功 · 可以在手机上开始使用', true);
      await loadInfo();
    }
  } catch (error) {
    if (session === current) {
      connectionIssue = true;
      feedback(`${error.message}。正在尝试恢复连接…`);
    }
  } finally { polling = false; }
}
$('refresh').addEventListener('click', generate);
$('address').addEventListener('change', generate);
$('reload-devices').addEventListener('click', () => loadInfo().then(() => feedback()).catch((error) => feedback(error.message)));
$('copy').addEventListener('click', async () => {
  if (!current || paired) return;
  try {
    await navigator.clipboard.writeText(current.payload);
    feedback('绑定链接已复制。在手机扫码页选择「粘贴绑定链接」即可，请在有效期内使用。');
  } catch { feedback('浏览器未允许复制，请直接使用小梦 APP 扫描二维码。'); }
});
$('revoke-dialog').addEventListener('close', async () => {
  if ($('revoke-dialog').returnValue !== 'confirm' || !revokeId) return;
  try {
    await request(`/devices/${revokeId}`, { method: 'DELETE' });
    await loadInfo();
    feedback('已解除绑定，该设备的访问凭据已失效。');
  } catch (error) { feedback(error.message); }
});
setInterval(tick, 1000);
setInterval(poll, 2000);
setInterval(() => loadInfo().catch(() => {
  $('agent-status').textContent = '无法读取 Agent 状态';
  $('agent-hint').textContent = '连接暂时中断，请确认宿主机服务正在运行。';
  $('agent-names').textContent = '';
}), 5000);
loadInfo(true).catch((error) => {
  placeholder('↻', '请确认服务已启动后刷新页面');
  status('暂时无法读取宿主机');
  feedback(error.message);
});
