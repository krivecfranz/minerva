import { defineTool } from "./types.ts";

// ponytail: keyless scrape of DDG Lite. Fragile by nature. When API keys exist,
// swap in a Brave/Tavily adapter behind the same tool name and delete this.

export function decodeUddg(href: string): string | null {
  const m = href.match(/[?&]uddg=([^&"]+)/);
  if (!m) return null;
  return new URLSearchParams(m[1]).get("uddg") ?? decodeURIComponent(m[1]);
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web via DuckDuckGo Lite (no API key). Returns title, snippet and URL per result.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      numResults: { type: "number", description: "Max results, 1-10 (default 5)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query ?? "");
    // ponytail ceiling: cap 10 — DDG Lite page layout only reliably yields ~10 rows anyway.
    const num = Math.min(10, Math.max(1, Number(args.numResults) || 5));

    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!res.ok) throw new Error(`DDG returned HTTP ${res.status}`);

    const html = await res.text();
    const results: Array<{ url: string; title: string; snippet: string }> = [];

    try {
      // ponytail: regex over HTML instead of a DOM parser — one file, no deps.
      // DDG Lite rows look like <a rel="nofollow" href="...l/?uddg=<enc>">title</a>
      // followed by a <td class="result-snippet"> cell.
      const rowRe =
        /<a[^>]+href="([^"]*(?:\?|&)uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]{0,600}?class="result-snippet"[^>]*>([\s\S]*?)<\/td>)?/g;
      for (const m of html.matchAll(rowRe)) {
        const url = decodeUddg(m[1]);
        if (!url || !url.startsWith("http")) continue;
        if (results.some((r) => r.url === url)) continue;
        const strip = (s: string) =>
          s
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#x27;|&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim();
        results.push({ url, title: strip(m[2] ?? "") || url, snippet: strip(m[3] ?? "") });
        if (results.length >= num) break;
      }
    } catch {
      // fall through to empty-results path
    }

    if (results.length === 0) return { content: "No results found." };

    return {
      content: results
        .map((r) => `- ${r.title}\n  ${r.snippet}\n  ${r.url}`.trimEnd())
        .join("\n"),
    };
  },
});

export default webSearch;
