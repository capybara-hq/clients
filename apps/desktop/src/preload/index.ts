// The deployment window's preload (bundled to one CommonJS file: a sandboxed preload cannot
// require local files). Thin wiring; the logic and its tests are in shell-environment.ts.
import { contextBridge, ipcRenderer } from "electron";
import { bootShellPreload } from "./shell-environment.ts";

bootShellPreload({
  ipcRenderer,
  contextBridge,
  location: { origin: window.location.origin },
  windowOrigin: window.origin,
  isTopFrame: window.top === window,
  userActivation: () => navigator.userActivation?.isActive === true,
});
