import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "mdview-daemon-test-"));
const home = path.join(workspace, "home");
const first = path.join(workspace, "a", "first.md");
const same = path.join(workspace, "a", "same.md");
const outside = path.join(workspace, "ab", "outside.md");
const env = { ...process.env, MDVIEW_HOME: home };
delete env.MDVIEW_ROOT;
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const run = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 15000 });
const state = async () => JSON.parse(await fs.readFile(path.join(home, "state.json"), "utf8"));
const defaults = async () => (await fetch(`${origin}/api/default-file`)).json();
const render = (file) => fetch(`${origin}/api/render?file=${encodeURIComponent(file)}`);

try {
  for (const file of [first, same, outside]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `# ${path.basename(file)}\n`);
  }
  await run("up", first, "--port", String(port));
  const initial = await state();
  assert.equal((await defaults()).root, path.dirname(first));
  assert.equal((await render(first)).status, 200);

  await run("up", same);
  assert.equal((await state()).pid, initial.pid, "same root reuses daemon");

  await run("up", outside);
  const switched = await state();
  assert.notEqual(switched.pid, initial.pid, "outside file restarts daemon");
  assert.equal(switched.port, port, "restart preserves active port");
  assert.equal((await defaults()).root, path.dirname(outside));
  assert.equal((await render(outside)).status, 200);
  assert.equal((await render(first)).status, 403, "old scope is no longer served");

  await run("up", outside, "--root", workspace);
  const widened = await state();
  assert.notEqual(widened.pid, switched.pid, "explicit root change restarts daemon");
  assert.equal((await defaults()).root, workspace);
  assert.equal((await render(first)).status, 200);
  assert.equal((await render(outside)).status, 200);

  await assert.rejects(run("up", outside, "--root", path.dirname(first)));
  assert.equal((await state()).pid, widened.pid, "invalid request leaves daemon intact");
  assert.equal((await render(outside)).status, 200);

  await run("up", "--root", path.dirname(first));
  assert.equal((await defaults()).root, path.dirname(first));
  assert.equal((await render((await defaults()).file)).status, 200, "root-only restart has valid default");

  const beforeRemote = await state();
  await run("up", "https://example.com/document.md");
  assert.equal((await state()).pid, beforeRemote.pid, "remote URL reuses daemon");

  await exec(process.execPath, [cli, "up", outside], {
    env: { ...env, MDVIEW_ROOT: workspace }, timeout: 15000
  });
  assert.equal((await defaults()).root, workspace, "environment root applies to existing daemon");
  await run("down");
  await assert.rejects(run("up", outside, "--root", path.dirname(first), "--port", String(port)));
  await assert.rejects(state(), "invalid initial request must not create a daemon");
  console.log("ok   daemon root changes, reuse, validation, and port preservation");
} finally {
  try {
    await run("down");
  } finally {
    try {
      process.kill((await state()).pid, "SIGTERM");
    } catch {}
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
