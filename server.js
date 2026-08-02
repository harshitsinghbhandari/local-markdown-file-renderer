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
const requestedSource = process.argv[2]
  ? normalizeSource(process.argv[2])
  : fsSync.existsSync(fallbackDefaultFile)
    ? fallbackDefaultFile
    : "";

// Files tried when a link points at a directory. README and index lead because they
// are the universal conventions; course.md serves Markdown course workspaces.
const directoryEntryFiles = ["README.md", "index.md", "course.md"];

// Browsers refuse to play the default .m4a mapping (audio/mp4a-latm) inline.
const contentTypeOverrides = {
  ".m4a": "audio/mp4",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8"
};

const rootDir = resolveRoot();
const defaultFile = resolveDefaultFile();

function isDirectory(target) {
  try {
    return fsSync.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function resolveRoot() {
  if (process.env.MDVIEW_ROOT) return path.resolve(process.env.MDVIEW_ROOT);
  if (!requestedSource || isHttpUrl(requestedSource)) return path.resolve(process.cwd());
  return isDirectory(requestedSource) ? requestedSource : path.dirname(requestedSource);
}

function resolveDefaultFile() {
  if (!requestedSource || isHttpUrl(requestedSource)) return requestedSource;
  return isDirectory(requestedSource) ? directoryEntry(requestedSource) : requestedSource;
}

// Containment by path segment, not string prefix, so /tmp/rootkit is not inside /tmp/root.
function insideRoot(target) {
  const relative = path.relative(rootDir, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function directoryEntry(directory) {
  for (const candidate of directoryEntryFiles) {
    const entry = path.join(directory, candidate);
    if (fsSync.existsSync(entry) && !isDirectory(entry)) return entry;
  }

  return directory;
}

function isMarkdownPath(target) {
  return /\.(md|markdown)$/i.test(target);
}

function splitFragment(href) {
  const index = href.indexOf("#");
  return index === -1 ? [href, ""] : [href.slice(0, index), href.slice(index)];
}

function isExternalHref(href) {
  return !href
    || href.startsWith("#")
    || href.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/i.test(href);
}

function viewerHref(target) {
  const route = isDirectory(target) || isMarkdownPath(target) ? "/" : "/raw";
  return `${route}?file=${encodeURIComponent(target)}`;
}

function rewriteHref(href, env, { alwaysRaw = false } = {}) {
  if (!env || !env.docDir || isExternalHref(href)) return href;

  const [pathPart, fragment] = splitFragment(href);
  if (!pathPart) return href;

  let target;
  try {
    target = path.resolve(env.docDir, decodeURIComponent(pathPart));
  } catch {
    target = path.resolve(env.docDir, pathPart);
  }

  // Leave escaping links alone so they fail visibly instead of serving something.
  if (!insideRoot(target)) return href;

  const route = alwaysRaw ? `/raw?file=${encodeURIComponent(target)}` : viewerHref(target);
  return `${route}${fragment}`;
}

// Basename to absolute path across the document's directory and its immediate
// subdirectories, so an index that names its files in backticks becomes clickable.
function buildFileMap(docDir) {
  const map = new Map();

  const addFiles = (directory) => {
    let entries;
    try {
      entries = fsSync.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (entry.isFile() && !map.has(entry.name)) {
        map.set(entry.name, path.join(directory, entry.name));
      }
    }

    return entries;
  };

  for (const entry of addFiles(docDir)) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      addFiles(path.join(docDir, entry.name));
    }
  }

  return map;
}

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

  renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const hrefIndex = token.attrIndex("href");

    if (hrefIndex >= 0) {
      token.attrs[hrefIndex][1] = rewriteHref(token.attrs[hrefIndex][1], env);
    }

    return self.renderToken(tokens, index, options);
  };

  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const srcIndex = token.attrIndex("src");

    if (srcIndex >= 0) {
      token.attrs[srcIndex][1] = rewriteHref(token.attrs[srcIndex][1], env, { alwaysRaw: true });
    }

    token.attrs[token.attrIndex("alt")][1] = self.renderInlineAsText(token.children, options, env);
    return self.renderToken(tokens, index, options);
  };

  renderer.renderer.rules.code_inline = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const rendered = `<code${self.renderAttrs(token)}>${renderer.utils.escapeHtml(token.content)}</code>`;
    const target = env && env.fileMap ? env.fileMap.get(token.content.trim()) : undefined;

    if (!target || !insideRoot(target)) return rendered;

    return `<a class="file-link" href="${renderer.utils.escapeHtml(viewerHref(target))}">${rendered}</a>`;
  };

  return renderer;
}

