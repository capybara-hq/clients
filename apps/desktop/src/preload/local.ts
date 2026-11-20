// The local pages' preload (bundled to one CommonJS file): `window.capybaraLocal` and nothing
// else. Never the Shell environment.
import { contextBridge, ipcRenderer } from "electron";
import { bootLocalPreload } from "./local-bridge.ts";

bootLocalPreload({
  ipcRenderer,
  contextBridge,
  location: { protocol: window.location.protocol, host: window.location.host },
  isTopFrame: window.top === window,
});
