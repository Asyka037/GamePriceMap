import type { APIRoute } from 'astro';
import { catalog } from '../lib/data.mjs';

export const GET: APIRoute = () => {
  const docs = catalog().map((g: { slug: string; title: string }, i: number) => ({
    id: i,
    slug: g.slug,
    title: g.title,
  }));
  return new Response(JSON.stringify(docs), {
    headers: { 'Content-Type': 'application/json' },
  });
};
