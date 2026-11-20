// Fills an about:blank frame of origin A from the (trusted) top document: the frame's own realm
// then runs the probe.
const frameDocument = document.getElementById("blank").contentDocument;
const early = frameDocument.createElement("script");
early.textContent =
  'window.__doc = "A-frame-blank"; window.__early = { shellType: typeof window.capybaraShell };';
frameDocument.head.append(early);
const probe = frameDocument.createElement("script");
probe.src = "/probe.js";
frameDocument.head.append(probe);
