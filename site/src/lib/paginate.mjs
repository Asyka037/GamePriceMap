/**
 * Static pagination for full-catalog listing pages — pure, no DOM.
 *
 * At 1,200+ games a single hub page approaches 1.4MB of HTML; every listing
 * that grows with the catalog must ship in fixed-size static pages. Page 1
 * stays on the canonical base path; pages 2+ live at `${base}/${n}`.
 */

export const PAGE_SIZE = 100;

export function pageCount(total, size = PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / size));
}

export function pageSlice(items, page, size = PAGE_SIZE) {
  return items.slice((page - 1) * size, page * size);
}

export function pagePath(basePath, page) {
  return page === 1 ? basePath : `${basePath}/${page}`;
}

/** null when everything fits on one page — callers render no pager at all. */
export function pagerModel(basePath, page, total, size = PAGE_SIZE) {
  const count = pageCount(total, size);
  if (count === 1) return null;
  return {
    page,
    count,
    prevHref: page > 1 ? pagePath(basePath, page - 1) : null,
    nextHref: page < count ? pagePath(basePath, page + 1) : null,
    pages: Array.from({ length: count }, (_, i) => ({
      n: i + 1,
      href: pagePath(basePath, i + 1),
      current: i + 1 === page,
    })),
  };
}

/** getStaticPaths helper: page numbers 2..N (page 1 is the base route). */
export function extraPageNumbers(total, size = PAGE_SIZE) {
  return Array.from({ length: pageCount(total, size) - 1 }, (_, i) => i + 2);
}
