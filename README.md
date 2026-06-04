# Local Markdown File Renderer

Render a Markdown file from disk in your browser. Edit the file in any editor or with an AI agent, then refresh the page to see the latest rendered version.

## Install

```sh
npm install -g @thisishsb/mdview
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

- The server binds to `127.0.0.1` by default.
- Markdown HTML is enabled, so trusted local Markdown can include inline HTML.
- Raw HTML is disabled for remote Markdown URLs because those files may be untrusted.
- This is a local tool intended for files on your own machine.
