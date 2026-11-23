const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('console2', {
  listRuns: () => ipcRenderer.invoke('runs:list'),
  getRun: (id) => ipcRenderer.invoke('run:get', id),
  stopAgent: (run, name) => ipcRenderer.invoke('agent:stop', { run, name }),
  markAgentDone: (run, name) => ipcRenderer.invoke('agent:mark-done', { run, name }),
  replyAgent: (run, name, text) => ipcRenderer.invoke('agent:reply', { run, name, text }),
  openAgent: (run, name, terminal) => ipcRenderer.invoke('agent:open', { run, name, terminal }),
  openLink: (run, name) => ipcRenderer.invoke('agent:link', { run, name }),
  onSound: (cb) => ipcRenderer.on('sound', (_e, name) => cb(name)),
  diagnose: (run, name) => ipcRenderer.invoke('agent:diagnose', { run, name }),
  getLayout: () => ipcRenderer.invoke('layout:get'),
  setLayout: (layout) => ipcRenderer.invoke('layout:set', layout),
  trashRuns: (ids) => ipcRenderer.invoke('runs:trash', ids),
  killStuck: (run, name) => ipcRenderer.invoke('agent:kill-stuck', { run, name }),
  restart: (run, name) => ipcRenderer.invoke('agent:restart', { run, name }),
});
