# Local Markdown File Renderer

Render a Markdown file from disk in your browser. Edit the file in any editor or with an AI agent, then refresh the page to see the latest rendered version.

## Install

```sh
npm install -g @thisishsb/mdview
```

The same package is also published as `@theharshitsingh/mdview`:

```sh
npm install -g @theharshitsingh/mdview
```

For local development from this repo:

```sh
npm install
npm link
```

## Render a File

For day-to-day use, run the daemon:

```sh
mdview up
```

Then open:

```txt
http://127.0.0.1:5898/
```

Paste any absolute Markdown path into the UI. You can also start the daemon with a file already loaded:

```sh
mdview up /absolute/path/to/file.md --open
```

Add `--copy` to `mdview up` or `mdview url` to copy the printed URL to the clipboard:

```sh
mdview up /absolute/path/to/file.md --copy
mdview url /absolute/path/to/file.md --copy
```

## Browse a Folder

Pass a directory, or any file inside one, and mdview serves that whole tree:

```sh
mdview up ~/courses --open
```

Inside that root:

- relative links between Markdown files work, so `[schedule](schedule.md)` navigates;
- a link to a directory opens its `README.md`, `index.md` or `course.md`, or a listing
  when it has none;
- PDFs, images, audio and video open in the browser, with seeking supported;
- a filename in backticks becomes a link when a file of that name sits beside the
  document or in one of its immediate subdirectories, which makes a hand-written index
  clickable without rewriting it as links.

Paths outside the root are refused, so the daemon cannot be used to read the rest of
the disk. Widen or move the root with `--root`:

```sh
mdview up ~/courses/README.md --root ~/courses
```

## Start at Login

On macOS, install a launchd agent so the server is always up and
`http://127.0.0.1:5898/` is a stable bookmark:

```sh
mdview install ~/courses
mdview uninstall
```

`mdview status` reports an installed agent, and `mdview down` will not stop one; use
`uninstall`.

Remote Markdown URLs work too:

```sh
mdview up https://raw.githubusercontent.com/aoagents/ReverbCode/refs/heads/main/README.md --open
```

Stop the daemon:

```sh
mdview down
```

Check whether it is running:

```sh
mdview status
```

Daemon state is stored in `~/.mdview/state.json`; logs are written to `~/.mdview/mdview.log`.

Remote Markdown is cached under `~/.mdview/cache/`. Each URL gets a stable hash-based cache file, plus metadata in `~/.mdview/cache/index.json`. On refresh, mdview tries to fetch the URL again; if the network request fails and a cached copy exists, it renders the cached copy.

You can still run the server directly:

```sh
npm start -- /absolute/path/to/file.md
```

Open the URL printed by the server. It will look like:

```txt
http://127.0.0.1:5898/?file=%2Fabsolute%2Fpath%2Fto%2Ffile.md
```

You can also start the app without a file and paste an absolute Markdown path into the browser UI:

```sh
npm start
```

## How Refresh Works

The browser page stores the file path or URL in the URL. Every page load calls the local server, and the server reads the Markdown file fresh from disk or fetches the remote URL before rendering it. That means normal browser refresh works the way it does for local HTML files.

There is also an `Auto refresh` toggle if you want the page to poll the file every second while an agent is editing it.

## Notes

- The server binds to `127.0.0.1` by default, and rejects requests whose `Host` header
  is not its own address, which is what stops DNS rebinding from a hostile page.
- Reads are confined to the served root. Before directory mode any absolute path could
  be pasted into the toolbar; that now needs `--root`.
- Markdown HTML is enabled, so trusted local Markdown can include inline HTML.
- Raw HTML is disabled for remote Markdown URLs because those files may be untrusted.
- This is a local tool intended for files on your own machine.

## Release

Publishing is automated with GitHub Actions when a version tag is pushed.

One-time npm setup:

1. In npm, add GitHub Actions as a trusted publisher for `@thisishsb/mdview` and `@theharshitsingh/mdview`.
2. Use repository `harshitsinghbhandari/mdview`.
3. Use workflow filename `publish.yml`.
4. Allow the `npm publish` action.

The workflow publishes `@thisishsb/mdview` first, then republishes the same tarball as `@theharshitsingh/mdview`.

Release a new version:

```sh
npm version patch
git push
VERSION="$(node -p "require('./package.json').version")"
git push origin "v$VERSION"
```
