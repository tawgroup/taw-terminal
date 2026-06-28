/**
 * Remote server — lets a phone (or any browser) drive this app's terminals.
 *
 * It serves the SAME built React renderer over HTTP, and bridges the renderer's
 * `window.*` IPC surface over a WebSocket (see src/renderer/remote-bridge.ts).
 * Access is gated by a random per-run token embedded in the QR URL.
 *
 * Reachability:
 *   - LAN:    http://<lan-ip>:<port>/?token=...   (same Wi-Fi)
 *   - Tunnel: a public https URL via `cloudflared` quick tunnel (use anywhere)
 *
 * SECURITY: this exposes full shell control of this machine to whoever holds the
 * URL+token. It only runs while explicitly started, and stops on app quit.
 */
import http from 'http'
import { createServer as createNetServer } from 'net'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, normalize, extname } from 'path'
import { randomBytes } from 'crypto'
import os from 'os'
import { spawn, ChildProcess } from 'child_process'
import { WebSocketServer, WebSocket } from 'ws'
import QRCode from 'qrcode'
import { terminalRegistry } from './terminal-registry'

// GUI apps launched from Finder/Dock don't inherit the shell's PATH, so a
// Homebrew-installed `cloudflared` (/opt/homebrew/bin on Apple Silicon) is
// invisible to a plain `command -v`. Scan PATH plus the well-known install
// dirs and return the absolute path, or null if it's genuinely not installed.
export function resolveCloudflared(): string | null {
  const isWin = process.platform === 'win32'
  const bin = isWin ? 'cloudflared.exe' : 'cloudflared'
  const sep = isWin ? ';' : ':'
  const extraDirs = isWin ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin']
  const dirs = [...(process.env.PATH || '').split(sep), ...extraDirs]
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, bin)
    try { if (existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

export type RpcTable = Record<string, (...args: any[]) => unknown | Promise<unknown>>

export interface RemoteStatus {
  running: boolean
  port: number | null
  token: string | null
  lanUrl: string | null
  tunnelUrl: string | null
  /** The URL the QR encodes (tunnel if present, else LAN). */
  url: string | null
  qrDataUrl: string | null
  tunnelError?: string | null
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

function lanIp(): string | null {
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer()
    srv.once('error', () => resolve(freePort(start + 1)))
    srv.listen(start, () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

export class RemoteServer {
  private http: http.Server | null = null
  private wss: WebSocketServer | null = null
  private tunnel: ChildProcess | null = null
  private clients = new Set<WebSocket>()
  private token: string | null = null
  private port: number | null = null
  private tunnelUrl: string | null = null
  private tunnelError: string | null = null
  private qrDataUrl: string | null = null
  private unsub: Array<() => void> = []

  constructor(
    private staticDir: string,
    private rpc: RpcTable,
    /**
     * Called whenever a remote (phone) client attaches or detaches, with the
     * current client count. The desktop uses this to re-assert its own terminal
     * size: a phone fits the SHARED pty to its small screen, so when it leaves
     * (or joins) the desktop must re-fit or it stays squeezed at the phone width.
     */
    private onClientsChange?: (count: number) => void
  ) {}

  isRunning(): boolean {
    return this.http != null
  }

  async start(opts: { tunnel?: boolean } = {}): Promise<RemoteStatus> {
    if (this.http) return this.status()

    this.token = randomBytes(24).toString('base64url')
    this.port = await freePort(8790)

    this.http = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ noServer: true })

    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname !== '/ws' || url.searchParams.get('token') !== this.token) {
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onWsConnect(ws))
    })

    await new Promise<void>((resolve) => this.http!.listen(this.port!, '0.0.0.0', resolve))

    // Fan registry events out to every connected client.
    const onData = (p: unknown) => this.broadcast('terminal:data', p)
    const onExit = (p: unknown) => this.broadcast('terminal:exit', p)
    const onMeta = () => this.broadcast('session:meta', terminalRegistry.list())
    terminalRegistry.on('data', onData)
    terminalRegistry.on('exit', onExit)
    terminalRegistry.on('meta', onMeta)
    this.unsub.push(
      () => terminalRegistry.off('data', onData),
      () => terminalRegistry.off('exit', onExit),
      () => terminalRegistry.off('meta', onMeta)
    )

    if (opts.tunnel) await this.startTunnel()
    await this.refreshQr()
    return this.status()
  }

  async stop(): Promise<void> {
    this.unsub.forEach((fn) => fn())
    this.unsub = []
    for (const ws of this.clients) {
      try { ws.close() } catch { /* ignore */ }
    }
    this.clients.clear()
    this.stopTunnel()
    this.wss?.close()
    this.wss = null
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve()
      this.http.close(() => resolve())
    })
    this.http = null
    this.token = null
    this.port = null
    this.qrDataUrl = null
  }

  status(): RemoteStatus {
    const ip = lanIp()
    const lanUrl = this.http && this.token && ip ? `http://${ip}:${this.port}/?token=${this.token}` : null
    const url = this.tunnelUrl
      ? `${this.tunnelUrl}/?token=${this.token}`
      : lanUrl
    return {
      running: this.isRunning(),
      port: this.port,
      token: this.token,
      lanUrl,
      tunnelUrl: this.tunnelUrl ? `${this.tunnelUrl}/?token=${this.token}` : null,
      url,
      qrDataUrl: this.qrDataUrl,
      tunnelError: this.tunnelError
    }
  }

  // --- HTTP static serving (token-gated) ---

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.searchParams.get('token') !== this.token) {
      // The SPA passes the token on first load; assets reuse it via the bridge.
      // Allow same-origin asset requests (no token) only after a valid page load
      // is impractical statelessly, so require the token on every request.
      if (!this.assetAllowed(url.pathname)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('Forbidden — invalid or missing token.')
        return
      }
    }

    let pathname = decodeURIComponent(url.pathname)
    // The phone gets the dedicated mobile client, not the desktop SPA.
    if (pathname === '/' || pathname === '') pathname = '/mobile.html'
    // Prevent path traversal.
    const filePath = normalize(join(this.staticDir, pathname))
    if (!filePath.startsWith(normalize(this.staticDir))) {
      res.writeHead(403); res.end(); return
    }

    let target = filePath
    if (!existsSync(target)) {
      // SPA fallback to the mobile entry.
      target = join(this.staticDir, 'mobile.html')
    }
    try {
      const body = await readFile(target)
      res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('Not found')
    }
  }

  /** Static assets (js/css/fonts/images) are allowed without a token query. */
  private assetAllowed(pathname: string): boolean {
    const ext = extname(pathname)
    return ext !== '' && ext !== '.html'
  }

  // --- WebSocket RPC + event bridge ---

  private onWsConnect(ws: WebSocket): void {
    this.clients.add(ws)
    this.onClientsChange?.(this.clients.size)
    ws.on('close', () => {
      this.clients.delete(ws)
      this.onClientsChange?.(this.clients.size)
    })
    ws.on('message', async (raw) => {
      let msg: { t: string; id?: number; method?: string; args?: unknown[] }
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.t !== 'rpc' || !msg.method) return
      const fn = this.rpc[msg.method]
      if (!fn) {
        ws.send(JSON.stringify({ t: 'rpc', id: msg.id, error: `Unknown method ${msg.method}` }))
        return
      }
      try {
        const result = await fn(...(msg.args || []))
        ws.send(JSON.stringify({ t: 'rpc', id: msg.id, result }))
      } catch (e: any) {
        ws.send(JSON.stringify({ t: 'rpc', id: msg.id, error: e?.message || 'RPC failed' }))
      }
    })
    // Send current session list immediately so the phone can render the layout.
    ws.send(JSON.stringify({ t: 'event', name: 'session:meta', payload: terminalRegistry.list() }))
  }

  private broadcast(name: string, payload: unknown): void {
    const data = JSON.stringify({ t: 'event', name, payload })
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    }
  }

  // --- Tunnel (cloudflared quick tunnel) ---

  private startTunnel(): Promise<void> {
    return new Promise((resolve) => {
      this.tunnelError = null
      const bin = resolveCloudflared()
      if (!bin) {
        this.tunnelError = 'cloudflared not installed. Install it (brew install cloudflared) for off-network access.'
        return resolve()
      }
      let child: ChildProcess
      try {
        child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${this.port}`])
      } catch {
        this.tunnelError = 'cloudflared not installed. Install it (brew install cloudflared) for off-network access.'
        return resolve()
      }
      this.tunnel = child
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      const onLine = (buf: Buffer) => {
        const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
        if (m) { this.tunnelUrl = m[0]; this.refreshQr().finally(finish) }
      }
      child.stdout?.on('data', onLine)
      child.stderr?.on('data', onLine)
      child.on('error', () => {
        this.tunnelError = 'cloudflared not installed. Install it (brew install cloudflared) for off-network access.'
        finish()
      })
      child.on('exit', () => { this.tunnel = null })
      // Don't block startup forever if the tunnel is slow/unavailable.
      setTimeout(() => { if (!this.tunnelUrl && !this.tunnelError) this.tunnelError = 'Tunnel timed out.'; finish() }, 12000)
    })
  }

  private stopTunnel(): void {
    if (this.tunnel) {
      try { this.tunnel.kill() } catch { /* ignore */ }
      this.tunnel = null
    }
    this.tunnelUrl = null
  }

  private async refreshQr(): Promise<void> {
    const status = this.status()
    if (!status.url) { this.qrDataUrl = null; return }
    try {
      this.qrDataUrl = await QRCode.toDataURL(status.url, { margin: 1, width: 320 })
    } catch {
      this.qrDataUrl = null
    }
  }
}
