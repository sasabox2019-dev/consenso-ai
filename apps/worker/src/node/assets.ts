/**
 * Minimal static-assets server with SPA fallback, mirroring the Cloudflare
 * Workers "assets" binding behavior for local development.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

export function createAssetsHandler(rootDir: string) {
  const root = resolve(rootDir);
  return (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(root, safePath);
    if (!filePath.startsWith(root)) filePath = join(root, "index.html");

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(root, "index.html"); // SPA fallback
    }

    if (!existsSync(filePath)) {
      return Promise.resolve(
        new Response("UI not built. Run: npm run build -w apps/web", { status: 404 }),
      );
    }

    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const stream = createReadStream(filePath);
    return new Promise((res) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: string | Buffer) =>
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
      );
      stream.on("end", () =>
        res(
          new Response(new Uint8Array(Buffer.concat(chunks)), {
            headers: { "content-type": mime },
          }),
        ),
      );
      stream.on("error", () => res(new Response("asset read error", { status: 500 })));
    });
  };
}
