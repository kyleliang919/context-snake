import fs from "fs/promises";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const PORT = Number(process.env.PORT || 8010);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, "dist");
const TARGETS = {
  "/anthropic": "https://api.anthropic.com",
  "/google": "https://generativelanguage.googleapis.com",
  "/openai": "https://api.openai.com",
};
const PREVIEW_TIMEOUT_MS = 8000;
const PREVIEW_MAX_BYTES = 256 * 1024;
const PREVIEW_USER_AGENT = "ContextSnakePreview/1.0 (+http://localhost:8010)";
const LOCAL_DEV_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
const CONFIGURED_ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean)
);
const STATIC_MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function getAllowedOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return "";
  if (LOCAL_DEV_ORIGINS.has(origin) || CONFIGURED_ALLOWED_ORIGINS.has(origin)) return origin;
  const host = String(req.headers.host || "").trim();
  if (!host) return "";
  if (origin === `http://${host}` || origin === `https://${host}`) return origin;
  return "";
}

function setCors(req, res) {
  const allowedOrigin = getAllowedOrigin(req);
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, x-goog-api-key");
}

function getTransport(url) {
  return url.protocol === "http:" ? http : https;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;|&#47;/g, "/")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value = "") {
  return decodeHtml(String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function extractMetaContent(html, attrName, attrValue) {
  const escapedValue = escapeRegExp(attrValue);
  const patterns = [
    new RegExp(`<meta[^>]+${attrName}\\s*=\\s*["']${escapedValue}["'][^>]+content\\s*=\\s*["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]+${attrName}\\s*=\\s*["']${escapedValue}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripTags(match[1]);
  }
  return "";
}

function extractLinkHref(html, relValue) {
  const escapedValue = escapeRegExp(relValue);
  const patterns = [
    new RegExp(`<link[^>]+rel\\s*=\\s*["'][^"']*${escapedValue}[^"']*["'][^>]+href\\s*=\\s*["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<link[^>]+href\\s*=\\s*["']([^"']+)["'][^>]+rel\\s*=\\s*["'][^"']*${escapedValue}[^"']*["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1].trim());
  }
  return "";
}

function fallbackTitleFromUrl(rawUrl = "") {
  try {
    const parsed = new URL(rawUrl);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) return decodeURIComponent(lastSegment).replace(/[-_]+/g, " ");
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return rawUrl;
  }
}

function collectResponseBody(res, maxBytes = PREVIEW_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on("data", chunk => {
      if (total < maxBytes) {
        const remaining = maxBytes - total;
        chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      }
      total += chunk.length;
    });
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}

async function fetchPreviewMetadata(rawUrl, redirects = 0) {
  if (redirects > 4) throw new Error("Too many redirects");
  const targetUrl = new URL(rawUrl);
  const transport = getTransport(targetUrl);

  const response = await new Promise((resolve, reject) => {
    const req = transport.request(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": PREVIEW_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
      },
    }, resolve);
    req.setTimeout(PREVIEW_TIMEOUT_MS, () => req.destroy(new Error("Preview timeout")));
    req.on("error", reject);
    req.end();
  });

  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    const nextUrl = new URL(response.headers.location, targetUrl).toString();
    response.resume();
    return fetchPreviewMetadata(nextUrl, redirects + 1);
  }

  const contentType = String(response.headers["content-type"] || "").split(";")[0].trim();
  const finalUrl = targetUrl.toString();
  const isHtml = contentType.includes("html") || contentType === "";

  if (!isHtml) {
    response.resume();
    return {
      url: finalUrl,
      canonicalUrl: finalUrl,
      contentType,
      title: fallbackTitleFromUrl(finalUrl),
      description: "",
      image: contentType.startsWith("image/") ? finalUrl : "",
      siteName: "",
    };
  }

  const html = await collectResponseBody(response);
  const title = extractMetaContent(html, "property", "og:title")
    || extractMetaContent(html, "name", "twitter:title")
    || stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "")
    || fallbackTitleFromUrl(finalUrl);
  const description = extractMetaContent(html, "property", "og:description")
    || extractMetaContent(html, "name", "twitter:description")
    || extractMetaContent(html, "name", "description")
    || "";
  const image = extractMetaContent(html, "property", "og:image")
    || extractMetaContent(html, "name", "twitter:image")
    || "";
  const siteName = extractMetaContent(html, "property", "og:site_name")
    || extractMetaContent(html, "name", "application-name")
    || "";
  const canonicalHref = extractLinkHref(html, "canonical");

  return {
    url: finalUrl,
    canonicalUrl: canonicalHref ? new URL(canonicalHref, finalUrl).toString() : finalUrl,
    contentType,
    title,
    description,
    image: image ? new URL(image, finalUrl).toString() : "",
    siteName,
  };
}

