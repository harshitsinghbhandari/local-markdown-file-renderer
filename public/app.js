const toolbar = document.querySelector(".toolbar");
const form = document.querySelector("#file-form");
const input = document.querySelector("#file-input");
const documentNode = document.querySelector("#document");
const statusNode = document.querySelector("#status");
const refreshButton = document.querySelector("#refresh-button");
const autoRefresh = document.querySelector("#auto-refresh");

let activeFile = "";
let timer = null;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}

function setStatus(content, variant = "neutral") {
  statusNode.className = `status ${variant}`;
  statusNode.innerHTML = content;
}

function setFileInUrl(file) {
  const url = new URL(window.location.href);
  url.searchParams.set("file", file);
  window.history.replaceState({}, "", url);
}

async function loadFile(file) {
  activeFile = file.trim();

  if (!activeFile) {
    setStatus("Paste an absolute Markdown file path or URL to render it.", "neutral");
    return;
  }

  input.value = activeFile;
  setStatus(`Reading <code>${activeFile}</code>...`, "neutral");

  try {
    const response = await fetch(`/api/render?file=${encodeURIComponent(activeFile)}`, {
      cache: "no-store"
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not render file.");
    }

    document.title = `${payload.name} - Local Markdown Renderer`;
    documentNode.innerHTML = payload.html;
    setFileInUrl(payload.file);

    const sourceDetail = payload.sourceType === "url"
      ? [
          `<span>${payload.directory}</span>`,
          payload.fromCache ? "<span>Cached copy</span>" : "<span>Fetched fresh</span>",
          payload.cachedFile ? `<span>Cache ${payload.cacheKey}</span>` : "",
          payload.warning ? `<span>${payload.warning}</span>` : ""
        ].filter(Boolean).join("")
      : `<span>${payload.directory}</span>`;

    setStatus(
      `<strong>${payload.name}</strong>${sourceDetail}<span>${formatBytes(payload.size)}</span><span>Updated ${formatTime(payload.modifiedAt)}</span>`,
      "ready"
    );
  } catch (error) {
    documentNode.innerHTML = `
      <div class="empty-state">
        <h2>Could not load this file</h2>
        <p>${error.message}</p>
        <code>${activeFile}</code>
      </div>
    `;
    setStatus(`Could not read <code>${activeFile}</code>.`, "error");
  }
}

function setAutoRefresh(enabled) {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }

  if (enabled) {
    timer = window.setInterval(() => {
      if (activeFile) loadFile(activeFile);
    }, 1000);
  }
}

let lastScrollY = window.scrollY;

window.addEventListener("scroll", () => {
  const y = window.scrollY;
  const hide = y > lastScrollY && y > 80 && !toolbar.contains(document.activeElement);

  toolbar.classList.toggle("hidden", hide);
  lastScrollY = y;
}, { passive: true });

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadFile(input.value);
});

refreshButton.addEventListener("click", () => {
  loadFile(activeFile || input.value);
});

autoRefresh.addEventListener("change", () => {
  setAutoRefresh(autoRefresh.checked);
});

async function boot() {
  const url = new URL(window.location.href);
  const urlFile = url.searchParams.get("file") || "";

  if (urlFile) {
    await loadFile(urlFile);
    return;
  }

  const response = await fetch("/api/default-file", { cache: "no-store" });
  const payload = await response.json();

  if (payload.file) {
    await loadFile(payload.file);
  } else {
    setStatus("No file selected.", "neutral");
  }
}

boot();
