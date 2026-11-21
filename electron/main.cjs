const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { app, BrowserWindow, Menu, shell } = require('electron')

const PORT = Number(process.env.PORT) || 3000
const BASE_URL = `http://127.0.0.1:${PORT}`

let mainWindow = null
let backendProcess = null

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}/api/v1/health`, { timeout: 1000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function ensureBackendRunning() {
  if (await checkServerReady()) return

  const rootDir = path.resolve(__dirname, '..')
  const isWindows = process.platform === 'win32'
  const cmd = isWindows ? 'npx.cmd' : 'npx'

  backendProcess = spawn(cmd, ['tsx', 'server.ts'], {
    cwd: rootDir,
    shell: false,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: process.env.NODE_ENV || 'production',
    },
    stdio: 'pipe',
  })

  backendProcess.on('error', (err) => {
    console.error('[kathal-desktop] Backend spawn error:', err.message)
  })

  for (let i = 0; i < 40; i += 1) {
    if (await checkServerReady()) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [
          {
            label: 'KATHAL',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const iconPath = path.resolve(__dirname, '..', 'web', 'public', 'pwa-512x512.png')
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0B0F17',
    title: 'KATHAL — Local App & Server Control Panel',
    icon: iconPath,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url)
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BASE_URL)) {
      event.preventDefault()
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          shell.openExternal(url)
        }
      } catch {
        // ignore invalid URLs
      }
    }
  })

  mainWindow.loadURL(BASE_URL)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  buildAppMenu()
  await ensureBackendRunning()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

function cleanupBackend() {
  if (backendProcess && !backendProcess.killed) {
    try {
      backendProcess.kill('SIGTERM')
    } catch {
      // ignore
    }
    backendProcess = null
  }
}

app.on('before-quit', cleanupBackend)
app.on('window-all-closed', () => {
  cleanupBackend()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
