import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import type { IndexEntry } from '../lib/search';

export const prerender = true;

function toPlainText(md: string): string {
  return md
    .replace(/```(\w+)?/g, ' ') // code fence markers (keep code words)
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[#>*_~|=-]/g, ' ') // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

export const GET: APIRoute = async () => {
  const base = import.meta.env.BASE_URL;
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const index: IndexEntry[] = posts
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
    .map((post) => {
      const date = post.data.date.toISOString().slice(0, 10);
      const text = [
        post.data.title,
        post.data.description,
        post.data.tags.join(' '),
        toPlainText(post.body ?? ''),
      ]
        .join(' ')
        .toLowerCase();
      return {
        id: post.id,
        url: `${base}posts/${post.id}/`,
        title: post.data.title,
        description: post.data.description,
        tags: post.data.tags,
        date,
        text,
      };
    });

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json' },
  });
};
