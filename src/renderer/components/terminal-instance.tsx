/**
 * Single terminal instance - xterm.js with addons
 * Handles image paste, WebGL rendering, web links
 */
import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useTheme } from '../hooks/use-theme'
import '@xterm/xterm/css/xterm.css'

interface Props {
  id: string
  isActive: boolean
  cwd?: string
  /** Metadata surfaced to remote (phone) clients in the session list. */
  name?: string
  kind?: string
  workspacePath?: string
  /** Command auto-run once after the shell is ready (e.g. `claude --resume <id>`) */
  initialCommand?: string
  onImagePaste?: (dataUrl: string) => void
  /** Reports the live agent status of this terminal (running / waiting / idle). */
  onStatus?: (id: string, status: AgentTermStatus) => void
}

/** Coarse agent state derived from what's on screen — see the status effect below. */
export type AgentTermStatus = 'running' | 'waiting' | 'idle'

// A generating agent (Claude Code, Codex, …) keeps an interrupt hint on screen for
// the whole turn; it disappears the moment the turn ends. That single line is the
// most reliable "still working" signal across agents and terminal widths.
const WORKING_RE = /esc(?:ape)? to interrupt|ctrl\+c to (?:stop|interrupt)|interrupt\s*·|■\s*stop/i
// A paused agent asking the user to approve/answer before it can continue.
const WAITING_RE = /\bdo you want\b|\((?:y\/n|yes\/no)\)|approval required|allow this|permission to|❯?\s*1\.\s*yes\b|press enter to continue|waiting for (?:your )?(?:input|approval)/i

/** Serialize the last ~80 rows actually on screen (decoded grid, no ANSI). */
function readScreenText(term: Terminal): string {
  const buf = term.buffer.active
  const bottom = buf.baseY + term.rows
  const start = Math.max(0, bottom - 80)
  const out: string[] = []
  for (let y = start; y < bottom; y++) {
    const line = buf.getLine(y)
    out.push(line ? line.translateToString(true) : '')
  }
  return out.join('\n')
}

