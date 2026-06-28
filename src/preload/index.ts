/**
 * Preload - Exposes safe IPC APIs to renderer
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('terminal', {
  create: (id: string, cwd?: string, meta?: { name?: string; kind?: string; workspacePath?: string }) =>
    ipcRenderer.invoke('terminal:create', id, cwd, meta),
  rename: (id: string, name: string) => ipcRenderer.send('terminal:rename', id, name),
  write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
  kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  getCwd: (id: string) => ipcRenderer.invoke('terminal:getCwd', id),
  getShellName: () => ipcRenderer.invoke('terminal:getShellName'),
  onData: (callback: (payload: { id: string; data: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { id: string; data: string }) => callback(payload)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },
  onExit: (callback: (payload: { id: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { id: string }) => callback(payload)
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  }
})

contextBridge.exposeInMainWorld('app', {
  getTheme: () => ipcRenderer.invoke('app:getTheme'),
  getHome: () => ipcRenderer.invoke('app:getHome'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  releasesUrl: () => ipcRenderer.invoke('app:releasesUrl'),
  runUpdate: () => ipcRenderer.invoke('app:runUpdate'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url)
})

contextBridge.exposeInMainWorld('workspace', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  load: () => ipcRenderer.invoke('workspaces:load'),
  save: (paths: string[]) => ipcRenderer.invoke('workspaces:save', paths),
  gitBranch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd)
})

contextBridge.exposeInMainWorld('usage', {
  get: () => ipcRenderer.invoke('usage:get')
})

contextBridge.exposeInMainWorld('limits', {
  get: () => ipcRenderer.invoke('limits:get')
})

contextBridge.exposeInMainWorld('remote', {
  status: () => ipcRenderer.invoke('remote:status'),
  start: (opts?: { tunnel?: boolean }) => ipcRenderer.invoke('remote:start', opts),
  stop: () => ipcRenderer.invoke('remote:stop'),
  checkTunnel: () => ipcRenderer.invoke('remote:checkTunnel'),
  onClients: (callback: (count: number) => void) => {
    const handler = (_: Electron.IpcRendererEvent, count: number) => callback(count)
    ipcRenderer.on('remote:clients', handler)
    return () => ipcRenderer.removeListener('remote:clients', handler)
  }
})
