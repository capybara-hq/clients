// The hostile probe every test document runs (Task 13, after spike 1.2). It records what this
// document could reach and every attack it attempted, and POSTs the findings to /report; the test
// (HostilePageTests on iOS and Android) compares them with expect.json and the native gate log.
(() => {
  const params = new URLSearchParams(location.search);
  const doc = document.documentElement.dataset.doc || params.get("doc") || window.__doc;
  const android = /Android/.test(navigator.userAgent);
  const isTop = window === window.top;
  const early = window.__early || {};
  const results = {
    selfOrigin: String(self.origin),
    locationOrigin: location.origin,
    isTop,
    hasOpener: Boolean(window.opener),
    // Android with multiple windows off loads a window.open target in the opener's own WebView.
    openerIsSelf: window.opener === window,
    shellEarly: early.shellType,
    shellAtProbe: typeof window.capybaraShell,
    attempts: {},
    replies: {},
  };
  const realShell = window.capybaraShell;
  // Pushes reach a document only as the answer to its own `listen` post (iOS) or on its reply
  // proxy (Android), and native answers only the profile's gated main frame. Android's port
  // listener below flags a stray state or event push; on iOS the `listen` attempt in run() must
  // be rejected, so no push can ever be answered to a hostile document.
  results.strayPush = false;

  // Try to replace the shell object (page scripts always run after the shell script).
  try {
    window.capybaraShell = { fake: true };
  } catch (error) {
    results.assignError = String(error);
  }
  try {
    Object.defineProperty(window, "capybaraShell", { value: { fake: true }, configurable: true });
  } catch (error) {
    results.defineError = String(error);
  }
  results.redefineTook = Boolean(window.capybaraShell?.fake);

  results.capacitorType = typeof window.Capacitor;
  results.bridgeHandlerType = typeof window.webkit?.messageHandlers?.bridge;
  results.androidBridgeType = typeof window.androidBridge;
  results.rawEndpointType = android
    ? typeof window.capybaraShellPort
    : typeof window.webkit?.messageHandlers?.capybaraShell;

  const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
  const androidWaiters = new Map();
  if (android && window.capybaraShellPort) {
    window.capybaraShellPort.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      // A state or event push is for the profile document that said hello, never a hostile one.
      if (!realShell && (message.type === "state" || message.type === "event")) {
        results.strayPush = true;
      }
      const resolve = androidWaiters.get(message.callId);
      if (!resolve) return;
      if (message.type === "denied") resolve("denied");
      else if (message.type === "reply")
        resolve(message.result?.ok ? message.result.value : "failed");
    });
  }

  // A well-formed call posted straight to the native endpoint, bypassing capybaraShell.
  function rawPost(callId, overrides) {
    const body = {
      type: "call",
      docId: "probe-doc-0000",
      callId,
      key: "test@1",
      fn: "ping",
      args: [],
      activation: false,
      ...overrides,
    };
    if (android) {
      const port = window.capybaraShellPort;
      if (!port) return null;
      const reply = new Promise((resolve) => androidWaiters.set(callId, resolve));
      port.postMessage(JSON.stringify(body));
      return reply;
    }
    const handler = window.webkit?.messageHandlers?.capybaraShell;
    if (!handler) return null;
    return handler
      .postMessage(body)
      .then((value) => (value?.ok ? value.value : `resolved:${JSON.stringify(value)}`))
      .catch((error) => `rejected:${error?.message ?? error}`);
  }

  async function attempt(via, start) {
    let pending;
    try {
      pending = start();
    } catch (error) {
      results.attempts[via] = `threw:${error?.name ?? error}`;
      return;
    }
    if (!pending) {
      results.attempts[via] = "no-endpoint";
      return;
    }
    results.attempts[via] = "posted";
    results.replies[via] = await Promise.race([pending, timeout(5000)]);
  }

  async function waitForPush() {
    // The harness pushes insets.bottom = 7 when this document says hello.
    for (let i = 0; i < 50; i++) {
      if (realShell?.insets?.bottom === 7) return 7;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return realShell?.insets?.bottom;
  }

  async function run() {
    if (realShell) {
      await attempt("shell", () => realShell.capabilities["test@1"].ping());
      results.pushedBottom = await waitForPush();
    }
    await attempt("raw", () => rawPost(`${doc}:raw`));
    if (!realShell) {
      // A raw `listen` for the profile document's id: native must reject it, so it never receives
      // the pushes queued for the profile document.
      await attempt("listen", () => rawPost(`${doc}:listen`, { type: "listen" }));
    }
    if (isTop && realShell) {
      // A malformed post (a bad document id) from the trusted document: native drops the shape.
      await attempt("malformed", () => rawPost(`${doc}:malformed`, { docId: "x" }));
    }
    if (!isTop) {
      // A frame defines its own capybaraShell that forwards to the native endpoint.
      window.capybaraShell = { ping: () => rawPost(`${doc}:fake`) };
      await attempt("fake", () => window.capybaraShell.ping());
      // Spec §15.3: a same-origin unsandboxed frame shares the top document's trust and can call
      // its shell (the call is posted from the top frame, so native accepts it); any other frame
      // is blocked by the same-origin policy.
      let topShell;
      try {
        topShell = window.top.capybaraShell;
        results.viaTopType = typeof topShell;
      } catch (error) {
        results.viaTopType = `blocked:${error?.name ?? error}`;
      }
      if (topShell) await attempt("viaTop", () => topShell.capabilities["test@1"].ping());
    }
    if (window.__extraProbe) await window.__extraProbe(results);
    // about:srcdoc and about:blank frames have no URL origin of their own: report via the base.
    await fetch(new URL("/report", document.baseURI).href, {
      method: "POST",
      body: JSON.stringify({ doc, ua: navigator.userAgent, results }),
    }).catch(() => {});
    if (isTop) window.__afterProbe?.();
    else window.parent.postMessage({ gateDone: doc }, "*");
  }
  run();
})();
