# Directory mode for mdview

Date: 2026-08-02

## Problem

mdview renders one Markdown file at a time. A relative link inside that file
(`[schedule](schedule.md)`, `[CS-347](CS-347/)`) renders as `<a href="schedule.md">`,
which the browser resolves against `http://127.0.0.1:5898/schedule.md` and the static
middleware answers with a 404. Links between files in a folder are therefore dead, and
non-Markdown files sitting beside the document (PDFs, audio, images) cannot be opened
at all.

The driving case is a semester course workspace: seven course folders, each with a
`course.md` linking to `syllabus.md`, `schedule.md`, `assessment.md` and a
`resources.md` that indexes a local archive of PDFs, lecture recordings and
photographs. The Markdown to make that a browsable site already exists. Only a renderer
that follows the links is missing.

## Approach

Give the served path a root and resolve everything relative to it. Markdown keeps
rendering in the single-page app; anything that is not Markdown is streamed by a new
endpoint with a correct content type so the browser handles it natively.

## Design

### Root

`mdview up <path>` sets a root: the path itself when it is a directory, otherwise its
parent. `--root <dir>` overrides it, and `MDVIEW_ROOT` sets it for a directly launched
server. Every path arriving over HTTP is resolved and then tested for containment in
the root before anything is read.

Containment is a `path.relative` test rather than a string prefix, so `/tmp/rootkit`
does not pass as being inside `/tmp/root`.

Requests also carry a `Host` check against `127.0.0.1:<port>` and `localhost:<port>`.
The server binds loopback, but it is now long-running and started at login, so this
closes DNS rebinding, where a hostile page resolves its own domain to 127.0.0.1 and
issues requests that a pure origin check would not catch.

Remote URL rendering is unaffected and stays unconfined; it fetches over the network
and never touches the local filesystem outside the cache.

### Link rewriting

Rewriting happens in `markdown-it` renderer rules (`link_open`, `image`, `code_inline`),
not by post-processing the HTML string. The current document's directory is passed
through the render `env`.

For each relative target, resolved against the document's directory:

| Target | Becomes |
| --- | --- |
| `.md` file | `/?file=<abs>` — stays in the app, keeps auto-refresh |
| directory | `/?file=<abs>` — resolved per the next section |
| anything else | `/raw?file=<abs>` |
| absolute URL, protocol-relative, bare `#anchor` | untouched |
| resolves outside the root | untouched, so it visibly fails rather than silently serving |

A trailing `#fragment` is preserved. Raw HTML in Markdown (`html: true` for local files)
is not rewritten; only Markdown-authored links and images are.

### Directories

A directory resolves to its entry file, tried in order: `README.md`, `index.md`,
`course.md`. With no entry file, the server renders a listing of the directory,
subdirectories first, as ordinary document HTML.

`README.md` and `index.md` lead because they are the universal conventions for a
published tool. `course.md` is last and still resolves for the course workspace, where
no course folder contains a README.

### `/raw`

Streams any file inside the root. `res.sendFile` handles Range requests, so audio
seeking works. Content types come from the extension, with `.m4a` forced to `audio/mp4`;
the default mapping is `audio/mp4a-latm`, which browsers will not play inline. `.md`
served through `/raw` is sent as `text/plain` so it displays instead of downloading.

### Backticked filenames

`resources.md` files name their files in backticks rather than links, because they are
indexes rather than navigation. Rendering them dead would leave the largest archive
(73 files) unreachable.

So `code_inline` gets a lookup: build a map of basename to absolute path covering the
document's directory and its immediate subdirectories, once per render, then link any
inline code span whose content matches. A span that matches nothing renders exactly as
it does today, so a miss is invisible and no tracked content needs editing.

This is the one rule that infers intent instead of following an explicit link. It is
bounded: one directory level, exact basename match, inside the root only.

### Always-on

`mdview install [path]` writes a launchd agent at
`~/Library/LaunchAgents/com.thisishsb.mdview.plist` with `RunAtLoad` and `KeepAlive`,
then bootstraps it. `mdview uninstall` boots it out and removes the file.
`http://127.0.0.1:5898/` becomes a stable bookmark.

A launchd-run server is not tracked in `state.json`, so `mdview status` additionally
reports a reachable port it did not start, and `mdview down` explains that an installed
agent must be removed with `uninstall` rather than killed.

### Compatibility

`mdview up file.md` on a document with no relative links behaves exactly as before.
The one behaviour change: pasting an absolute path into the toolbar now only works
within the root, where previously any readable path on the machine would render.
`--root` widens it deliberately. This is the security boundary that makes a login-time
daemon acceptable, so it is worth the change.

## Verification

`test-directory-mode.mjs` boots a server against a temporary fixture tree and asserts:
Markdown links rewrite to `/?file=`, non-Markdown links and backticked filenames
rewrite to `/raw?file=`, directories resolve to their entry file, `/raw` returns
`audio/mp4` for `.m4a`, a path outside the root is refused by both endpoints, a
containment near-miss (`/tmp/rootkit` against `/tmp/root`) is refused, and a foreign
`Host` header is refused.

## Out of scope

Search across files, a persistent sidebar or tree, audio and transcript side-by-side,
and rewriting raw HTML blocks. None are needed to make the existing Markdown browsable.
