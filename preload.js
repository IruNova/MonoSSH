const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('mono', {
  platform: process.platform,
  versions: process.versions
});
