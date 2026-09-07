#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.join(__dirname, "server.js");

const host = "127.0.0.1";
const defaultPort = 5898;
const stateDir = process.env.MDVIEW_HOME || path.join(os.homedir(), ".mdview");
const stateFile = path.join(stateDir, "state.json");
const logFile = path.join(stateDir, "mdview.log");
const agentLabel = "com.thisishsb.mdview";
const agentDir = path.join(os.homedir(), "Library", "LaunchAgents");
const agentPath = path.join(agentDir, `${agentLabel}.plist`);

const args = process.argv.slice(2);
const command = args[0] || "help";

function usage() {
  console.log(`mdview - local Markdown renderer daemon

Usage:
  mdview up [file.md|dir|url] [--root dir] [--port 5898] [--open] [--copy]
  mdview down
  mdview status
  mdview url [file.md|url] [--copy]
  mdview install [file.md|dir] [--root dir] [--port 5898]
  mdview uninstall

Examples:
  mdview up
  mdview up ./README.md --open
  mdview up ~/courses --open
  mdview up https://raw.githubusercontent.com/aoagents/ReverbCode/refs/heads/main/README.md --open
  mdview url /absolute/path/to/file.md --copy
  mdview install ~/courses

Passing a directory, or a file inside one, serves that whole tree: relative links
between Markdown files work, and PDFs, images and audio beside them open in the
browser. Paths outside the root are refused.

install writes a launchd agent so the server starts at login and stays up, which
makes http://127.0.0.1:5898/ a stable bookmark. Remove it with uninstall.`);
}

function parseOptions(values) {
  const options = {
    open: false,
    copy: false,
    port: defaultPort,
    root: "",
    positional: []
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === "--open") {
      options.open = true;
    } else if (value === "--copy") {
      options.copy = true;
    } else if (value === "--root") {
      const root = values[index + 1];

      if (!root) {
        throw new Error("--root needs a directory.");
      }

      options.root = path.resolve(root);
      index += 1;
    } else if (value === "--port") {
      const port = Number(values[index + 1]);

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be a number between 1 and 65535.");
      }

      options.port = port;
      index += 1;
    } else {
      options.positional.push(value);
    }
  }

  return options;
}

async function ensureStateDir() {
  await fsp.mkdir(stateDir, { recursive: true });
}

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await ensureStateDir();
  await fsp.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function clearState() {
  await fsp.rm(stateFile, { force: true });
}