function handlePreviewRequest(req, res) {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  const target = requestUrl.searchParams.get("url");
  if (!target) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing url query parameter" }));
    return;
  }

  fetchPreviewMetadata(target)
    .then(data => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    })
    .catch(error => {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message || "Preview fetch failed" }));
    });
}

function isProviderRoute(url = "") {
  return Object.keys(TARGETS).some(prefix => url.startsWith(prefix));
}

async function serveStaticAsset(req, res) {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(requestUrl.pathname || "/");
  if (pathname === "/") pathname = "/index.html";

  const requestedPath = path.normalize(path.join(DIST_DIR, pathname));
  const fallbackIndex = path.join(DIST_DIR, "index.html");
  const canServeRequested = requestedPath.startsWith(DIST_DIR);
  let filePath = canServeRequested ? requestedPath : fallbackIndex;

  try {
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      filePath = fallbackIndex;
      const fallbackStats = await fs.stat(filePath).catch(() => null);
      if (!fallbackStats?.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Build output not found. Run `npm run build` before starting the production server.");
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || "application/octet-stream";
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": filePath === fallbackIndex ? "no-cache" : "public, max-age=31536000, immutable" });
    res.end(data);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error?.message || "Static file error");
  }
}

function handleProviderProxy(req, res) {
  let targetBase = null;
  let pathRemainder = req.url;
  for (const [prefix, base] of Object.entries(TARGETS)) {
    if (req.url.startsWith(prefix)) {
      targetBase = base;
      pathRemainder = req.url.slice(prefix.length) || "/";
      break;
    }
  }

  if (!targetBase) {
    res.writeHead(404);
    res.end("Use /openai/*, /anthropic/*, /google/*, or /preview?url=...");
    return;
  }

  const url = new URL(pathRemainder, targetBase);
  const headers = { ...req.headers, host: url.hostname };
  delete headers.origin;
  delete headers.referer;

  const body = [];
  req.on("data", chunk => body.push(chunk));
  req.on("end", () => {
    const allowedOrigin = getAllowedOrigin(req);
    const proxyReq = https.request(url, { method: req.method, headers }, proxyRes => {
      const responseHeaders = { ...proxyRes.headers };
      if (allowedOrigin) responseHeaders["access-control-allow-origin"] = allowedOrigin;
      if (allowedOrigin) responseHeaders.vary = responseHeaders.vary ? `${responseHeaders.vary}, Origin` : "Origin";
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Proxy error");
    });
    if (body.length) proxyReq.write(Buffer.concat(body));
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url.startsWith("/preview")) {
    handlePreviewRequest(req, res);
    return;
  }

  if (!isProviderRoute(req.url)) {
    serveStaticAsset(req, res);
    return;
  }

  handleProviderProxy(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  Context Snake CORS Proxy on http://localhost:${PORT}`);
  console.log(`  Default API Base: http://localhost:${PORT}/openai`);
  console.log(`  Anthropic is also available at: http://localhost:${PORT}/anthropic`);
  console.log(`  Google Gemini is also available at: http://localhost:${PORT}/google`);
  console.log(`  Link preview metadata is available at: http://localhost:${PORT}/preview?url=...`);
  console.log(`  Built frontend is served from: http://localhost:${PORT}/\n`);
});
