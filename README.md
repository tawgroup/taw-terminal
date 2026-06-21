# TawTerminal

A modern terminal built for developers who work with AI coding agents like **Claude Code** on macOS. Smoother typing, zero input lag, beautiful themes.

> Based on [VibeTerminal](https://github.com/nghiahsgs/VibeTerminal) (MIT), rebranded and maintained by [TAW Group](https://github.com/tawgroup).

## Why Not the Default Terminal?

| | macOS Terminal / iTerm2 | TawTerminal |
|---|---|---|
| **Typing feel** | Can stutter — characters appear late when shell is busy | Instant keystroke rendering via Xterm.js, no "dragging characters" |
| **Rendering** | CPU-based text drawing | GPU-accelerated (WebGL) at 60fps |
| **Architecture** | Single-process — heavy shell output blocks input | Multi-process — UI thread is never blocked by PTY output |
| **Buffering** | Raw stream, can choke on large output | Smart buffering with throttled rendering |
| **Theming** | Limited or requires third-party config | 4 built-in themes, one-click switch |
| **Image handling** | No native support | Paste or drag-drop images directly |
| **Split panes** | iTerm2 only, Terminal.app has none | Built-in split panes with tabs |

### The Core Idea

When running Claude Code, your terminal receives **massive streams of AI-generated output** while you're still typing. Default terminals render everything synchronously — shell output and your keystrokes compete for the same thread, causing the "dragging characters" effect.

TawTerminal separates concerns:

```
You (keystrokes) ─→ Xterm.js ─→ IPC ─→ PTY Manager ─→ Shell (zsh/bash)
                     ↑                       ↓
                  GPU render ←── IPC ←── Buffered output
```

- **Input path**: keystrokes go straight to the renderer — you see them immediately
- **Output path**: shell data is buffered and rendered in batches via `requestAnimationFrame`
- **Result**: typing feels instant even when Claude Code is streaming thousands of lines

## Features

- **Workspace Paths** — pin folders in a left sidebar; click **+** on a folder to spawn a shell rooted right in that directory. Terminals are grouped by folder, with live status dots and git branch. Pinned folders persist across restarts.
- **GPU-accelerated rendering** — WebGL-powered Xterm.js, smooth 60fps output
- **Multi-tab terminals** — `Cmd+T` to create, `Cmd+W` to close
- **Split panes** — `Cmd+D` to split, `Cmd+Shift+D` to toggle direction
- **Image paste** — paste (`Cmd+V`) or drag-drop images directly into terminal
- **Beautiful themes** — Tokyo Night, Catppuccin Mocha, Dracula, Rose Pine
- **Clickable URLs** — web links in terminal output are interactive
- **Custom fonts** — JetBrains Mono, Fira Code, SF Mono
- **Auto-restart** — crashed shell sessions recover automatically (up to 3 retries)
- **Native macOS feel** — hidden title bar with traffic lights, drag region
- **Today's AI usage footer** — reads local Claude Code/Codex logs and shows today's token/cost estimate

## Install (macOS, Apple Silicon)

One line — downloads the latest release, installs into `/Applications`, and launches:

```bash
curl -fsSL https://raw.githubusercontent.com/tawgroup/taw-terminal/main/install.sh | bash
```

Or grab the `.dmg` from [Releases](https://github.com/tawgroup/taw-terminal/releases) and drag it into Applications. The app shows its version and checks for updates in the sidebar footer.

## Coding Agents

TawTerminal launches four coding agents directly from the sidebar or top tab bar (each folder's row has a button per agent, color-coded). The agents are **separate CLIs** you install once — TawTerminal just spawns them in a terminal rooted at the folder. Install whichever you want:

| Agent | Install | First-run login | Shortcut |
|-------|---------|-----------------|----------|
| **Claude Code** | `curl -fsSL https://claude.ai/install.sh \| bash`  _(or `npm i -g @anthropic-ai/claude-code`)_ | run `claude`, sign in with your Anthropic / Claude subscription | `Cmd+Shift+C` |
| **Codex** | `npm i -g @openai/codex` | run `codex`, sign in with your ChatGPT Plus/Pro account | `Cmd+Shift+X` |
| **PI** | `npm i -g @earendil-works/pi-coding-agent`  _(needs Node ≥ 22.19)_ | run `pi`, follow the auth prompt | `Cmd+Shift+P` |
| **tawx** (`tx`) | `npm i -g tawx-harness`  _(or `curl -fsSL https://raw.githubusercontent.com/tawgroup/tawx-harness/main/install.sh \| bash`)_ | run `tawx login` — pick provider: opencode / codex / claude | `Cmd+Shift+A` |

After installing, click the agent's button in the sidebar (or press its shortcut) to start a session in the active folder. Sessions are restored on the next launch (`claude --resume`, `codex resume --last`, `pi --continue`, `tawx resume`).

> **tawx** is TAW Group's own tiny, zero-dependency agent harness — a model, a short loop, and a few local tools. It supports a standing-goal mode (`/goal <objective>`) that keeps working until the objective is judged complete. See [tawx-harness](https://github.com/tawgroup/tawx-harness).

## Quick Start (from source)

```bash
npm install
npm run rebuild   # Build native module (node-pty)
npm run dev       # Start development
```

## Usage Footer

The sidebar footer estimates today's Claude Code and Codex usage from local logs (`~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/...`). It mirrors [`ccusage`](https://github.com/ryoppippi/ccusage):

- **Date grouping** — entries are grouped by **local** calendar date (matching `ccusage daily`'s default), not UTC.
- **De-duplication** — duplicated Claude Code rows are counted once by `message.id + requestId`; rows missing either ID are still counted because they cannot be proven duplicates.
- **Tokens** — total includes input, output, cache-creation, and cache-read tokens. Cache reads typically dominate (often 95%+), so the headline token count is large by nature.
- **Pricing** — fetched live from [LiteLLM's price table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) (the same source `ccusage` uses), cached to `~/.taw-terminal/pricing-cache.json` for 24h with an offline fallback snapshot. This matters: hardcoded prices previously read ~4× high because legacy Opus-4.1 rates were applied to the much cheaper Opus-4.8. Cost is an estimate, not an official bill.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New tab |
| `Cmd+Shift+T` | New terminal in active folder |
| `Cmd+W` | Close tab |
| `Cmd+D` | Split pane |
| `Cmd+Shift+D` | Toggle split direction (horizontal/vertical) |
| `Cmd+B` | Toggle sidebar |
| `Cmd+Shift+C` | New Claude Code session |
| `Cmd+Shift+X` | New Codex session |
| `Cmd+Shift+P` | New PI session |
| `Cmd+Shift+A` | New tawx session |
| `Cmd+1`–`Cmd+9` | Jump to the Nth terminal |

All agent/terminal shortcuts are configurable in the in-app keybindings settings.

## Build from Source

```bash
npm install
npm run rebuild    # Build native module (node-pty)
npm run build      # Production build
npm run dist       # Package for macOS (.dmg)
npm run dist:win   # Package for Windows
npm run dist:linux # Package for Linux
```

### Build with Notarization (macOS)

To build a notarized DMG that opens without Gatekeeper warnings:

```bash
APPLE_ID=your@email.com \
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
APPLE_TEAM_ID=YOUR_TEAM_ID \
npm run dist
```

**Prerequisites:**
- Apple Developer account ($99/year)
- "Developer ID Application" certificate installed in Keychain
- App-Specific Password from [appleid.apple.com](https://appleid.apple.com) (Sign-In and Security > App-Specific Passwords)

## Architecture

```
Electron Main Process          Renderer Process (React)
┌─────────────────────┐       ┌──────────────────────────┐
│  PtyManager         │       │  App                     │
│  ├─ node-pty spawn  │◄─IPC─►│  ├─ SplitContainer       │
│  ├─ shell lifecycle │       │  │  ├─ TerminalTabs       │
│  ├─ resize signals  │       │  │  └─ TerminalInstance   │
│  └─ auto-restart    │       │  │     └─ Xterm.js + WebGL│
│                     │       │  ├─ ThemeProvider          │
│                     │       │  └─ ImageOverlay           │
└─────────────────────┘       └──────────────────────────┘
```

```
src/
├── main/              # Electron main process
│   ├── index.ts       # App entry, window creation, IPC handlers
│   └── pty-manager.ts # Terminal shell management (node-pty)
├── preload/           # Secure IPC bridge
│   ├── index.ts       # contextBridge APIs
│   └── index.d.ts     # Type definitions
└── renderer/          # React frontend
    ├── App.tsx        # Main layout + image overlay
    ├── main.tsx       # Entry point
    ├── components/
    │   ├── terminal-instance.tsx  # Xterm.js wrapper + addons
    │   ├── terminal-tabs.tsx      # Tab bar
    │   ├── split-container.tsx    # Split pane system + shortcuts
    │   └── image-overlay.tsx      # Image preview modal
    ├── hooks/
    │   └── use-theme.tsx          # Theme system (4 themes)
    └── styles/
        └── global.css             # UI styling + custom scrollbar
```

## Tech Stack

- **Electron** — cross-platform desktop shell
- **node-pty** — native PTY management (same library used by VS Code)
- **Xterm.js** — terminal frontend with WebGL addon for GPU rendering
- **React 18** — UI components
- **electron-vite** — fast HMR development
- **TypeScript** — type safety throughout

## Credits

Built on top of [VibeTerminal](https://github.com/nghiahsgs/VibeTerminal) by [@nghiahsgs](https://github.com/nghiahsgs).

## License

MIT
