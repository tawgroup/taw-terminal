export type SessionStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'idle'

export type ActivityKind = 'agent' | 'tool' | 'progress' | 'error' | 'system'

export interface SessionProgress {
  current: number
  total: number
  percent: number
  label: string
}

export interface ActivityBlock {
  id: string
  kind: ActivityKind
  title: string
  text: string
}

export interface SessionSnapshot {
  clean: string
  status: SessionStatus
  summary: string
  progress: SessionProgress | null
  activities: ActivityBlock[]
  updatedAt: number
}

const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
const ANSI_CSI = /\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g
const CONTROL = /[\u0000-\u0007\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g
const DECORATIVE_LINE = /^[\s─━═_=-]{5,}$/

const RUNNING_RE = /\b(working|running|thinking|executing|building|testing|pursuing goal|in progress|processing)\b|esc to interrupt/i
const WAITING_RE = /\b(waiting|needs? (?:input|attention)|approval required|confirm|choose|select)\b|\((?:y\/n|yes\/no)\)|type:\s*(?:yes|edit|cancel)/i
const FAILED_RE = /\b(error|failed|failure|exception|fatal|permission denied|access denied|command not found)\b/i
const COMPLETED_RE = /(?:^|\s)(?:✓|✔)\s|\b(done|completed|succeeded|success|build pass(?:ed)?)\b/i
const TOOL_RE = /^(?:[•●]\s*)?(?:ran|read|search(?:ed)?|explored|edited|wrote|write|opened|fetched|called|tool|bash|shell|npm|pnpm|yarn|git)\b|^\$\s+/i
const PROGRESS_RE = /\b(working|running|thinking|executing|building|testing|pursuing goal|in progress|processing|step\s+\d+)\b/i

function terminalText(input: string): string {
  const stripped = input
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    // A PTY normally emits CRLF. Preserve those completed lines; only a lone
    // carriage return means "rewrite the current line" (spinners/progress).
    .replace(/\r\n/g, '\n')
    .replace(CONTROL, '')

  const lines: string[] = ['']
  for (const char of stripped) {
    if (char === '\r') {
      lines[lines.length - 1] = ''
    } else if (char === '\n') {
      lines.push('')
    } else if (char === '\b') {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1)
    } else {
      lines[lines.length - 1] += char
    }
  }

  const compact: string[] = []
  for (const source of lines) {
    const line = source.replace(/[ \t]+$/g, '').replace(/^\s{24,}/, '')
    if (line && line === compact[compact.length - 1]) continue
    compact.push(line)
  }
  return compact.join('\n').replace(/\n{4,}/g, '\n\n\n').trim()
}

function usefulLines(clean: string): string[] {
  return clean
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || DECORATIVE_LINE.test(line)) return false
      if (/^(?:gpt-|claude-|codex\b).*·.*~\//i.test(line)) return false
      if (/^(?:esc|tab|\^c|↑|↓|←|→|⏎)(?:\s|$)/i.test(line)) return false
      return true
    })
}

function detectProgress(lines: string[]): SessionProgress | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const line = lines[i]
    const match = line.match(/\b(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})\b(?:\s*(tasks?|steps?|items?))?/i)
    if (!match) continue
    const current = Number(match[1])
    const total = Number(match[2])
    if (!total || current > total) continue
    const unit = match[3]?.toLowerCase() || 'steps'
    return {
      current,
      total,
      percent: Math.round((current / total) * 100),
      label: `${current}/${total} ${unit}`
    }
  }
  return null
}

function detectStatus(clean: string, kind: string): SessionStatus {
  const lines = usefulLines(clean)
  const last = lines[lines.length - 1] || ''

  // The newest explicit signal wins. Agent transcripts often retain an old
  // error above a later retry, so a fixed priority order would mislabel it.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const line = lines[i]
    if (WAITING_RE.test(line) || /\?\s*$/.test(line)) return 'waiting'
    if (RUNNING_RE.test(line)) return 'running'
    if (FAILED_RE.test(line)) return 'failed'
    if (COMPLETED_RE.test(line)) return 'completed'
  }
  if (/[$%❯>]\s*$/.test(last)) return 'idle'
  return kind === 'shell' ? 'idle' : 'running'
}

function summaryFrom(lines: string[], status: SessionStatus): string {
  const candidates = lines.filter((line) => {
    if (line.length < 3) return false
    if (DECORATIVE_LINE.test(line)) return false
    if (/^(?:working|running|thinking)(?:\s|\()/i.test(line)) return false
    if (/^(?:\[session ended\]|last login:)/i.test(line)) return false
    if (/^(?:[$%❯>]|\w+@\S+[: ])/.test(line) && line.length < 80) return false
    return true
  })
  const fallback: Record<SessionStatus, string> = {
    running: 'Agent is working in the terminal',
    waiting: 'Waiting for your input',
    completed: 'Task completed successfully',
    failed: 'The latest command needs attention',
    idle: 'Ready for a command'
  }
  const value = (candidates[candidates.length - 1] || fallback[status]).replace(/^[•●]\s*/, '')
  return value.length > 150 ? `${value.slice(0, 147)}…` : value
}

function activityKind(text: string): ActivityKind {
  if (FAILED_RE.test(text)) return 'error'
  if (TOOL_RE.test(text)) return 'tool'
  if (PROGRESS_RE.test(text)) return 'progress'
  if (/^(?:last login:|\[session ended\]|connected|reconnecting)/i.test(text)) return 'system'
  return 'agent'
}

function activityTitle(kind: ActivityKind, text: string): string {
  if (kind === 'error') return 'Needs attention'
  if (kind === 'tool') {
    const first = text.split('\n')[0].replace(/^[•●]\s*/, '')
    return first.length > 52 ? `${first.slice(0, 49)}…` : first
  }
  if (kind === 'progress') return 'Agent progress'
  if (kind === 'system') return 'Terminal update'
  return 'Agent update'
}

function activitiesFrom(clean: string): ActivityBlock[] {
  const chunks = clean
    .split(/\n\s*\n|\n(?=[•●]\s+(?:Ran|Read|Search|Explored|Edited|Working))/i)
    .map((chunk) => chunk.split('\n').map((line) => line.trimEnd()).join('\n').trim())
    .filter((chunk) => chunk.length >= 3 && !DECORATIVE_LINE.test(chunk))

  return chunks.slice(-10).map((text, index) => {
    const kind = activityKind(text)
    return {
      id: `${chunks.length - 10 + index}-${text.slice(0, 24)}`,
      kind,
      title: activityTitle(kind, text),
      text: text.length > 1800 ? `${text.slice(0, 1800)}\n…` : text
    }
  })
}

export function buildSessionSnapshot(input: string, kind: string, updatedAt = Date.now()): SessionSnapshot {
  const clean = terminalText(input)
  const lines = usefulLines(clean)
  const status = detectStatus(clean, kind)
  return {
    clean,
    status,
    summary: summaryFrom(lines, status),
    progress: detectProgress(lines),
    activities: activitiesFrom(clean),
    updatedAt
  }
}

export function statusLabel(status: SessionStatus): string {
  return {
    running: 'Running',
    waiting: 'Needs input',
    completed: 'Completed',
    failed: 'Failed',
    idle: 'Idle'
  }[status]
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 10) return 'moments'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function repositoryName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || '~'
}

export function compactPath(path: string): string {
  if (!path) return '~'
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}
