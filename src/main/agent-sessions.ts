/**
 * Agent session tracker - binds a terminal to the exact agent session it created.
 *
 * Claude and PI accept a session id up front, so a terminal can resume its own
 * conversation by id. Codex and tawx mint their own id and only reveal it in the
 * transcript they write to disk, so before this every restored Codex terminal ran
 * `codex resume --last` and they all collapsed onto the newest session.
 *
 * Instead we watch the transcript directories. When a terminal spawns an agent, a
 * new transcript file appears; we read the id out of it and hand it back to the
 * renderer, which persists it and later resumes by id.
 *
 * Transcript layouts:
 *   codex  ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl
 *          first line = {"type":"session_meta","payload":{"session_id":..,"cwd":..}}
 *   tawx   ~/.tawx/sessions/<id>.json  → {"id":..,"cwd":..}
 *
 * Resuming appends to the existing transcript rather than starting a new one, so
 * an id stays valid for the life of the conversation.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

export type SessionKind = 'codex' | 'tawx'

const POLL_MS = 1500

const ROOTS: Record<SessionKind, string> = {
  codex: path.join(os.homedir(), '.codex', 'sessions'),
  tawx: path.join(os.homedir(), '.tawx', 'sessions')
}

interface Watcher {
  termId: string
  kind: SessionKind
  cwd: string
  sessionId?: string
  /** Registration order, so the oldest hungry terminal claims first */
  seq: number
}

interface Transcript {
  file: string
  sessionId: string
  cwd: string
  mtimeMs: number
}

let seq = 0
const watchers = new Map<string, Watcher>()
/** Session ids already owned by a terminal — never handed to a second one */
const claimed = new Set<string>()
/** Transcript files already accounted for, so only genuinely new ones are claimed */
const seen = new Set<string>()
const activeTermId = { value: null as string | null }

let timer: ReturnType<typeof setInterval> | null = null
let onClaim: ((termId: string, sessionId: string) => void) | null = null

const norm = (p: string) => path.resolve(p).replace(/\/+$/, '')

/** Every transcript file under a kind's root, newest first. */
function listTranscripts(kind: SessionKind): Transcript[] {
  const root = ROOTS[kind]
  const out: Transcript[] = []

  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      // codex nests by <year>/<month>/<day>; tawx is flat
      if (e.isDirectory()) {
        if (depth < 3) walk(full, depth + 1)
        continue
      }
      const parsed = kind === 'codex' ? readCodex(full) : readTawx(full)
      if (parsed) out.push(parsed)
    }
  }

  walk(root, 0)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function readCodex(file: string): Transcript | null {
  if (!file.endsWith('.jsonl') || !path.basename(file).startsWith('rollout-')) return null
  try {
    const fd = fs.openSync(file, 'r')
    // The session_meta header is the first line; reading a chunk beats loading
    // a transcript that can grow to megabytes.
    const buf = Buffer.alloc(8192)
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const line = buf.subarray(0, bytes).toString('utf8').split('\n')[0]
    const meta = JSON.parse(line)
    const p = meta?.payload
    const sessionId = p?.session_id || p?.id
    if (!sessionId || !p?.cwd) return null
    return { file, sessionId, cwd: p.cwd, mtimeMs: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

function readTawx(file: string): Transcript | null {
  if (!file.endsWith('.json')) return null
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!s?.id || !s?.cwd) return null
    return { file, sessionId: s.id, cwd: s.cwd, mtimeMs: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

/**
 * Which terminal does this brand-new transcript belong to?
 * The focused terminal wins — it is the one that just spawned the agent, and it is
 * also the one the user would have typed `/new` into. Otherwise the longest-waiting
 * terminal without a session takes it.
 */
function pickWatcher(t: Transcript, kind: SessionKind): Watcher | null {
  const cwd = norm(t.cwd)
  const candidates = [...watchers.values()]
    .filter(w => w.kind === kind && (norm(w.cwd) === cwd || cwd.startsWith(norm(w.cwd) + path.sep)))
    .sort((a, b) => a.seq - b.seq)
  if (!candidates.length) return null

  const active = candidates.find(w => w.termId === activeTermId.value)
  if (active) return active
  return candidates.find(w => !w.sessionId) ?? null
}

function scan() {
  if (!watchers.size) return
  for (const kind of ['codex', 'tawx'] as SessionKind[]) {
    if (![...watchers.values()].some(w => w.kind === kind)) continue
    for (const t of listTranscripts(kind)) {
      if (seen.has(t.file)) continue
      seen.add(t.file)
      if (claimed.has(t.sessionId)) continue
      const w = pickWatcher(t, kind)
      if (!w) continue
      w.sessionId = t.sessionId
      claimed.add(t.sessionId)
      onClaim?.(w.termId, t.sessionId)
    }
  }
}

export const agentSessions = {
  /**
   * Seed `seen` with everything already on disk so a pre-existing session is never
   * mistaken for one a terminal just started.
   */
  init(emit: (termId: string, sessionId: string) => void) {
    onClaim = emit
    for (const kind of ['codex', 'tawx'] as SessionKind[]) {
      for (const t of listTranscripts(kind)) seen.add(t.file)
    }
    timer ??= setInterval(scan, POLL_MS)
  },

  /** A terminal that just spawned an agent and is waiting for its session id. */
  watch(termId: string, kind: SessionKind, cwd: string) {
    const existing = watchers.get(termId)
    watchers.set(termId, { termId, kind, cwd, seq: existing?.seq ?? ++seq, sessionId: existing?.sessionId })
  },

  /** A restored terminal that already knows its session id. */
  claim(termId: string, kind: SessionKind, cwd: string, sessionId: string) {
    watchers.set(termId, { termId, kind, cwd, sessionId, seq: ++seq })
    claimed.add(sessionId)
  },

  /**
   * Migration for terminals saved before session ids were tracked: hand each one a
   * distinct session — newest transcript to the first terminal, next to the second —
   * instead of pointing them all at `--last`. Returns termId → sessionId; a terminal
   * with no transcript left to give is simply absent.
   */
  adopt(reqs: { termId: string; kind: SessionKind; cwd: string }[]): Record<string, string> {
    const out: Record<string, string> = {}
    const byKind = new Map<SessionKind, Transcript[]>()
    for (const r of reqs) {
      if (!byKind.has(r.kind)) byKind.set(r.kind, listTranscripts(r.kind))
      const cwd = norm(r.cwd)
      const pool = byKind.get(r.kind)!
      const hit = pool.find(t => !claimed.has(t.sessionId) && norm(t.cwd) === cwd)
      if (!hit) continue
      out[r.termId] = hit.sessionId
      agentSessions.claim(r.termId, r.kind, r.cwd, hit.sessionId)
    }
    return out
  },

  setActive(termId: string | null) {
    activeTermId.value = termId
  },

  unwatch(termId: string) {
    watchers.delete(termId)
  }
}
