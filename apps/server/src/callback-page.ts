import { createHash } from "node:crypto";

/** What the OAuth callback tab reports: the connected profile, or a safe failure message. */
export type CallbackOutcome =
  | { ok: true; provider: string; profile: string }
  | { ok: false; message: string };

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const logo = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f62fe"/><g fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 16h6M14 16l6-6M14 16l6 6"/></g><g fill="#fff"><circle cx="8" cy="16" r="2.5"/><circle cx="23" cy="9" r="2.5"/><circle cx="23" cy="23" r="2.5"/></g></svg>`;

const icons = {
  ok: `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#42be65"/><path d="M4.8 8.2l2.1 2.1 4.3-4.4" fill="none" stroke="#161616" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  failed: `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#fa4d56"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#161616" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

// Identical for every outcome so one CSP hash covers it.
const script = `document.getElementById("close").addEventListener("click", () => window.close());
if ("autoclose" in document.body.dataset) setTimeout(() => window.close(), 1500);`;

/** CSP for the callback page: the daemon's default `script-src 'self'` would block its inline script. */
export const callbackCsp = `default-src 'self'; script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'; style-src 'unsafe-inline'; frame-ancestors 'none'`;

/**
 * Self-contained page for `/oauth/callback`, styled like the web app so it
 * works even when the UI bundle is not built. On success it closes the tab
 * the app opened; browsers ignore `window.close()` for tabs a script did not open.
 * Serve it with `callbackCsp`.
 */
export function callbackPage(outcome: CallbackOutcome) {
  const title = outcome.ok ? "Connected" : "Not connected";
  const message = outcome.ok
    ? `${escape(outcome.provider)} / ${escape(outcome.profile)} is ready. You can close this window.`
    : escape(outcome.message);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${title} · mcproxy</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    background: #161616; color: #f4f4f4; text-align: center;
    font: 13px/20px "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .logo { width: 36px; height: 36px; display: block; margin: 0 auto; }
  h1 { margin: 12px 0 2px; font-size: 15px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .icon { width: 14px; height: 14px; }
  p { margin: 0; color: #a8a8a8; max-width: 360px; }
  button { margin-top: 14px; height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid #525252;
    background: transparent; color: inherit; font: inherit; font-weight: 500; cursor: pointer; }
  button:hover { background: #353535; }
  button:focus-visible { outline: 2px solid #4589ff; outline-offset: 1px; }
</style>
</head>
<body${outcome.ok ? " data-autoclose" : ""}>
<main>
  ${logo}
  <h1>${outcome.ok ? icons.ok : icons.failed}${title}</h1>
  <p>${message}</p>
  <button type="button" id="close">Close window</button>
</main>
<script>${script}</script>
</body>
</html>`;
}
