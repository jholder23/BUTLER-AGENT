const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('butlerElectron', {
  openButlerFloat: () => ipcRenderer.invoke('butler-float-open'),
  closeButlerFloat: () => ipcRenderer.invoke('butler-float-close'),
  hideButlerFloat: () => ipcRenderer.invoke('butler-float-hide'),
  openButlerAgent: () => ipcRenderer.invoke('butler-agent-open'),
  popOutButlerAgent: () => ipcRenderer.invoke('butler-agent-popout'),
  popInButlerAgent: () => ipcRenderer.invoke('butler-agent-popin'),
  openAgentUtility: () => ipcRenderer.invoke('butler-utility-open'),
  closeAgentUtility: () => ipcRenderer.invoke('butler-utility-close'),
  sendAgentUtilitySideMessage: (payload) =>
    ipcRenderer.invoke('butler-utility-side-send', payload),
  onAgentUtilitySideSend: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('butler-utility-side-send', fn);
    return () => ipcRenderer.removeListener('butler-utility-side-send', fn);
  },
  openExternalUrl: (url) => ipcRenderer.invoke('butler-open-external-url', url),
  pickAgentFolder: (defaultPath) => ipcRenderer.invoke('butler-agent-pick-folder', defaultPath),
  openAgentExplorer: (targetPath) => ipcRenderer.invoke('butler-agent-open-explorer', targetPath),
  beginButlerDockFlyFromFloat: () => ipcRenderer.invoke('butler-float-dock-animate'),
  syncButlerFloat: (state) => ipcRenderer.send('butler-float-sync', state),
  onButlerFloatDocked: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('butler-float-docked', fn);
    return () => ipcRenderer.removeListener('butler-float-docked', fn);
  },
  onButlerFloatDockFly: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('butler-float-dock-fly', fn);
    return () => ipcRenderer.removeListener('butler-float-dock-fly', fn);
  },
  onVoiceMicToggle: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('butler-voice-mic-toggle', fn);
    return () => ipcRenderer.removeListener('butler-voice-mic-toggle', fn);
  },
});

contextBridge.exposeInMainWorld('butlerFloat', {
  onState: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('butler-float-state', fn);
    return () => ipcRenderer.removeListener('butler-float-state', fn);
  },
  hide: () => ipcRenderer.send('butler-float-hide-request'),
  toggleMicMute: () => ipcRenderer.send('butler-float-mic-toggle'),
});
