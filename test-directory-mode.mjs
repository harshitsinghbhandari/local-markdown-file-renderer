// Boots a real server against a temporary tree and checks directory mode end to end.
// Run with: npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.js");
const port = 5921;
const origin = `http://127.0.0.1:${port}`;

// realpath first: macOS /var is a symlink to /private/var, which would make the
// containment comparison compare two different spellings of the same directory.
const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mdview-test-"));
const root = path.join(workspace, "root");
// Sibling whose name starts with the root's name, to catch prefix-based containment.
const rootkit = path.join(workspace, "rootkit");

fs.mkdirSync(path.join(root, "CS-101"), { recursive: true });
fs.mkdirSync(path.join(root, "resources"), { recursive: true });
fs.mkdirSync(rootkit, { recursive: true });

fs.writeFileSync(path.join(root, "README.md"), [
  "# Workspace",
  "",
  "- [Course](CS-101/)",
  "- [Notes](notes.md)",
  "- [Anchored](notes.md#section)",
  "- [External](https://example.com/page.md)",
  "",
  "![Shot](shot.png)",
  "",
  "Archive holds `paper.pdf` and `lecture.m4a` and `nothing-here.pdf`.",
  ""
].join("\n"));
fs.writeFileSync(path.join(root, "notes.md"), "# Notes\n");
fs.writeFileSync(path.join(root, "shot.png"), "not really a png");
fs.writeFileSync(path.join(root, "CS-101", "course.md"), "# CS-101\n");
fs.writeFileSync(path.join(root, "resources", "paper.pdf"), "%PDF-1.4 fake");
fs.writeFileSync(path.join(root, "resources", "lecture.m4a"), "fake audio bytes");
fs.writeFileSync(path.join(rootkit, "secret.md"), "# Secret\n");

const server = spawn(process.execPath, [serverPath, root], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MDVIEW_HOME: path.join(workspace, "home") },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

function canConnect() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(200);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await canConnect()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start. log:\n${serverLog}`);
}

const render = (file) => fetch(`${origin}/api/render?file=${encodeURIComponent(file)}`);
const viewerLink = (target) => `/?file=${encodeURIComponent(target)}`;
const rawLink = (target) => `/raw?file=${encodeURIComponent(target)}`;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}

try {
  await waitForServer();

  const readme = await (await render(path.join(root, "README.md"))).json();
  const html = readme.html;

  check("markdown link becomes a viewer link", () => {
    assert.ok(html.includes(viewerLink(path.join(root, "notes.md"))), html);
  });

  check("directory link becomes a viewer link", () => {
    assert.ok(html.includes(viewerLink(path.join(root, "CS-101"))), html);
  });

  check("fragment is preserved on a rewritten link", () => {
    assert.ok(html.includes(`${viewerLink(path.join(root, "notes.md"))}#section`), html);
  });

  check("external link is untouched", () => {
    assert.ok(html.includes("https://example.com/page.md"), html);
    assert.ok(!html.includes(rawLink("https://example.com/page.md")), html);
  });

  check("image src becomes a raw link", () => {
    assert.ok(html.includes(rawLink(path.join(root, "shot.png"))), html);
  });

  check("backticked filename in a subdirectory becomes a raw link", () => {
    assert.ok(html.includes(rawLink(path.join(root, "resources", "paper.pdf"))), html);
    assert.ok(html.includes(rawLink(path.join(root, "resources", "lecture.m4a"))), html);
  });

  check("backticked non-file stays plain code", () => {
    assert.ok(html.includes("<code>nothing-here.pdf</code>"), html);
    assert.ok(!html.includes(rawLink(path.join(root, "nothing-here.pdf"))), html);
  });

  const courseDir = await (await render(path.join(root, "CS-101"))).json();
  check("directory resolves to its entry file", () => {
    assert.equal(courseDir.file, path.join(root, "CS-101", "course.md"));
    assert.ok(courseDir.html.includes("CS-101"), courseDir.html);
  });

  const listing = await (await render(path.join(root, "resources"))).json();
  check("directory without an entry file renders a listing", () => {
    assert.equal(listing.sourceType, "directory");
    assert.ok(listing.html.includes(rawLink(path.join(root, "resources", "paper.pdf"))), listing.html);
  });

  const audio = await fetch(`${origin}/raw?file=${encodeURIComponent(path.join(root, "resources", "lecture.m4a"))}`);
  check("raw serves .m4a as audio/mp4", () => {
    assert.equal(audio.status, 200);
    assert.match(audio.headers.get("content-type") || "", /^audio\/mp4/);
  });

  const pdf = await fetch(`${origin}/raw?file=${encodeURIComponent(path.join(root, "resources", "paper.pdf"))}`);
  check("raw serves .pdf as application/pdf", () => {
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-type") || "", /^application\/pdf/);
  });

  const escapedRender = await render("/etc/passwd");
  check("render refuses a path outside the root", () => {
    assert.equal(escapedRender.status, 403);
  });

  const escapedRaw = await fetch(`${origin}/raw?file=${encodeURIComponent("/etc/passwd")}`);
  check("raw refuses a path outside the root", () => {
    assert.equal(escapedRaw.status, 403);
  });

  const traversal = await fetch(`${origin}/raw?file=${encodeURIComponent(path.join(root, "..", "rootkit", "secret.md"))}`);
  check("raw refuses traversal through the root", () => {
    assert.equal(traversal.status, 403);
  });

  const prefixSibling = await render(path.join(rootkit, "secret.md"));
  check("a sibling sharing the root's name prefix is refused", () => {
    assert.equal(prefixSibling.status, 403);
  });

  // fetch() treats Host as a forbidden header and overwrites it, so this needs raw http.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/render?file=${encodeURIComponent(path.join(root, "README.md"))}`,
        headers: { Host: "evil.example.com" }
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    request.once("error", reject);
    request.end();
  });
  check("a foreign Host header is refused", () => {
    assert.equal(foreignHostStatus, 403);
  });

  const defaults = await (await fetch(`${origin}/api/default-file`)).json();
  check("default file resolves through the root directory", () => {
    assert.equal(defaults.root, root);
    assert.equal(defaults.file, path.join(root, "README.md"));
  });
} finally {
  server.kill("SIGTERM");
  fs.rmSync(workspace, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll directory-mode checks passed.");
