/* global Terminal, FitAddon */
const qs = new URLSearchParams(location.search);
const port = qs.get('port') || '0';
const API = `http://127.0.0.1:${port}`;
const WS = `ws://127.0.0.1:${port}`;

const state = {
  connections: [],
  selectedId: null,
  tabs: [],
  activeTabId: null,
  selectedFile: null,
  selectedFiles: new Map(),
  currentPath: '/',
  systemTimer: null
};

const $ = (id) => document.getElementById(id);

const el = {
  connectionList: $('connectionList'),
  connectionCount: $('connectionCount'),
  searchInput: $('searchInput'),
  newConnBtn: $('newConnBtn'),
  importDemoBtn: $('importDemoBtn'),
  connectBtn: $('connectBtn'),
  editConnBtn: $('editConnBtn'),
  deleteConnBtn: $('deleteConnBtn'),
  refreshSystemBtn: $('refreshSystemBtn'),
  systemInfo: $('systemInfo'),
  cpuValue: $('cpuValue'),
  cpuBar: $('cpuBar'),
  memValue: $('memValue'),
  memDetail: $('memDetail'),
  memBar: $('memBar'),
  diskValue: $('diskValue'),
  diskDetail: $('diskDetail'),
  diskBar: $('diskBar'),
  loadValue: $('loadValue'),
  uptimeValue: $('uptimeValue'),
  procList: $('procList'),
  tabs: $('tabs'),
  terminalViews: $('terminalViews'),
  terminalTitle: $('terminalTitle'),
  terminalSubtitle: $('terminalSubtitle'),
  fitTerminalBtn: $('fitTerminalBtn'),
  closeTabBtn: $('closeTabBtn'),
  remotePath: $('remotePath'),
  fileTableBody: $('fileTableBody'),
  selectAllFiles: $('selectAllFiles'),
  refreshFilesBtn: $('refreshFilesBtn'),
  uploadBtn: $('uploadBtn'),
  uploadInput: $('uploadInput'),
  newFolderBtn: $('newFolderBtn'),
  downloadBtn: $('downloadBtn'),
  renameBtn: $('renameBtn'),
  deleteFileBtn: $('deleteFileBtn'),
  homeBtn: $('homeBtn'),
  upBtn: $('upBtn'),
  goPathBtn: $('goPathBtn'),
  dropZone: $('dropZone'),
  modal: $('connectionModal'),
  form: $('connectionForm'),
  modalTitle: $('modalTitle'),
  saveConnectBtn: $('saveConnectBtn'),
  transferPanel: $('transferPanel'),
  transferTitle: $('transferTitle'),
  transferPercent: $('transferPercent'),
  transferBar: $('transferBar'),
  transferDetail: $('transferDetail'),
  toast: $('toast'),
  windowMinimize: $('windowMinimize'),
  windowMaximize: $('windowMaximize'),
  windowClose: $('windowClose')
};

function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return fetch(`${API}${path}`, { ...options, headers }).then(async (res) => {
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        msg = body.error || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.blob();
  });
}

function xhrApi(path, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || 'GET', `${API}${path}`, true);
    xhr.responseType = options.responseType || 'json';
    for (const [key, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(key, value);
    if (options.onDownloadProgress) xhr.onprogress = options.onDownloadProgress;
    if (options.onUploadProgress && xhr.upload) xhr.upload.onprogress = options.onUploadProgress;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ body: xhr.response, xhr });
      } else {
        let msg = `${xhr.status} ${xhr.statusText}`;
        try {
          const body = typeof xhr.response === 'string' ? JSON.parse(xhr.response) : xhr.response;
          msg = body?.error || msg;
        } catch (_) {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.onabort = () => reject(new Error('操作已取消'));
    xhr.send(options.body || null);
  });
}

function toast(message, timeout = 2600) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(el.toast._timer);
  el.toast._timer = setTimeout(() => el.toast.classList.add('hidden'), timeout);
}

function showTransfer(title, detail = '准备中...', percent = 0) {
  updateTransfer(title, detail, percent);
  el.transferPanel.classList.remove('hidden');
}

function updateTransfer(title, detail, percent) {
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  el.transferTitle.textContent = title;
  el.transferPercent.textContent = `${Math.round(value)}%`;
  el.transferBar.style.width = `${value}%`;
  el.transferDetail.textContent = detail;
}

