/**
 * Remote access modal — start a local server, show a QR a phone can scan to
 * view and control every running terminal session over the network.
 */
import { useState, useEffect, useCallback } from 'react'
import type { RemoteStatus } from '../../preload/index.d'

interface Props {
  onClose: () => void
}

export function RemoteModal({ onClose }: Props) {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [tunnel, setTunnel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [cfCopied, setCfCopied] = useState(false)
  const [cloudflared, setCloudflared] = useState<boolean | null>(null)

  const BREW_CMD = 'brew install cloudflared'

  const refresh = useCallback(() => {
    window.remote.status().then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    window.remote.checkTunnel().then(r => setCloudflared(r.installed)).catch(() => setCloudflared(null))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, refresh])

  const copyBrew = () => {
    navigator.clipboard.writeText(BREW_CMD).then(() => {
      setCfCopied(true); setTimeout(() => setCfCopied(false), 1800)
    }).catch(() => {})
  }

  const start = async () => {
    setBusy(true)
    try { setStatus(await window.remote.start({ tunnel })) } catch { /* ignore */ } finally { setBusy(false) }
  }
  const stop = async () => {
    setBusy(true)
    try { setStatus(await window.remote.stop()) } catch { /* ignore */ } finally { setBusy(false) }
  }
  const copy = () => {
    if (!status?.url) return
    navigator.clipboard.writeText(status.url).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }

  const running = status?.running
  const reach = status?.tunnelUrl ? 'Internet (tunnel)' : status?.lanUrl ? 'Same Wi-Fi only' : '—'

  return (
    <div className="kb-overlay" onClick={onClose}>
      <div className="kb-modal rmt-modal" onClick={e => e.stopPropagation()}>
        <div className="kb-head">
          <h2>Remote access {running ? '· on' : '· off'}</h2>
          <button className="kb-close" onClick={onClose} title="Close (Esc)">×</button>
        </div>

        <div className="rmt-body">
          {!running && (
            <>
              <p className="rmt-lead">
                Scan a QR with your phone to view and control every running terminal session.
                The phone must reach this machine (same Wi-Fi, or via a tunnel for anywhere).
              </p>
              <label className="rmt-opt">
                <input type="checkbox" checked={tunnel} onChange={e => setTunnel(e.target.checked)} />
                <span>
                  Use from anywhere (internet tunnel via <code>cloudflared</code>)
                  {tunnel && cloudflared === true && <span className="rmt-ok"> ✓ installed</span>}
                </span>
              </label>

              {tunnel && cloudflared === false && (
                <div className="rmt-install">
                  <div className="rmt-install-head">⚠ cloudflared isn't installed</div>
                  <p>
                    It's <b>free</b> and needs <b>no account</b> — it gives a temporary public link like
                    {' '}<code>https://….trycloudflare.com</code>. Install it, then start:
                  </p>
                  <div className="rmt-cmd">
                    <code>{BREW_CMD}</code>
                    <button className={`rmt-copy ${cfCopied ? 'done' : ''}`} onClick={copyBrew}>{cfCopied ? '✓' : 'Copy'}</button>
                  </div>
                  <button className="rmt-link" onClick={() => window.app.openExternal('https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/')}>
                    Other install methods ↗
                  </button>
                </div>
              )}

              <button className="rmt-start" disabled={busy} onClick={start}>
                {busy
                  ? 'Starting…'
                  : tunnel && cloudflared === false
                    ? 'Start on Wi-Fi only (no tunnel yet)'
                    : 'Start remote access'}
              </button>
            </>
          )}

          {running && (
            <>
              {status?.qrDataUrl
                ? <img className="rmt-qr" src={status.qrDataUrl} alt="Scan to connect" />
                : <div className="rmt-qr rmt-qr-empty">No reachable address found</div>}

              <div className="rmt-meta">
                <div className="rmt-row"><span className="rmt-k">Reach</span><span>{reach}</span></div>
                {status?.url && (
                  <div className="rmt-row">
                    <span className="rmt-k">URL</span>
                    <code className="rmt-url">{status.url}</code>
                    <button className={`rmt-copy ${copied ? 'done' : ''}`} onClick={copy}>{copied ? '✓' : 'Copy'}</button>
                  </div>
                )}
                {status?.tunnelError && <div className="rmt-warn">⚠ {status.tunnelError}</div>}
                {status?.tunnelError && cloudflared === false && (
                  <div className="rmt-cmd">
                    <code>{BREW_CMD}</code>
                    <button className={`rmt-copy ${cfCopied ? 'done' : ''}`} onClick={copyBrew}>{cfCopied ? '✓' : 'Copy'}</button>
                  </div>
                )}
              </div>

              <button className="rmt-stop" disabled={busy} onClick={stop}>
                {busy ? 'Stopping…' : 'Stop remote access'}
              </button>
            </>
          )}

          <p className="rmt-sec">
            🔒 Anyone with this URL gets full shell control of this machine. The link carries a
            secret token; don't share it, and stop remote access when you're done.
          </p>
        </div>
      </div>
    </div>
  )
}