const localMarkdown = createMarkdownRenderer({ html: true });
const remoteMarkdown = createMarkdownRenderer({ html: false });

app.disable("x-powered-by");

// The server binds loopback but runs at login, so reject requests whose Host is not
// ours. This is what stops DNS rebinding, which a plain origin check would miss.
app.use((req, res, next) => {
  const requestHost = req.headers.host || "";
  const allowed = [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];

  if (!allowed.includes(requestHost)) {
    res.status(403).json({ error: "Request blocked: unexpected Host header." });
    return;
  }

  next();
});

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

function renderDirectoryListing(directory) {
  const entries = fsSync.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const escape = localMarkdown.utils.escapeHtml;
  const parent = path.dirname(directory);
  const items = [];

  if (insideRoot(parent) && parent !== directory) {
    items.push(`<li><a href="${escape(viewerHref(parent))}">..</a></li>`);
  }

  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const label = entry.isDirectory() ? `${entry.name}/` : entry.name;
    items.push(`<li><a href="${escape(viewerHref(target))}">${escape(label)}</a></li>`);
  }

  return `<h1>${escape(path.basename(directory) || directory)}</h1>\n<ul class="directory-listing">\n${items.join("\n")}\n</ul>`;
}

async function renderLocalDirectory(directory, res) {
  const entry = directoryEntry(directory);

  if (entry !== directory) {
    await renderLocalMarkdown(entry, res);
    return;
  }

  const stats = await fs.stat(directory);

  res.json({
    sourceType: "directory",
    file: directory,
    source: directory,
    name: path.basename(directory) || directory,
    directory: path.dirname(directory),
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
    html: renderDirectoryListing(directory)
  });
}

async function renderLocalMarkdown(filePath, res) {
  const stats = await fs.stat(filePath);

  if (stats.isDirectory()) {
    await renderLocalDirectory(filePath, res);
    return;
  }

  if (!stats.isFile()) {
    res.status(400).json({ error: "That path is not a file.", file: filePath });
    return;
  }

  const markdown = await fs.readFile(filePath, "utf8");
  const docDir = path.dirname(filePath);

  res.json({
    sourceType: "file",
    file: filePath,
    source: filePath,
    name: path.basename(filePath),
    directory: docDir,
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
    html: localMarkdown.render(markdown, { docDir, fileMap: buildFileMap(docDir) })
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
  res.json({ file: defaultFile, root: rootDir });
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
      return;
    }

    if (!insideRoot(source)) {
      res.status(403).json({
        error: `That path is outside the served root (${rootDir}).`,
        file: source
      });
      return;
    }

    await renderLocalMarkdown(source, res);
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

app.get("/raw", (req, res) => {
  const requestedFile = String(req.query.file || "");

  if (!requestedFile.trim()) {
    res.status(400).json({ error: "Pass a file path as ?file=..." });
    return;
  }

  const target = path.resolve(requestedFile);

  if (!insideRoot(target)) {
    res.status(403).json({ error: `That path is outside the served root (${rootDir}).` });
    return;
  }

  const override = contentTypeOverrides[path.extname(target).toLowerCase()];
  if (override) res.type(override);

  // sendFile handles Range requests, so audio and video seek correctly.
  res.sendFile(target, { dotfiles: "deny" }, (error) => {
    if (!error || res.headersSent) return;
    res.status(404).json({ error: "Could not read that file.", file: target });
  });
});

const server = app.listen(port, host, () => {
  const target = defaultFile ? `/?file=${encodeURIComponent(defaultFile)}` : "/";

  console.log(`Local Markdown Renderer running at http://${host}:${port}${target}`);
  console.log(`Serving root: ${rootDir}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
