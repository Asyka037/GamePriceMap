/**
 * Structural-drift guard for metadata refreshes — pure, no I/O.
 *
 * An upstream response can be technically valid yet semantically empty
 * (appdetails success:false yields {}, a page layout change starves the
 * parser). Never replace substantive meta with a hollowed-out record — that
 * is a fetch failure, not an update; the caller keeps the previous file.
 */
export function looksDegraded(previous, next) {
  if (!previous) return false;
  if (previous.headerImage && !next.headerImage) return true;
  if ((previous.genres?.length ?? 0) > 0 && (next.genres?.length ?? 0) === 0) return true;
  if ((previous.reviewCount ?? 0) > 50 && (next.reviewCount ?? 0) === 0) return true;
  return false;
}
