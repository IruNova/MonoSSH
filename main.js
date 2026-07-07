const { app, BrowserWindow, dialog, shell, ipcMain, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

let backend = null;
let mainWindow = null;
let backendPort = null;

function backendPath() {
  const names = process.platform === 'win32'
    ? ['ssh-backend.exe', 'ssh-backend']
    : ['ssh-backend'];
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'backend')]
    : [path.join(__dirname, 'bin')];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(roots[0], names[names.length - 1]);
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const bin = backendPath();
    backend = spawn(bin, ['-addr', '127.0.0.1:0'], {
      cwd: path.dirname(bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    const timer = setTimeout(() => reject(new Error('Backend start timeout')), 12000);
    const onLine = (line) => {
      const match = String(line).match(/MONOSSH_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    readline.createInterface({ input: backend.stdout }).on('line', onLine);
    readline.createInterface({ input: backend.stderr }).on('line', line => console.error('[backend]', line));
    backend.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    backend.on('exit', code => {
      console.log('Backend exited', code);
      backend = null;
    });
  });
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: 'MonoSSH',
    backgroundColor: '#050505',
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));
  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { port: String(port) } });
}

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.on('window:minimize', (event) => windowFromEvent(event)?.minimize());
ipcMain.on('window:maximize-toggle', (event) => {
  const win = windowFromEvent(event);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (event) => windowFromEvent(event)?.close());
ipcMain.handle('window:is-maximized', (event) => windowFromEvent(event)?.isMaximized() || false);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    backendPort = await startBackend();
    await createWindow(backendPort);
  } catch (err) {
    dialog.showErrorBox('MonoSSH 启动失败', String(err.stack || err));
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backend && backendPort) {
    createWindow(backendPort);
  }
});

app.on('before-quit', () => {
  if (backend) {
    backend.kill();
    backend = null;
  }
});
