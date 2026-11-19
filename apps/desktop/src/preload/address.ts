// The address page's preload (bundled to one CommonJS file). It exposes only what the page needs:
// the strings, the locale, the prefill, submit(address) and open(). Never the Shell environment.
import { contextBridge, ipcRenderer } from "electron";
import { bootAddressPreload } from "./address-bridge.ts";

bootAddressPreload({
  ipcRenderer,
  contextBridge,
  location: { protocol: window.location.protocol, host: window.location.host },
  isTopFrame: window.top === window,
});