function hideTransfer(delay = 900) {
  clearTimeout(el.transferPanel._timer);
  el.transferPanel._timer = setTimeout(() => el.transferPanel.classList.add('hidden'), delay);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function selectedConnection() {
  return state.connections.find(c => c.id === state.selectedId) || null;
}

function activeTab() {
  return state.tabs.find(t => t.id === state.activeTabId) || null;
}

async function loadConnections() {
  const result = await api('/api/connections');
  state.connections = Array.isArray(result) ? result : [];
  if (!state.selectedId && state.connections.length) state.selectedId = state.connections[0].id;
  if (state.selectedId && !state.connections.some(c => c.id === state.selectedId)) state.selectedId = state.connections[0]?.id || null;
  renderConnections();
  updateHeader();
}

function renderConnections() {
  const query = el.searchInput.value.trim().toLowerCase();
  const list = state.connections.filter(c => {
    const hay = `${c.name} ${c.host} ${c.username} ${c.group}`.toLowerCase();
    return hay.includes(query);
  });
  el.connectionCount.textContent = String(list.length);
  if (!list.length) {
    el.connectionList.className = 'connection-list empty';
    el.connectionList.textContent = state.connections.length ? '没有匹配的连接' : '暂无连接';
    return;
  }
  el.connectionList.className = 'connection-list';
  const groups = new Map();
  for (const c of list) {
    const g = c.group || '默认';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  el.connectionList.innerHTML = '';
  for (const [group, items] of groups) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = group;
    el.connectionList.appendChild(title);
    for (const c of items) {
      const row = document.createElement('div');
      row.className = `conn-item ${c.id === state.selectedId ? 'active' : ''} ${isConnected(c.id) ? 'connected' : ''}`;
      row.dataset.id = c.id;
      row.innerHTML = `
        <span class="status-dot"></span>
        <span class="conn-main"><strong>${escapeHtml(c.name || c.host)}</strong><span>${escapeHtml(c.username)}@${escapeHtml(c.host)}</span></span>
        <span class="conn-port">:${escapeHtml(c.port || 22)}</span>`;
      row.addEventListener('click', () => {
        state.selectedId = c.id;
        renderConnections();
        updateHeader();
      });
      row.addEventListener('dblclick', () => connectSelected());
      el.connectionList.appendChild(row);
    }
  }
}

function isConnected(connectionId) {
  return state.tabs.some(t => t.connection.id === connectionId && t.ws?.readyState === WebSocket.OPEN);
}

function updateHeader() {
  const c = selectedConnection();
  const tab = activeTab();
  el.terminalTitle.textContent = tab ? tab.connection.name : 'Terminal';
  el.terminalSubtitle.textContent = tab
    ? `${tab.connection.username}@${tab.connection.host}:${tab.connection.port || 22}`
    : (c ? `${c.username}@${c.host}:${c.port || 22}` : '请选择一个 SSH 连接');
}

function openModal(conn = null) {
  el.modal.classList.remove('hidden');
  el.form.reset();
  $('connId').value = conn?.id || '';
  $('connName').value = conn?.name || '';
  $('connGroup').value = conn?.group || '默认';
  $('connHost').value = conn?.host || '';
  $('connPort').value = conn?.port || 22;
  $('connUsername').value = conn?.username || 'root';
  $('connPassword').value = conn?.password || '';
  $('connPrivateKey').value = conn?.privateKey || '';
  $('connPassphrase').value = conn?.passphrase || '';
  $('proxyType').value = conn?.proxy?.type || 'none';
  $('proxyHost').value = conn?.proxy?.host || '';
  $('proxyPort').value = conn?.proxy?.port || '';
  $('proxyUsername').value = conn?.proxy?.username || '';
  $('proxyPassword').value = conn?.proxy?.password || '';
  el.modalTitle.textContent = conn ? '编辑连接' : '新建连接';
  setTimeout(() => $('connName').focus(), 60);
}

function closeModal() { el.modal.classList.add('hidden'); }

function formToConnection() {
  const id = $('connId').value.trim();
  const proxyType = $('proxyType').value;
  return {
    id,
    name: $('connName').value.trim() || $('connHost').value.trim(),
    group: $('connGroup').value.trim() || '默认',
    host: $('connHost').value.trim(),
    port: Number($('connPort').value || 22),
    username: $('connUsername').value.trim() || 'root',
    password: $('connPassword').value,
    privateKey: $('connPrivateKey').value.trim(),
    passphrase: $('connPassphrase').value,
    proxy: {
      type: proxyType,
      host: $('proxyHost').value.trim(),
      port: Number($('proxyPort').value || 0),
      username: $('proxyUsername').value.trim(),
      password: $('proxyPassword').value
    }
  };
}

async function saveConnection() {
  const item = formToConnection();
  if (!item.host) throw new Error('请输入主机地址');
  if (item.proxy.type !== 'none' && (!item.proxy.host || !item.proxy.port)) throw new Error('代理已启用，请填写代理主机和端口');
  const path = item.id ? `/api/connections/${encodeURIComponent(item.id)}` : '/api/connections';
  const method = item.id ? 'PUT' : 'POST';
  const saved = await api(path, { method, body: JSON.stringify(item) });
  state.selectedId = saved.id;
  await loadConnections();
  return saved;
}

async function connectSelected() {
  const c = selectedConnection();
  if (!c) return toast('请先选择连接');
  let tab = state.tabs.find(t => t.connection.id === c.id);
  if (tab) {
    activateTab(tab.id);
    return;
  }
  tab = createTerminalTab(c);
  state.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
  connectTab(tab);
}

function createTerminalTab(connection) {
  const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const view = document.createElement('div');
  view.className = 'terminal-view';
  view.dataset.tabId = id;
  el.terminalViews.querySelector('.terminal-placeholder')?.remove();
  el.terminalViews.appendChild(view);

  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.08,
    allowProposedApi: true,
    theme: {
      background: '#000000',
      foreground: '#f4f4f5',
      cursor: '#ffffff',
      selectionBackground: '#3a3a3d',
      black: '#000000', red: '#ff5f57', green: '#ffffff', yellow: '#d6d6d6', blue: '#bbbbbb', magenta: '#eeeeee', cyan: '#cccccc', white: '#ffffff',
      brightBlack: '#666666', brightRed: '#ff8a80', brightGreen: '#ffffff', brightYellow: '#eeeeee', brightBlue: '#dddddd', brightMagenta: '#ffffff', brightCyan: '#eeeeee', brightWhite: '#ffffff'
    }
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(view);
  setTimeout(() => fit.fit(), 0);
  terminal.writeln('\x1b[1mMonoSSH\x1b[0m');
  terminal.writeln('Preparing terminal...');

  terminal.onData(data => {
    const t = state.tabs.find(x => x.id === id);
    if (t?.ws?.readyState === WebSocket.OPEN) t.ws.send(data);
  });
  terminal.onResize(size => {
    const t = state.tabs.find(x => x.id === id);
    if (t?.ws?.readyState === WebSocket.OPEN) {
      t.ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    }
  });

  return { id, connection, terminal, fit, view, ws: null };
}

function connectTab(tab) {
  tab.fit.fit();
  const cols = tab.terminal.cols || 100;
  const rows = tab.terminal.rows || 30;
  const url = `${WS}/ws/terminal?id=${encodeURIComponent(tab.connection.id)}&cols=${cols}&rows=${rows}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  tab.ws = ws;
  ws.onopen = () => {
    tab.terminal.writeln('\r\n\x1b[2mWebSocket connected.\x1b[0m');
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    renderConnections();
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      tab.terminal.write(new Uint8Array(ev.data));
    } else {
      tab.terminal.write(String(ev.data));
    }
  };
  ws.onerror = () => tab.terminal.writeln('\r\n\x1b[31mWebSocket error\x1b[0m');
  ws.onclose = () => {
    tab.terminal.writeln('\r\n\x1b[2mDisconnected.\x1b[0m');
    renderConnections();
  };
}

function renderTabs() {
  el.tabs.innerHTML = '';
  for (const tab of state.tabs) {
    const node = document.createElement('div');
    node.className = `tab ${tab.id === state.activeTabId ? 'active' : ''}`;
    node.dataset.tabId = tab.id;
    node.innerHTML = `<span class="dot"></span><span>${escapeHtml(tab.connection.name || tab.connection.host)}</span><span class="close">×</span>`;
    node.addEventListener('click', (e) => {
      if (e.target.classList.contains('close')) closeTab(tab.id);
      else activateTab(tab.id);
    });
    el.tabs.appendChild(node);
  }
}

function activateTab(id) {
  state.activeTabId = id;
  const tab = activeTab();
  document.querySelectorAll('.terminal-view').forEach(v => v.classList.toggle('active', v.dataset.tabId === id));
  state.selectedId = tab?.connection.id || state.selectedId;
  renderTabs();
  renderConnections();
  updateHeader();
  setTimeout(() => {
    tab?.fit.fit();
    tab?.terminal.focus();
  }, 30);
  if (tab) {
    state.currentPath = el.remotePath.value || '/';
    loadFiles(state.currentPath).catch(err => toast(err.message));
    refreshSystem().catch(() => {});
  }
}

function closeTab(id = state.activeTabId) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const [tab] = state.tabs.splice(idx, 1);
  try { tab.ws?.close(); } catch (_) {}
  try { tab.terminal.dispose(); } catch (_) {}
  tab.view.remove();
  if (state.activeTabId === id) state.activeTabId = state.tabs[idx]?.id || state.tabs[idx - 1]?.id || null;
  if (state.activeTabId) activateTab(state.activeTabId);
  else {
    if (!el.terminalViews.querySelector('.terminal-placeholder')) {
      const ph = document.createElement('div');
      ph.className = 'terminal-placeholder';
      ph.innerHTML = '<h2>极简 SSH 终端</h2><p>左侧选择主机，支持密码/私钥、SOCKS5/HTTP 代理、文件管理。</p>';
      el.terminalViews.appendChild(ph);
    }
    renderTabs();
    updateHeader();
  }
  renderConnections();
}

async function refreshSystem() {
  const tab = activeTab();
  if (!tab) {
    resetSystemDashboard('连接后显示远端运行状态');
    return;
  }
  el.systemInfo.textContent = '刷新中...';
  const result = await api(`/api/system?id=${encodeURIComponent(tab.connection.id)}`);
  renderSystemDashboard(parseSystemOutput(result.output || ''));
}

function resetSystemDashboard(status = '未连接') {
  el.cpuValue.textContent = '--%';
  el.memValue.textContent = '--%';
  el.diskValue.textContent = '--%';
  el.memDetail.textContent = '--';
  el.diskDetail.textContent = '--';
  el.loadValue.textContent = '--';
  el.uptimeValue.textContent = '--';
  el.procList.textContent = status;
  el.systemInfo.textContent = status;
  setMeter(el.cpuBar, 0);
  setMeter(el.memBar, 0);
  setMeter(el.diskBar, 0);
}

function setMeter(node, value) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  node.style.width = `${pct}%`;
}

function parseSystemOutput(output) {
  const data = { processes: [] };
  let inProc = false;
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'PROC') { inProc = true; continue; }
    if (inProc) {
      const [cpu, mem, ...cmd] = line.split(/\t+/);
      if (cpu && mem && cmd.length) data.processes.push({ cpu: Number(cpu), mem: Number(mem), cmd: cmd.join(' ') });
      continue;
    }
    const [key, ...rest] = line.split(/\t+/);
    if (key === 'CPU') data.cpu = Number(rest[0]);
    if (key === 'UPTIME') data.uptime = rest.join(' ').trim();
    if (key === 'LOAD') data.load = rest.filter(Boolean);
    if (key === 'MEM') data.mem = { used: rest[0], total: rest[1], pct: Number(rest[2]) };
    if (key === 'DISK') data.disk = { used: rest[0], total: rest[1], pct: Number(rest[2]) };
  }
  return data;
}

function renderSystemDashboard(data) {
  const cpu = Math.round(Number(data.cpu) || 0);
  const mem = Math.round(Number(data.mem?.pct) || 0);
  const disk = Math.round(Number(data.disk?.pct) || 0);
  el.cpuValue.textContent = `${cpu}%`;
  el.memValue.textContent = `${mem}%`;
  el.diskValue.textContent = `${disk}%`;
  el.memDetail.textContent = data.mem?.used && data.mem?.total ? `${data.mem.used}/${data.mem.total} MB` : '--';
  el.diskDetail.textContent = data.disk?.used && data.disk?.total ? `${data.disk.used}/${data.disk.total}` : '--';
  el.loadValue.textContent = data.load?.length ? data.load.join(' / ') : '--';
  el.uptimeValue.textContent = data.uptime || '--';
  setMeter(el.cpuBar, cpu);
  setMeter(el.memBar, mem);
  setMeter(el.diskBar, disk);
  if (data.processes?.length) {
    el.procList.innerHTML = data.processes.map(p => `
      <div class="proc-row">
        <span>${escapeHtml(p.cmd)}</span>
        <strong>${Number(p.cpu || 0).toFixed(1)}%</strong>
      </div>`).join('');
  } else {
    el.procList.textContent = '暂无进程数据';
  }
  el.systemInfo.textContent = `CPU ${cpu}% · MEM ${mem}% · DISK ${disk}%`;
}

function currentConnectionIdForFiles() {
  return activeTab()?.connection.id || state.selectedId;
}

async function loadFiles(p = el.remotePath.value || '/') {
  const id = currentConnectionIdForFiles();
  if (!id) return toast('请先连接或选择 SSH 主机');
  state.selectedFiles.clear();
  updateFileSelectionUI();
  el.fileTableBody.innerHTML = '<tr><td colspan="6" class="muted center">加载中...</td></tr>';
  updateFileSelectionUI();
  const result = await api(`/api/fs/list?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`);
  state.currentPath = result.path || p;
  el.remotePath.value = state.currentPath;
  state.selectedFile = null;
  renderFiles(result.entries || []);
}

function renderFiles(entries) {
  if (!entries.length) {
    el.fileTableBody.innerHTML = '<tr><td colspan="6" class="muted center">空目录</td></tr>';
    updateFileSelectionUI();
    return;
  }
  el.fileTableBody.innerHTML = '';
  for (const f of entries) {
    const tr = document.createElement('tr');
    tr.className = 'file-row';
    tr.dataset.path = f.path;
    tr.innerHTML = `
      <td class="check-col"><input class="file-check" type="checkbox" aria-label="选择 ${escapeHtml(f.name)}" /></td>
      <td><span class="file-name"><span class="file-icon">${f.isDir ? '▣' : '□'}</span>${escapeHtml(f.name)}</span></td>
      <td>${f.isDir ? '-' : formatSize(f.size)}</td>
      <td>${f.isDir ? '文件夹' : fileType(f.name)}</td>
      <td>${formatDate(f.modTime)}</td>
      <td class="muted">${escapeHtml(f.mode)}</td>`;
    const checkbox = tr.querySelector('.file-check');
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => toggleFileSelection(f, checkbox.checked, tr));
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('file-check')) return;
      document.querySelectorAll('.file-row').forEach(row => row.classList.remove('selected'));
      tr.classList.add('selected');
      state.selectedFile = f;
    });
    tr.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('file-check')) return;
      if (f.isDir) loadFiles(f.path).catch(err => toast(err.message));
      else downloadFile(f).catch(err => toast(err.message));
    });
    el.fileTableBody.appendChild(tr);
  }
  updateFileSelectionUI();
}

function toggleFileSelection(file, checked, row) {
  if (checked) {
    state.selectedFiles.set(file.path, file);
    row.classList.add('checked');
    state.selectedFile = file;
  } else {
    state.selectedFiles.delete(file.path);
    row.classList.remove('checked');
    if (state.selectedFile?.path === file.path) state.selectedFile = Array.from(state.selectedFiles.values()).at(-1) || null;
  }
  updateFileSelectionUI();
}

function updateFileSelectionUI() {
  const checks = Array.from(document.querySelectorAll('.file-check'));
  const checked = checks.filter(x => x.checked).length;
  if (el.selectAllFiles) {
    el.selectAllFiles.checked = checks.length > 0 && checked === checks.length;
    el.selectAllFiles.indeterminate = checked > 0 && checked < checks.length;
  }
  el.deleteFileBtn.textContent = checked ? `删除(${checked})` : '删除';
  el.downloadBtn.disabled = checked > 1;
  el.renameBtn.disabled = checked > 1;
}

function selectedFilesForAction() {
  return Array.from(state.selectedFiles.values());
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function formatDate(v) { return v ? new Date(v).toLocaleString() : '-'; }
function fileType(name) { return (name.includes('.') ? name.split('.').pop().toUpperCase() : '文件'); }

async function uploadFiles(fileList) {
  const id = currentConnectionIdForFiles();
  if (!id) return toast('请先连接或选择 SSH 主机');
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  showTransfer('上传文件', `${files.length} 个文件 · ${formatSize(total)}`, 0);
  try {
    await xhrApi(`/api/fs/upload?id=${encodeURIComponent(id)}&path=${encodeURIComponent(state.currentPath)}`, {
      method: 'POST',
      body: form,
      onUploadProgress: (ev) => {
        const pct = ev.lengthComputable ? ev.loaded * 100 / ev.total : 0;
        updateTransfer('上传文件', `${formatSize(ev.loaded)} / ${ev.lengthComputable ? formatSize(ev.total) : formatSize(total)}`, pct);
      }
    });
    updateTransfer('上传完成', `${files.length} 个文件已上传`, 100);
    toast(`已上传 ${files.length} 个文件`);
    await loadFiles(state.currentPath);
  } finally {
    hideTransfer();
  }
}

async function downloadFile(file = state.selectedFile) {
  const id = currentConnectionIdForFiles();
  if (!id || !file) return toast('请选择文件');
  if (file.isDir) return toast('暂不支持下载文件夹');
  showTransfer('下载文件', file.name, 0);
  try {
    const { body } = await xhrApi(`/api/fs/download?id=${encodeURIComponent(id)}&path=${encodeURIComponent(file.path)}`, {
      responseType: 'blob',
      onDownloadProgress: (ev) => {
        const total = ev.lengthComputable ? ev.total : file.size;
        const pct = total ? ev.loaded * 100 / total : 0;
        updateTransfer('下载文件', `${file.name} · ${formatSize(ev.loaded)} / ${total ? formatSize(total) : '--'}`, pct);
      }
    });
    const url = URL.createObjectURL(body);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    updateTransfer('下载完成', file.name, 100);
    toast(`已下载 ${file.name}`);
  } finally {
    hideTransfer();
  }
}

async function mkdir() {
  const id = currentConnectionIdForFiles();
  if (!id) return toast('请先连接或选择 SSH 主机');
  const name = prompt('新文件夹名称');
  if (!name) return;
  showTransfer('新建文件夹', name, 35);
  try {
    await api('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ id, path: state.currentPath, name }) });
    updateTransfer('新建完成', name, 100);
    toast('文件夹已创建');
  } finally {
    await loadFiles(state.currentPath).catch(err => toast(err.message));
    hideTransfer();
  }
}

async function deleteSelectedFile() {
  const id = currentConnectionIdForFiles();
  const files = selectedFilesForAction();
  const targets = files.length ? files : (state.selectedFile ? [state.selectedFile] : []);
  if (!id || !targets.length) return toast('请选择要删除的文件');
  const names = targets.slice(0, 5).map(f => f.path).join('\n');
  const more = targets.length > 5 ? `\n... 以及另外 ${targets.length - 5} 项` : '';
  if (!confirm(`确认使用 rm -rf 删除 ${targets.length} 项？\n${names}${more}`)) return;
  showTransfer('删除文件', targets.length === 1 ? targets[0].name : `${targets.length} 项`, 45);
  try {
    await api('/api/fs/delete', {
      method: 'POST',
      body: JSON.stringify({ id, paths: targets.map(f => f.path), recursive: true })
    });
    updateTransfer('删除完成', `${targets.length} 项已删除`, 100);
    toast('已删除并刷新文件列表');
  } finally {
    await loadFiles(state.currentPath).catch(err => toast(err.message));
    hideTransfer();
  }
}

async function renameSelectedFile() {
  const id = currentConnectionIdForFiles();
  const f = state.selectedFile;
  if (!id || !f) return toast('请选择要重命名的文件');
  const base = f.path.split('/').slice(0, -1).join('/') || '/';
  const name = prompt('新名称', f.name);
  if (!name || name === f.name) return;
  showTransfer('重命名', `${f.name} → ${name}`, 55);
  try {
    await api('/api/fs/rename', { method: 'POST', body: JSON.stringify({ id, oldPath: f.path, newPath: `${base}/${name}`.replace(/\/+/g, '/') }) });
    updateTransfer('重命名完成', name, 100);
    toast('已重命名并刷新文件列表');
  } finally {
    await loadFiles(state.currentPath).catch(err => toast(err.message));
    hideTransfer();
  }
}

function parentPath(p) {
  if (!p || p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function bindEvents() {
  el.windowMinimize?.addEventListener('click', () => window.mono?.window?.minimize());
  el.windowMaximize?.addEventListener('click', () => window.mono?.window?.maximizeToggle());
  el.windowClose?.addEventListener('click', () => window.mono?.window?.close());
  window.mono?.window?.onMaximized?.((maximized) => {
    el.windowMaximize.textContent = maximized ? '❐' : '□';
    document.body.classList.toggle('is-maximized', maximized);
  });
  window.mono?.window?.isMaximized?.().then(maximized => {
    el.windowMaximize.textContent = maximized ? '❐' : '□';
    document.body.classList.toggle('is-maximized', maximized);
  }).catch(() => {});

  el.newConnBtn.addEventListener('click', () => openModal());
  el.importDemoBtn.addEventListener('click', async () => {
    openModal({ name: '示例服务器', group: '默认', host: '127.0.0.1', port: 22, username: 'root', proxy: { type: 'none' } });
  });
  el.searchInput.addEventListener('input', renderConnections);
  el.connectBtn.addEventListener('click', connectSelected);
  el.editConnBtn.addEventListener('click', () => {
    const c = selectedConnection();
    if (!c) return toast('请选择连接');
    openModal(c);
  });
  el.deleteConnBtn.addEventListener('click', async () => {
    const c = selectedConnection();
    if (!c) return toast('请选择连接');
    if (!confirm(`删除连接 ${c.name}?`)) return;
    await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    state.tabs.filter(t => t.connection.id === c.id).forEach(t => closeTab(t.id));
    state.selectedId = null;
    await loadConnections();
  });
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveConnection();
      closeModal();
      toast('连接已保存');
    } catch (err) { toast(err.message); }
  });
  el.saveConnectBtn.addEventListener('click', async () => {
    try {
      await saveConnection();
      closeModal();
      await connectSelected();
    } catch (err) { toast(err.message); }
  });
  document.querySelectorAll('[data-close-modal]').forEach(x => x.addEventListener('click', closeModal));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  el.fitTerminalBtn.addEventListener('click', () => activeTab()?.fit.fit());
  el.closeTabBtn.addEventListener('click', () => closeTab());
  window.addEventListener('resize', () => activeTab()?.fit.fit());
  el.refreshSystemBtn.addEventListener('click', () => refreshSystem().catch(err => toast(err.message)));

  el.refreshFilesBtn.addEventListener('click', () => loadFiles(state.currentPath).catch(err => toast(err.message)));
  el.selectAllFiles?.addEventListener('change', () => {
    const checked = el.selectAllFiles.checked;
    document.querySelectorAll('.file-check').forEach(input => {
      input.checked = checked;
      input.dispatchEvent(new Event('change'));
    });
  });
  el.goPathBtn.addEventListener('click', () => loadFiles(el.remotePath.value).catch(err => toast(err.message)));
  el.remotePath.addEventListener('keydown', e => { if (e.key === 'Enter') loadFiles(el.remotePath.value).catch(err => toast(err.message)); });
  el.homeBtn.addEventListener('click', () => loadFiles('/').catch(err => toast(err.message)));
  el.upBtn.addEventListener('click', () => loadFiles(parentPath(state.currentPath)).catch(err => toast(err.message)));
  document.querySelectorAll('.file-tree button[data-path]').forEach(btn => btn.addEventListener('click', () => loadFiles(btn.dataset.path).catch(err => toast(err.message))));
  el.uploadBtn.addEventListener('click', () => el.uploadInput.click());
  el.uploadInput.addEventListener('change', () => uploadFiles(el.uploadInput.files).catch(err => toast(err.message)).finally(() => { el.uploadInput.value = ''; }));
  el.newFolderBtn.addEventListener('click', () => mkdir().catch(err => toast(err.message)));
  el.downloadBtn.addEventListener('click', () => downloadFile().catch(err => toast(err.message)));
  el.deleteFileBtn.addEventListener('click', () => deleteSelectedFile().catch(err => toast(err.message)));
  el.renameBtn.addEventListener('click', () => renameSelectedFile().catch(err => toast(err.message)));

  ['dragenter', 'dragover'].forEach(evt => el.dropZone.addEventListener(evt, e => {
    e.preventDefault();
    el.dropZone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(evt => el.dropZone.addEventListener(evt, e => {
    e.preventDefault();
    if (evt === 'drop') uploadFiles(e.dataTransfer.files).catch(err => toast(err.message));
    el.dropZone.classList.remove('dragover');
  }));
}

async function init() {
  bindEvents();
  try {
    await api('/health');
    await loadConnections();
  } catch (err) {
    toast(`后端不可用：${err.message}`, 6000);
  }
  state.systemTimer = setInterval(() => {
    if (activeTab()) refreshSystem().catch(() => {});
  }, 30000);
}

init();
