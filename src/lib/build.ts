/**
 * Which build this page is.
 *
 * `vite.config.ts` computes the commit the bundle came from and the moment it
 * was built, and injects them as `<meta name="hushwing-build-*">` in the page
 * head (see the comment there for why it is not `define`). The marker is in the
 * footer and in the first line of the boot log, which is what makes "am I looking
 * at the deployed revision or a cached tab?" a fact instead of a guess.
 */

function metaContent(name: string): string {
  if (typeof document === 'undefined') return ''
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? ''
}

/** Short commit the running bundle was built from, or `dev` when unknowable. */
export const BUILD_SHA = metaContent('hushwing-build-sha') || 'dev'

/** ISO timestamp of the build; empty when the build could not date itself. */
export const BUILD_TIME = metaContent('hushwing-build-time')

/** One-line marker for the footer and the boot log. */
export const BUILD_MARKER = BUILD_TIME
  ? `${BUILD_SHA} · ${BUILD_TIME.slice(0, 16).replace('T', ' ')}`
  : BUILD_SHA
