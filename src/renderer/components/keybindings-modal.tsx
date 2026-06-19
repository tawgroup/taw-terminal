/**
 * Keyboard shortcut manager. Lists configurable bindings and lets the user
 * rebind each by pressing a new combo. Jump (⌘1–9) is shown as fixed info.
 */
import { useState, useEffect } from 'react'
import { Binding, eventToCombo, formatCombo } from '../lib/keybindings'

interface Props {
  bindings: Binding[]
  onChange: (id: string, combo: string) => void
  onReset: () => void
  onClose: () => void
}

export function KeybindingsModal({ bindings, onChange, onReset, onClose }: Props) {
  const [capturingId, setCapturingId] = useState<string | null>(null)

  // While capturing, the next key combo becomes the binding
  useEffect(() => {
    if (!capturingId) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setCapturingId(null); return }
      const combo = eventToCombo(e)
      if (!combo) return // modifier-only, keep waiting
      onChange(capturingId, combo)
      setCapturingId(null)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [capturingId, onChange])

  // Detect duplicate combos to warn the user
  const counts: Record<string, number> = {}
  bindings.forEach(b => { counts[b.combo] = (counts[b.combo] || 0) + 1 })

  return (
    <div className="kb-overlay" onClick={onClose}>
      <div className="kb-modal" onClick={e => e.stopPropagation()}>
        <div className="kb-head">
          <h2>Keyboard Shortcuts</h2>
          <button className="kb-close" onClick={onClose} title="Close (Esc)">×</button>
        </div>

        <div className="kb-list">
          {bindings.map(b => (
            <div className="kb-row" key={b.id}>
              <span className="kb-label">{b.label}</span>
              {counts[b.combo] > 1 && <span className="kb-dup" title="Used by another action">conflict</span>}
              <button
                className={`kb-combo ${capturingId === b.id ? 'capturing' : ''}`}
                onClick={() => setCapturingId(b.id)}
                title="Click, then press the new shortcut"
              >
                {capturingId === b.id ? 'Press keys… (Esc to cancel)' : formatCombo(b.combo)}
              </button>
            </div>
          ))}

          <div className="kb-row fixed">
            <span className="kb-label">Jump to terminal 1–9</span>
            <span className="kb-combo static">⌘1 … ⌘9</span>
          </div>
        </div>

        <div className="kb-foot">
          <span className="kb-hint">Click a shortcut, then press the new key combo.</span>
          <button className="kb-reset" onClick={onReset}>Reset to defaults</button>
        </div>
      </div>
    </div>
  )
}
