import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getStickerRefMap } from '$lib/stores/stickers.svelte';

// Configure marked for chat messages
marked.setOptions({
  breaks: true,  // \n becomes <br>
  gfm: true,     // GitHub flavored markdown
});

// Replace :packname_stickername: with inline sticker images
function renderInlineStickers(text: string): string {
  const map = getStickerRefMap();
  if (map.size === 0) return text;
  return text.replace(/:(\w+)_(\w+):/g, (match) => {
    const url = map.get(match.toLowerCase());
    if (url) {
      return `<img src="${url}" alt="${match}" class="inline-sticker" />`;
    }
    return match;
  });
}

export function renderMarkdown(text: string): string {
  // Render sticker refs before markdown (so they don't get escaped)
  const withStickers = renderInlineStickers(text);
  const html = marked.parse(withStickers, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'div'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel'],
  });
}