export function TerminalInstance({ id, isActive, cwd, name, kind, workspacePath, initialCommand, onImagePaste, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const initializedRef = useRef(false)
  const { xtermTheme } = useTheme()
  const [showScrollDown, setShowScrollDown] = useState(false)

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom()
    terminalRef.current?.focus()
  }, [])

  // Keep the latest isActive readable from stable callbacks below.
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  // Re-fit to THIS window and push the size back to the (shared) PTY. A remote
  // phone client fits the same PTY to its tiny screen; without re-asserting,
  // the desktop stays squeezed at the phone's width — the program reflows to
  // ~40 cols and everything crams into the left half. Only the active terminal
  // is laid out (others are display:none → a fit would compute 0), so guard it.
  const reassertSize = useCallback(() => {
    if (!isActiveRef.current) return
    requestAnimationFrame(() => {
      if (!isActiveRef.current || !fitAddonRef.current || !terminalRef.current) return
      fitAddonRef.current.fit()
      const { cols, rows } = terminalRef.current
      window.terminal.resize(id, cols, rows)
    })
  }, [id])

  // Initialize terminal once
  useEffect(() => {
    if (initializedRef.current || !containerRef.current) return
    initializedRef.current = true

    const container = containerRef.current

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontWeight: '400',
      // Bold at 600 (not the 700 default) and no extra tracking: long agent
      // replies are markdown-bold-heavy, and 700 + spacing made every line
      // shout. A touch more leading keeps dense text readable.
      fontWeightBold: '600',
      lineHeight: 1.35,
      letterSpacing: 0,
      scrollback: 10000,
      allowProposedApi: true,
      // OSC 8 escape-sequence hyperlinks (emitted by Claude Code / modern CLIs)
      // are handled by xterm core, NOT the WebLinksAddon below. Without a
      // linkHandler, core falls back to a confirm() + window.open() that opens
      // the URL inside the Electron renderer ("the terminal's browser"). Route
      // it through the OS default browser instead.
      linkHandler: {
        activate: (_event, uri) => {
          window.app.openExternal(uri)
        }
      },
      theme: xtermTheme
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      window.app.openExternal(uri)
    }))

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    terminal.open(container)

    // Create PTY (metadata lets remote phone clients list this session)
    window.terminal.create(id, cwd, { name, kind, workspacePath })

    // PTY data -> terminal
    const removeDataListener = window.terminal.onData(({ id: dataId, data }) => {
      if (dataId === id) terminal.write(data)
    })

    // Terminal input -> PTY (guard against writing to dead PTY)
    let ptyAlive = true
    const inputDisposable = terminal.onData((data) => {
      if (ptyAlive) window.terminal.write(id, data)
    })

    // Stop writing when PTY exits unexpectedly
    const removeExitListener = window.terminal.onExit(({ id: exitId }) => {
      if (exitId === id) ptyAlive = false
    })

    // Auto-run an initial command (e.g. launch/resume a Claude Code session)
    // once the login shell has had a moment to become ready for input.
    if (initialCommand) {
      setTimeout(() => {
        if (ptyAlive) window.terminal.write(id, initialCommand + '\r')
      }, 700)
    }

    // Track scroll position via DOM scroll event on xterm viewport
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null
    const handleViewportScroll = () => {
      const isAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY
      setShowScrollDown(!isAtBottom && terminal.buffer.active.baseY > 0)
    }
    viewport?.addEventListener('scroll', handleViewportScroll, { passive: true })
    // Also check after new content is written
    const writeDisposable = terminal.onWriteParsed(() => {
      const isAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY
      setShowScrollDown(!isAtBottom && terminal.buffer.active.baseY > 0)
    })

    // Fit and resize
    setTimeout(() => {
      fitAddon.fit()
      const { cols, rows } = terminal
      window.terminal.resize(id, cols, rows)
      if (isActive) terminal.focus()
    }, 150)

    return () => {
      initializedRef.current = false
      removeDataListener()
      removeExitListener()
      inputDisposable.dispose()
      viewport?.removeEventListener('scroll', handleViewportScroll)
      writeDisposable.dispose()
      window.terminal.kill(id)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [id, cwd])

  // Update theme when it changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = xtermTheme
    }
  }, [xtermTheme])

  // Live agent status: poll the on-screen grid so the sidebar knows whether this
  // agent is still working, is waiting on the user, or has finished — even while an
  // idle agent keeps repainting its input cursor (which "recent output" mistook for
  // running). Only agent terminals report; a plain shell keeps the output-based dot.
  useEffect(() => {
    if (!onStatus || !kind || kind === 'shell') return
    let last: AgentTermStatus | null = null
    const tick = () => {
      const term = terminalRef.current
      if (!term) return
      const text = readScreenText(term)
      const next: AgentTermStatus = WORKING_RE.test(text)
        ? 'running'
        : WAITING_RE.test(text)
          ? 'waiting'
          : 'idle'
      if (next !== last) { last = next; onStatus(id, next) }
    }
    const iv = setInterval(tick, 500)
    const warmup = setTimeout(tick, 400)
    return () => { clearInterval(iv); clearTimeout(warmup) }
  }, [id, kind, onStatus])

  // Handle visibility and focus
  useEffect(() => {
    if (isActive && terminalRef.current && fitAddonRef.current) {
      setTimeout(() => {
        fitAddonRef.current!.fit()
        const { cols, rows } = terminalRef.current!
        window.terminal.resize(id, cols, rows)
        terminalRef.current!.focus()
      }, 50)
    }
  }, [isActive, id])

  // Re-assert our size when the desktop window regains focus or a remote phone
  // client attaches/detaches (it shrinks the shared PTY to its screen size).
  useEffect(() => {
    window.addEventListener('focus', reassertSize)
    const offClients = window.remote?.onClients?.(reassertSize)
    return () => {
      window.removeEventListener('focus', reassertSize)
      offClients?.()
    }
  }, [reassertSize])

  // Resize observer
  useEffect(() => {
    if (!containerRef.current || !isActive) return

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit()
          const { cols, rows } = terminalRef.current
          window.terminal.resize(id, cols, rows)
        }
      })
    })

    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [isActive, id])

  // Image paste handler
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue

        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          onImagePaste?.(dataUrl)

          // Also write a placeholder to terminal
          terminalRef.current?.write('\r\n\x1b[36m[Image pasted - see overlay]\x1b[0m\r\n')
        }
        reader.readAsDataURL(blob)
        return
      }
    }
  }, [onImagePaste])

  // Drag and drop image
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files) return

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => {
          onImagePaste?.(reader.result as string)
          terminalRef.current?.write('\r\n\x1b[36m[Image dropped - see overlay]\x1b[0m\r\n')
        }
        reader.readAsDataURL(file)
        return
      }
    }
  }, [onImagePaste])

  return (
    <div style={{ display: isActive ? 'block' : 'none', height: '100%', position: 'relative' }}>
      <div
        ref={containerRef}
        className="terminal-instance"
        style={{ height: '100%' }}
        onClick={() => { terminalRef.current?.focus(); reassertSize() }}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      />
      {showScrollDown && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}
    </div>
  )
}
