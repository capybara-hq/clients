// Enforcement in the window (spec §6.5): the profile's partition can never sign in inside the
// window, even when a web version still shows the form. Sign-in goes through the system browser.
//
// Electron keeps only ONE `onBeforeRequest` listener per session (a second call replaces the
// first), so any later request filter on a profile partition must be composed into this listener
// instead of registering its own.

import { isInWindowSignIn } from "@capybara-hq/shell";

export interface BeforeRequestDetails {
  url: string;
  method: string;
}

export interface WebRequestSession {
  webRequest: {
    onBeforeRequest(
      listener: (
        details: BeforeRequestDetails,
        callback: (response: { cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
}

/** Installs the partition's request filter: the two sign-in routes are cancelled, nothing else. */
export function blockInWindowSignIn(session: WebRequestSession, base: string): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isInWindowSignIn(details.method, details.url, base) });
  });
}
