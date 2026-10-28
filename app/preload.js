'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skippy', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
});
