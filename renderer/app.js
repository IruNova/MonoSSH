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
  tabs: $('tabs'),
  terminalViews: $('terminalViews'),
  terminalTitle: $('terminalTitle'),
  terminalSubtitle: $('terminalSubtitle'),
  fitTerminalBtn: $('fitTerminalBtn'),
  closeTabBtn: $('closeTabBtn'),
  remotePath: $('remotePath'),
  fileTableBody: $('fileTableBody'),
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
  toast: $('toast')
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

function toast(message, timeout = 2600) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(el.toast._timer);
  el.toast._timer = setTimeout(() => el.toast.classList.add('hidden'), timeout);
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
    el.systemInfo.textContent = '连接后显示远端运行状态';
    return;
  }
  el.systemInfo.textContent = '加载中...';
  const result = await api(`/api/system?id=${encodeURIComponent(tab.connection.id)}`);
  el.systemInfo.textContent = result.output || '暂无数据';
}

function currentConnectionIdForFiles() {
  return activeTab()?.connection.id || state.selectedId;
}

async function loadFiles(p = el.remotePath.value || '/') {
  const id = currentConnectionIdForFiles();
  if (!id) return toast('请先连接或选择 SSH 主机');
  el.fileTableBody.innerHTML = '<tr><td colspan="5" class="muted center">加载中...</td></tr>';
  const result = await api(`/api/fs/list?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`);
  state.currentPath = result.path || p;
  el.remotePath.value = state.currentPath;
  state.selectedFile = null;
  renderFiles(result.entries || []);
}

function renderFiles(entries) {
  if (!entries.length) {
    el.fileTableBody.innerHTML = '<tr><td colspan="5" class="muted center">空目录</td></tr>';
    return;
  }
  el.fileTableBody.innerHTML = '';
  for (const f of entries) {
    const tr = document.createElement('tr');
    tr.className = 'file-row';
    tr.dataset.path = f.path;
    tr.innerHTML = `
      <td><span class="file-name"><span class="file-icon">${f.isDir ? '▣' : '□'}</span>${escapeHtml(f.name)}</span></td>
      <td>${f.isDir ? '-' : formatSize(f.size)}</td>
      <td>${f.isDir ? '文件夹' : fileType(f.name)}</td>
      <td>${formatDate(f.modTime)}</td>
      <td class="muted">${escapeHtml(f.mode)}</td>`;
    tr.addEventListener('click', () => {
      document.querySelectorAll('.file-row').forEach(row => row.classList.remove('selected'));
      tr.classList.add('selected');
      state.selectedFile = f;
    });
    tr.addEventListener('dblclick', () => {
      if (f.isDir) loadFiles(f.path).catch(err => toast(err.message));
      else downloadFile(f);
    });
    el.fileTableBody.appendChild(tr);
  }
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
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  await api(`/api/fs/upload?id=${encodeURIComponent(id)}&path=${encodeURIComponent(state.currentPath)}`, { method: 'POST', body: form });
  toast(`已上传 ${files.length} 个文件`);
  await loadFiles(state.currentPath);
}

function downloadFile(file = state.selectedFile) {
  const id = currentConnectionIdForFiles();
  if (!id || !file) return toast('请选择文件');
  if (file.isDir) return toast('暂不支持下载文件夹');
  const a = document.createElement('a');
  a.href = `${API}/api/fs/download?id=${encodeURIComponent(id)}&path=${encodeURIComponent(file.path)}`;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function mkdir() {
  const id = currentConnectionIdForFiles();
  if (!id) return toast('请先连接或选择 SSH 主机');
  const name = prompt('新文件夹名称');
  if (!name) return;
  await api('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ id, path: state.currentPath, name }) });
  await loadFiles(state.currentPath);
}

async function deleteSelectedFile() {
  const id = currentConnectionIdForFiles();
  const f = state.selectedFile;
  if (!id || !f) return toast('请选择要删除的文件');
  if (!confirm(`确认删除 ${f.path} ?`)) return;
  await api('/api/fs/delete', { method: 'POST', body: JSON.stringify({ id, path: f.path, recursive: f.isDir }) });
  await loadFiles(state.currentPath);
}

async function renameSelectedFile() {
  const id = currentConnectionIdForFiles();
  const f = state.selectedFile;
  if (!id || !f) return toast('请选择要重命名的文件');
  const base = f.path.split('/').slice(0, -1).join('/') || '/';
  const name = prompt('新名称', f.name);
  if (!name || name === f.name) return;
  await api('/api/fs/rename', { method: 'POST', body: JSON.stringify({ id, oldPath: f.path, newPath: `${base}/${name}`.replace(/\/+/g, '/') }) });
  await loadFiles(state.currentPath);
}

function parentPath(p) {
  if (!p || p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function bindEvents() {
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
  el.goPathBtn.addEventListener('click', () => loadFiles(el.remotePath.value).catch(err => toast(err.message)));
  el.remotePath.addEventListener('keydown', e => { if (e.key === 'Enter') loadFiles(el.remotePath.value).catch(err => toast(err.message)); });
  el.homeBtn.addEventListener('click', () => loadFiles('/').catch(err => toast(err.message)));
  el.upBtn.addEventListener('click', () => loadFiles(parentPath(state.currentPath)).catch(err => toast(err.message)));
  document.querySelectorAll('.file-tree button[data-path]').forEach(btn => btn.addEventListener('click', () => loadFiles(btn.dataset.path).catch(err => toast(err.message))));
  el.uploadBtn.addEventListener('click', () => el.uploadInput.click());
  el.uploadInput.addEventListener('change', () => uploadFiles(el.uploadInput.files).catch(err => toast(err.message)).finally(() => { el.uploadInput.value = ''; }));
  el.newFolderBtn.addEventListener('click', () => mkdir().catch(err => toast(err.message)));
  el.downloadBtn.addEventListener('click', () => downloadFile());
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
