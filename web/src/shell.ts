// Which page loads the service worker answers with the cached app shell (DISP-107). Only the app's
// own pages: everything else is a server's page and must reach the network. A sign-in proxy's
// return address (e.g. /oauth2/callback?code=…) answered with the shell never finishes the sign-in.

/** The app's pages (the routes in main.tsx, and /pair). */
const SHELL = /^\/(?:$|(?:activity|projects|costs|settings|assistant|pair)(?:\/|$)|(?:p|items|s|sources|pr|files)\/)/;

/** True when a page load of `url` is the app's own page, to answer with the cached shell. */
export function shellNavigation(url: { pathname: string; searchParams: URLSearchParams }): boolean {
  // an OAuth return (a sign-in proxy that comes back on an app path): the proxy has to see it
  const q = url.searchParams;
  if (q.has('state') && (q.has('code') || q.has('error'))) return false;
  return SHELL.test(url.pathname);
}
