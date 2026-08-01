/** Resolves an incident's publicManifestUrl (see data/api.md §2, publication/handler.py)
 * into a direct link to the published notice, by fetching the day's manifest and matching
 * on alertId -- the same id PublishPreviewModal sends as POST /api/publication's `alertId`.
 * Fetched with a plain same-origin `fetch` (not apiClient's /api envelope): this hits the
 * CloudFront-served public-results bucket directly, proxied to "/public/*" in local dev
 * (see vite.config.ts + VITE_PUBLIC_RESULTS_BASE_URL) since that bucket has no CORS policy.
 */

interface PublicManifest {
  date: string;
  notices: { noticeId: string; alertId: string }[];
}

/** Returns the resolved notice's relative URL, or null if not published (yet). */
export async function resolvePublicNoticeUrl(
  manifestUrl: string,
  alertId: string,
): Promise<string | null> {
  const res = await fetch(manifestUrl);
  if (!res.ok) return null;
  const manifest = (await res.json()) as PublicManifest;
  const entry = manifest.notices?.find((n) => n.alertId === alertId);
  return entry ? `/public/notices/${entry.noticeId}.json` : null;
}
