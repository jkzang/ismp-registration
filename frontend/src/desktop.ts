/**
 * The Mac app (desktop/) shows this web app in its own window and adds window.ismpDesktop
 * (desktop/src/preload.js). Google won't sign in inside an app window, so there sign-in and Sheets
 * access go through the system browser instead of Google's popups; see google.ts.
 */
type Failure = { ok: false; error: string; reason?: 'cancelled' | 'needs-sign-in' }
type Access = { accessToken: string; expiresAt: number }

export type DesktopBridge = {
  /** Signs in to Google in the system browser: an ID token for our server, plus Sheets access. */
  signIn(domain: string): Promise<({ ok: true; idToken: string } & Access) | Failure>
  /** Sheets access; with `interactive`, signs in again in the browser when it has to. */
  accessToken(interactive: boolean, domain: string): Promise<({ ok: true } & Access) | Failure>
  cancelSignIn(): Promise<unknown>
  signOut(): Promise<unknown>
}

declare global {
  interface Window {
    ismpDesktop?: DesktopBridge
  }
}

/** Null in a browser. */
export const desktop: DesktopBridge | null = (typeof window !== 'undefined' && window.ismpDesktop) || null
