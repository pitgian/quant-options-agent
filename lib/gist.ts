/**
 * Gist configuration helpers.
 *
 * Reads VITE_GIST_USER / VITE_GIST_ID from the environment and derives the
 * raw gist URL for a given filename. Defensively normalises the gist ID so
 * that accidentally pasting the full gist URL
 * (e.g. `https://gist.github.com/user/abc123`) into VITE_GIST_ID does not
 * produce a malformed fetch URL — it happened once on Vercel and took down
 * the whole data pipeline (the gist 404'd and the fallback had to kick in
 * for every single request).
 */

/** Extract the gist ID from either a bare ID or a full gist URL. */
function normalizeGistId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // A bare gist ID is a hex string (typically 32-40 chars). If it already
  // looks like one, return as-is.
  if (/^[a-f0-9]{20,}$/i.test(trimmed)) return trimmed;
  // Otherwise try to pull the trailing path segment off a gist URL.
  const match = trimmed.match(/gist\.github\.com\/[^/]+\/([a-f0-9]{20,})/i);
  if (match) return match[1];
  // Last resort: take whatever is after the last '/'.
  if (trimmed.includes('/')) return trimmed.split('/').filter(Boolean).pop();
  return trimmed;
}

const GIST_USER = import.meta.env.VITE_GIST_USER as string | undefined;
const GIST_ID = normalizeGistId(import.meta.env.VITE_GIST_ID as string | undefined);

export const HAS_GIST_CONFIG = Boolean(GIST_USER && GIST_ID);

/**
 * Build the raw gist URL for a given filename, or null if the gist env vars
 * are not configured. The URL is cache-busted by the caller via ?t=.
 */
export function gistRawUrl(filename: string): string | null {
  if (!GIST_USER || !GIST_ID) return null;
  return `https://gist.githubusercontent.com/${GIST_USER}/${GIST_ID}/raw/${filename}`;
}
