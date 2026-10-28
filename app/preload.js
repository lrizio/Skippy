'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skippy', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  setAutostart: on => ipcRenderer.invoke('autostart:set', on),
  checkUpdate: wsUrl => ipcRenderer.invoke('update:check', wsUrl),
  openExternal: url => ipcRenderer.send('open:external', url),
  hideToTray: () => ipcRenderer.send('win:hide'),
  showWindow: () => ipcRenderer.send('win:show'),
  // received files are written to disk by the main process instead of piling up in memory
  fileOpen: id => ipcRenderer.invoke('file:open', id),
  fileWrite: (id, data) => ipcRenderer.send('file:write', id, data),
  fileClose: id => ipcRenderer.invoke('file:close', id),
  fileDiscard: id => ipcRenderer.invoke('file:discard', id),
  fileSave: (id, name) => ipcRenderer.invoke('file:save', id, name),
});
