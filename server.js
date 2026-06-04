import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const defaultFile = process.argv[2] ? path.resolve(process.argv[2]) : "";

const md = new MarkdownIt({
  html: true,
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

    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  }
});

app.disable("x-powered-by");
app.use("/vendor/highlight", express.static(path.join(__dirname, "node_modules/highlight.js/styles")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/default-file", (_req, res) => {
  res.json({ file: defaultFile });
});

app.get("/api/render", async (req, res) => {
  const requestedFile = String(req.query.file || "");

  if (!requestedFile.trim()) {
    res.status(400).json({ error: "Pass an absolute Markdown file path as ?file=..." });
    return;
  }

  const filePath = path.resolve(requestedFile);

  try {
    const stats = await fs.stat(filePath);

    if (!stats.isFile()) {
      res.status(400).json({ error: "That path is not a file.", file: filePath });
      return;
    }

    const markdown = await fs.readFile(filePath, "utf8");

    res.json({
      file: filePath,
      name: path.basename(filePath),
      directory: path.dirname(filePath),
      modifiedAt: stats.mtime.toISOString(),
      size: stats.size,
      html: md.render(markdown)
    });
  } catch (error) {
    const message = error && typeof error === "object" && "code" in error
      ? `Could not read file (${error.code}).`
      : "Could not read file.";

    res.status(404).json({
      error: message,
      file: filePath
    });
  }
});

app.listen(port, host, () => {
  const target = defaultFile ? `/?file=${encodeURIComponent(defaultFile)}` : "/";

  console.log(`Local Markdown Renderer running at http://${host}:${port}${target}`);
  console.log("Pass a Markdown path with: npm start -- /absolute/path/to/file.md");
});
