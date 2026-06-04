import express from "express";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 5898);
const host = process.env.HOST || "127.0.0.1";
const mdviewHome = process.env.MDVIEW_HOME || path.join(os.homedir(), ".mdview");
const cacheDir = path.join(mdviewHome, "cache");
const cacheIndexPath = path.join(cacheDir, "index.json");
const fallbackDefaultFile = path.resolve(process.cwd(), "README.md");
const defaultFile = process.argv[2]
  ? normalizeSource(process.argv[2])
  : fsSync.existsSync(fallbackDefaultFile)
    ? fallbackDefaultFile
    : "";

function createMarkdownRenderer({ html }) {
  const renderer = new MarkdownIt({
    html,
    linkify: true,
    typographer: true,
    highlight(code, language) {
      if (language && hljs.getLanguage(language)) {
        try {
          const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
          return `<pre class="hljs"><code>${highlighted}</code></pre>`;
        } catch {
          // Fall through to escaped plain rendering.
        }
      }

      return `<pre class="hljs"><code>${renderer.utils.escapeHtml(code)}</code></pre>`;
    }
  });

  return renderer;
}

const localMarkdown = createMarkdownRenderer({ html: true });
const remoteMarkdown = createMarkdownRenderer({ html: false });

app.disable("x-powered-by");
app.use("/vendor/highlight", express.static(path.join(__dirname, "node_modules/highlight.js/styles")));
app.use(express.static(path.join(__dirname, "public")));

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSource(value) {
  return isHttpUrl(value) ? value : path.resolve(value);
}

function nameFromUrl(sourceUrl) {
  const url = new URL(sourceUrl);
  const basename = path.basename(url.pathname);
  return basename || url.hostname;
}

function cacheKeyFor(sourceUrl) {
  return crypto.createHash("sha256").update(sourceUrl).digest("hex").slice(0, 24);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeUrlIndex(sourceUrl, entry) {
  const index = await readJson(cacheIndexPath, { urls: {} });
  index.urls[sourceUrl] = entry;
  await fs.writeFile(cacheIndexPath, `${JSON.stringify(index, null, 2)}\n`);
}

async function fetchWithTimeout(sourceUrl, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    return await fetch(sourceUrl, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readRemoteMarkdown(sourceUrl) {
  await fs.mkdir(cacheDir, { recursive: true });

  const cacheKey = cacheKeyFor(sourceUrl);
  const cachedPath = path.join(cacheDir, `${cacheKey}.md`);
  const metadataPath = path.join(cacheDir, `${cacheKey}.json`);
  const previousMetadata = await readJson(metadataPath, {});
  const headers = {
    "accept": "text/markdown, text/plain, text/*, */*",
    "user-agent": "@thisishsb/mdview"
  };

  if (previousMetadata.etag) {
    headers["if-none-match"] = previousMetadata.etag;
  }

  if (previousMetadata.lastModified) {
    headers["if-modified-since"] = previousMetadata.lastModified;
  }

  try {
    const response = await fetchWithTimeout(sourceUrl, {
      headers,
      redirect: "follow"
    });

    if (response.status === 304 && fsSync.existsSync(cachedPath)) {
      const stats = await fs.stat(cachedPath);
      return {
        markdown: await fs.readFile(cachedPath, "utf8"),
        stats,
        cacheKey,
        cachedPath,
        metadata: previousMetadata,
        fromCache: true
      };
    }

    if (!response.ok) {
      throw new Error(`Remote server returned ${response.status}.`);
    }

    const markdown = await response.text();
    const metadata = {
      url: sourceUrl,
      finalUrl: response.url,
      cacheKey,
      cachedPath,
      metadataPath,
      fetchedAt: new Date().toISOString(),
      etag: response.headers.get("etag") || "",
      lastModified: response.headers.get("last-modified") || "",
      contentType: response.headers.get("content-type") || "",
      status: response.status
    };

    await fs.writeFile(cachedPath, markdown);
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await writeUrlIndex(sourceUrl, {
      cacheKey,
      cachedPath,
      metadataPath,
      finalUrl: metadata.finalUrl,
      lastFetchedAt: metadata.fetchedAt
    });

    return {
      markdown,
      stats: await fs.stat(cachedPath),
      cacheKey,
      cachedPath,
      metadata,
      fromCache: false
    };
  } catch (error) {
    if (fsSync.existsSync(cachedPath)) {
      const metadata = await readJson(metadataPath, previousMetadata);
      return {
        markdown: await fs.readFile(cachedPath, "utf8"),
        stats: await fs.stat(cachedPath),
        cacheKey,
        cachedPath,
        metadata,
        fromCache: true,
        warning: error.message
      };
    }

    throw error;
  }
}

async function renderLocalMarkdown(filePath, res) {
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    res.status(400).json({ error: "That path is not a file.", file: filePath });
    return;
  }

  const markdown = await fs.readFile(filePath, "utf8");

  res.json({
    sourceType: "file",
    file: filePath,
    source: filePath,
    name: path.basename(filePath),
    directory: path.dirname(filePath),
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
    html: localMarkdown.render(markdown)
  });
}

async function renderRemoteMarkdown(sourceUrl, res) {
  const remote = await readRemoteMarkdown(sourceUrl);
  const url = new URL(sourceUrl);

  res.json({
    sourceType: "url",
    file: sourceUrl,
    source: sourceUrl,
    name: nameFromUrl(sourceUrl),
    directory: url.origin,
    modifiedAt: remote.stats.mtime.toISOString(),
    size: remote.stats.size,
    cacheKey: remote.cacheKey,
    cachedFile: remote.cachedPath,
    fetchedAt: remote.metadata.fetchedAt || "",
    finalUrl: remote.metadata.finalUrl || sourceUrl,
    fromCache: remote.fromCache,
    warning: remote.warning || "",
    html: remoteMarkdown.render(remote.markdown)
  });
}

app.get("/api/default-file", (_req, res) => {
  res.json({ file: defaultFile });
});

app.get("/api/render", async (req, res) => {
  const requestedFile = String(req.query.file || "");

  if (!requestedFile.trim()) {
    res.status(400).json({ error: "Pass a Markdown file path or URL as ?file=..." });
    return;
  }

  const source = normalizeSource(requestedFile);

  try {
    if (isHttpUrl(source)) {
      await renderRemoteMarkdown(source, res);
    } else {
      await renderLocalMarkdown(source, res);
    }
  } catch (error) {
    const message = error && typeof error === "object" && "code" in error
      ? `Could not read file (${error.code}).`
      : error.message || "Could not read source.";

    res.status(404).json({
      error: message,
      file: source
    });
  }
});

const server = app.listen(port, host, () => {
  const target = defaultFile ? `/?file=${encodeURIComponent(defaultFile)}` : "/";

  console.log(`Local Markdown Renderer running at http://${host}:${port}${target}`);
  console.log("Pass a Markdown path or URL with: npm start -- /absolute/path-or-url");
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
