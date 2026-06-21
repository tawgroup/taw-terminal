/**
 * Small inline SVG icons for terminal kinds.
 * Kept as components so they inherit currentColor and scale via `size`.
 */
interface IconProps {
  size?: number
  className?: string
}

/** Terminal / shell — chevron + cursor */
export function TerminalIcon({ size = 14, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8l4 4-4 4" />
      <path d="M12 16h7" />
    </svg>
  )
}

/** Claude — Anthropic-style radiant sunburst */
export function ClaudeIcon({ size = 14, className }: IconProps) {
  // Anthropic-style sunburst: 12 rays alternating long/short, full opacity
  const rays = Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6
    const inner = 2.4
    const outer = i % 2 === 0 ? 9.6 : 6.9
    return (
      <line key={i}
        x1={(12 + Math.cos(a) * inner).toFixed(2)} y1={(12 + Math.sin(a) * inner).toFixed(2)}
        x2={(12 + Math.cos(a) * outer).toFixed(2)} y2={(12 + Math.sin(a) * outer).toFixed(2)}
        stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
      />
    )
  })
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none">
      {rays}
    </svg>
  )
}

/** PI — the π glyph */
export function PiIcon({ size = 14, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7.5h16" />
      <path d="M9 7.5v10" />
      <path d="M16 7.5v8.5a1.5 1.5 0 0 0 3 0" />
    </svg>
  )
}

/** tawx — the ▟▙ twin-block mark from the harness banner */
export function TawxIcon({ size = 14, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M3 20 L11 20 L11 5 Z" />
      <path d="M21 20 L13 20 L13 5 Z" />
    </svg>
  )
}

/** Codex — OpenAI-style six-petal blossom */
export function CodexIcon({ size = 14, className }: IconProps) {
  const petals = Array.from({ length: 6 }, (_, i) => {
    const a = (i * 60 * Math.PI) / 180
    const cx = 12 + Math.cos(a) * 5
    const cy = 12 + Math.sin(a) * 5
    return (
      <ellipse key={i} cx={cx.toFixed(2)} cy={cy.toFixed(2)} rx="4.6" ry="2.1"
        transform={`rotate(${i * 60} ${cx.toFixed(2)} ${cy.toFixed(2)})`}
        fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.9" />
    )
  })
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none">
      {petals}
    </svg>
  )
}