function processIsRunning(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 4000;

  while (Date.now() < deadline) {
    if (await canConnect(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

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

function insideRoot(source, root) {
  const relative = path.relative(root, source);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function urlFor(source, port = defaultPort) {
  const base = `http://${host}:${port}/`;

  if (!source) return base;

  const url = new URL(base);
  url.searchParams.set("file", normalizeSource(source));
  return url.toString();
}

// ponytail: linux assumes xclip; add wl-copy/xsel fallbacks if someone hits it
function copyToClipboard(text) {
  return new Promise((resolve) => {
    const platform = process.platform;
    const [command, commandArgs] = platform === "darwin"
      ? ["pbcopy", []]
      : platform === "win32"
        ? ["clip", []]
        : ["xclip", ["-selection", "clipboard"]];

    const child = spawn(command, commandArgs, { stdio: ["pipe", "ignore", "ignore"] });

    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

async function maybeCopy(options, url) {
  if (!options.copy) return;

  if (await copyToClipboard(url)) {
    console.log("copied url to clipboard");
  } else {
    console.error("Could not copy to clipboard.");
  }
}

function openUrl(url) {
  const platform = process.platform;
  const opener = platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];

  const child = spawn(opener[0], opener[1], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function up(values) {
  const options = parseOptions(values);
  let source = options.positional[0] ? normalizeSource(options.positional[0]) : "";
  const requestedRoot = options.root || (process.env.MDVIEW_ROOT ? path.resolve(process.env.MDVIEW_ROOT) : "");

  if (requestedRoot && source && !isHttpUrl(source) && !insideRoot(source, requestedRoot)) {
    throw new Error(`That path is outside the requested root (${requestedRoot}). Choose a containing --root.`);
  }

  const existing = await readState();

  if (existing && processIsRunning(existing.pid) && await canConnect(existing.port)) {
    let current;
    try {
      const response = await fetch(`http://${host}:${existing.port}/api/default-file`, {
        signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      current = await response.json();
      if (typeof current.root !== "string" || !path.isAbsolute(current.root) || typeof current.file !== "string") {
        throw new Error("invalid server configuration");
      }
    } catch (error) {
      throw new Error(`Could not determine the running daemon's served root: ${error.message}`);
    }

    const rootChanged = requestedRoot && requestedRoot !== path.resolve(current.root);
    const sourceOutsideRoot = source && !isHttpUrl(source) && !insideRoot(source, current.root);

    if (!rootChanged && !sourceOutsideRoot) {
      const url = source ? urlFor(source, existing.port) : existing.url;
      console.log(`mdview is already running on ${existing.url}`);
      if (source) console.log(`url: ${url}`);
      console.log(`pid: ${existing.pid}`);
      await maybeCopy(options, url);
      if (options.open) openUrl(url);
      return;
    }

    if (!source) {
      source = current.file && (isHttpUrl(current.file) || insideRoot(current.file, requestedRoot))
        ? current.file
        : requestedRoot;
    }
    options.port = existing.port;
    console.log("Restarting mdview to serve the requested root.");
    await down();
    if (await readState()) return;
  } else if (existing) {
    await clearState();
  }

  if (!source && requestedRoot) source = requestedRoot;

  if (await canConnect(options.port)) {
    console.error(`Port ${options.port} is already in use.`);
    process.exitCode = 1;
    return;
  }

  await ensureStateDir();

  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, source ? [serverPath, source] : [serverPath], {
    detached: true,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(options.port),
      MDVIEW_DAEMON: "1",
      ...(options.root ? { MDVIEW_ROOT: options.root } : {})
    },
    stdio: ["ignore", logFd, logFd]
  });

  child.unref();

  const state = {
    pid: child.pid,
    port: options.port,
    host,
    url: urlFor(source, options.port),
    defaultFile: source,
    logFile,
    startedAt: new Date().toISOString()
  };

  await writeState(state);

  if (!await waitForServer(options.port)) {
    if (processIsRunning(child.pid)) {
      process.kill(child.pid, "SIGTERM");
    }

    await clearState();
    console.error(`mdview failed to start. Check ${logFile}`);
    process.exitCode = 1;
    return;
  }

  console.log(`mdview is running at ${state.url}`);
  console.log(`pid: ${state.pid}`);
  console.log(`log: ${state.logFile}`);
  await maybeCopy(options, state.url);

  if (options.open) {
    openUrl(state.url);
  }
}

async function down() {
  const state = await readState();

  if (!state) {
    console.log("mdview is not running.");
    return;
  }

  if (!processIsRunning(state.pid)) {
    await clearState();
    console.log("mdview was not running; removed stale state.");
    return;
  }

  process.kill(state.pid, "SIGTERM");

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (!processIsRunning(state.pid)) {
      await clearState();
      console.log("mdview stopped.");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.error(`mdview did not stop cleanly. pid: ${state.pid}`);
  process.exitCode = 1;
}

function runCommand(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ code: 1, stderr: error.message }));
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

function plistFor({ source, root, port }) {
  const escape = (value) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const programArguments = [process.execPath, serverPath, ...(source ? [source] : [])]
    .map((value) => `      <string>${escape(value)}</string>`)
    .join("\n");

  const environment = [
    ["HOST", host],
    ["PORT", String(port)],
    ["MDVIEW_DAEMON", "1"],
    ...(root ? [["MDVIEW_ROOT", root]] : [])
  ]
    .map(([key, value]) => `      <key>${key}</key>\n      <string>${escape(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${agentLabel}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escape(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escape(logFile)}</string>
  </dict>
</plist>
`;
}

async function install(values) {
  if (process.platform !== "darwin") {
    console.error("install uses launchd and only works on macOS. Use `mdview up` elsewhere.");
    process.exitCode = 1;
    return;
  }

  const options = parseOptions(values);
  const source = options.positional[0] ? normalizeSource(options.positional[0]) : "";

  if (source && isHttpUrl(source)) {
    console.error("install needs a local file or directory, not a URL.");
    process.exitCode = 1;
    return;
  }

  if (source && !fs.existsSync(source)) {
    console.error(`No such file or directory: ${source}`);
    process.exitCode = 1;
    return;
  }

  // A running `mdview up` would hold the port and make launchd's copy crash-loop.
  const existing = await readState();
  if (existing && processIsRunning(existing.pid)) {
    await down();
  }

  await ensureStateDir();
  await fsp.mkdir(agentDir, { recursive: true });
  await fsp.writeFile(agentPath, plistFor({ source, root: options.root, port: options.port }));

  const target = `gui/${process.getuid()}`;
  await runCommand("launchctl", ["bootout", `${target}/${agentLabel}`]);
  const bootstrap = await runCommand("launchctl", ["bootstrap", target, agentPath]);

  if (bootstrap.code !== 0) {
    console.error(`Could not load the launchd agent: ${bootstrap.stderr.trim() || `exit ${bootstrap.code}`}`);
    process.exitCode = 1;
    return;
  }

  if (!await waitForServer(options.port)) {
    console.error(`Agent loaded but the server did not answer. Check ${logFile}`);
    process.exitCode = 1;
    return;
  }

  console.log(`mdview installed and running at ${urlFor(source, options.port)}`);
  console.log(`agent: ${agentPath}`);
  console.log(`log: ${logFile}`);
  console.log("Bookmark it. Remove with: mdview uninstall");
}

async function uninstall() {
  if (process.platform !== "darwin") {
    console.error("uninstall uses launchd and only works on macOS.");
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(agentPath)) {
    console.log("No mdview launchd agent is installed.");
    return;
  }

  await runCommand("launchctl", ["bootout", `gui/${process.getuid()}/${agentLabel}`]);
  await fsp.rm(agentPath, { force: true });
  console.log(`Removed ${agentPath}`);
}

async function status() {
  const state = await readState();

  if (!state || !processIsRunning(state.pid) || !await canConnect(state.port)) {
    if (state) await clearState();

    // A launchd-installed server is not in state.json, so report the port directly.
    if (await canConnect(defaultPort)) {
      const installed = fs.existsSync(agentPath);
      console.log(`mdview is answering on http://${host}:${defaultPort}/`);
      console.log(installed
        ? `started by launchd (${agentPath}); stop it with: mdview uninstall`
        : "started outside this CLI; `mdview down` will not stop it.");
      return;
    }

    console.log("mdview is not running.");
    return;
  }

  console.log(`mdview is running at ${state.url}`);
  console.log(`pid: ${state.pid}`);
  console.log(`started: ${state.startedAt}`);
  console.log(`log: ${state.logFile}`);
}

try {
  if (command === "up") {
    await up(args.slice(1));
  } else if (command === "down") {
    await down();
  } else if (command === "status") {
    await status();
  } else if (command === "install") {
    await install(args.slice(1));
  } else if (command === "uninstall") {
    await uninstall();
  } else if (command === "url") {
    const options = parseOptions(args.slice(1));
    const url = urlFor(options.positional[0], options.port);
    console.log(url);
    await maybeCopy(options, url);
  } else if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
