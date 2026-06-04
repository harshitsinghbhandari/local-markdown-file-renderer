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

const args = process.argv.slice(2);
const command = args[0] || "help";

function usage() {
  console.log(`mdview - local Markdown renderer daemon

Usage:
  mdview up [file.md|url] [--port 5898] [--open]
  mdview down
  mdview status
  mdview url [file.md|url]

Examples:
  mdview up
  mdview up ./README.md --open
  mdview up https://raw.githubusercontent.com/aoagents/ReverbCode/refs/heads/main/README.md --open
  mdview url /absolute/path/to/file.md`);
}

function parseOptions(values) {
  const options = {
    open: false,
    port: defaultPort,
    positional: []
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === "--open") {
      options.open = true;
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

function urlFor(source, port = defaultPort) {
  const base = `http://${host}:${port}/`;

  if (!source) return base;

  const url = new URL(base);
  url.searchParams.set("file", normalizeSource(source));
  return url.toString();
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
  const source = options.positional[0] ? normalizeSource(options.positional[0]) : "";
  const existing = await readState();

  if (existing && processIsRunning(existing.pid) && await canConnect(existing.port)) {
    console.log(`mdview is already running on ${existing.url}`);
    console.log(`pid: ${existing.pid}`);
    return;
  }

  if (existing) {
    await clearState();
  }

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
      MDVIEW_DAEMON: "1"
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

async function status() {
  const state = await readState();

  if (!state || !processIsRunning(state.pid) || !await canConnect(state.port)) {
    if (state) await clearState();
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
  } else if (command === "url") {
    const options = parseOptions(args.slice(1));
    console.log(urlFor(options.positional[0], options.port));
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
