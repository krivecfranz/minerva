import { defineTool } from "./types.ts";

// ponytail: regex stripping, swap for Readability if quality suffers.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr|blockquote|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "...[truncated]";
}

export const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetches a URL and returns readable text of the page (HTML stripped or JSON pretty-printed). Use to read web sources and citations.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL to fetch" },
      maxChars: { type: "number", description: "max characters returned (default 8000)" },
    },
    required: ["url"],
  },
  async execute(args, ctx) {
    const url = new URL(String(args.url));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Only http(s) URLs are allowed, got ${url.protocol}`);
    }
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : 8000;

    // ponytail: 15s hard ceiling; ctx.signal only shortens it.
    const signals = [AbortSignal.timeout(15_000), ...(ctx.signal ? [ctx.signal] : [])];
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.any(signals) });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 200)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    let text: string;
    if (contentType.includes("json")) {
      text = JSON.stringify(await res.json(), null, 2);
    } else {
      text = htmlToText(await res.text());
    }
    return { content: truncate(text, maxChars) };
  },
});

export default webFetch;
