const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('electronAPI', {
  getDownloadState: () => ipcRenderer.invoke('get-download-state'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (data) => ipcRenderer.invoke('update-settings', data),
  startDownload: (data) => ipcRenderer.invoke('start-download', data),
  cancelCurrentDownload: () => ipcRenderer.invoke('cancel-current-download'),
  clearDownloadState: () => ipcRenderer.invoke('clear-download-state'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, value) => callback(value)),
  onDownloadComplete: (callback) => ipcRenderer.on('download-complete', (_event, value) => callback(value)),
  onDownloadFailed: (callback) => ipcRenderer.on('download-failed', (_event, value) => callback(value)),
  onDownloadCancelled: (callback) => ipcRenderer.on('download-cancelled', (_event, value) => callback(value)),
  onDownloadStateChanged: (callback) => ipcRenderer.on('download-state-changed', (_event, value) => callback(value)),
  onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (_event, value) => callback(value))
});

window.addEventListener('DOMContentLoaded', () => {
  for (const dependency of ['chrome', 'node', 'electron']) {
    const element = document.getElementById(`${dependency}-version`);
    if (element) element.innerText = process.versions[dependency];
  }
});
