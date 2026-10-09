/**
 * The Mac app (desktop/) shows this web app in its own window and adds window.ismpDesktop
 * (desktop/src/preload.js). Google won't sign in inside an app window, so there sign-in and Sheets
 * access go through the system browser instead of Google's popups; see google.ts. On a Mac it also
 * sends texts through Messages (components/BulkText.tsx).
 */
type Failure = { ok: false; error: string; reason?: 'cancelled' | 'needs-sign-in' }
type Access = { accessToken: string; expiresAt: number }
type TextingFailure = { ok: false; error: string; reason?: 'not-authorized' | 'no-sms' | 'bad-number' | 'bad-message' | 'unsupported' | 'failed' }

/** One of the Messages app's accounts, as AppleScript reports it. */
export type MessagesAccount = { service: string; enabled: boolean; status: string; id: string; description: string }

export type DesktopBridge = {
  /** Signs in to Google in the system browser: an ID token for our server, plus Sheets access. */
  signIn(domain: string): Promise<({ ok: true; idToken: string } & Access) | Failure>
  /** Sheets access; with `interactive`, signs in again in the browser when it has to. */
  accessToken(interactive: boolean, domain: string): Promise<({ ok: true } & Access) | Failure>
  cancelSignIn(): Promise<unknown>
  signOut(): Promise<unknown>
  /** Messages' accounts, and the SMS one that Text Message Forwarding adds. Not in older app builds. */
  checkTexting?(): Promise<{ ok: true; accounts: MessagesAccount[]; sms: MessagesAccount | null } | TextingFailure>
  /** Texts a phone number through Messages' SMS account, so it's from the forwarding iPhone's number. */
  sendText?(to: string, body: string): Promise<{ ok: true; to: string } | TextingFailure>
}

declare global {
  interface Window {
    ismpDesktop?: DesktopBridge
  }
}

/** Null in a browser. */
export const desktop: DesktopBridge | null = (typeof window !== 'undefined' && window.ismpDesktop) || null
