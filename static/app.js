(() => {
  const palette = [
    ["#637b68", "#fff"], ["#a56951", "#fff"], ["#6b7a93", "#fff"],
    ["#b9975f", "#fff"], ["#79677e", "#fff"], ["#4f7774", "#fff"],
    ["#b66f65", "#fff"], ["#7d835e", "#fff"],
  ];
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    grid: $("#book-grid"), empty: $("#empty-state"), count: $("#book-count"),
    shelfCount: $("#shelf-count"), continueSection: $("#continue-section"),
    continueCard: $("#continue-card"), search: $("#search-input"), sort: $("#sort-select"),
    file: $("#file-input"), toast: $("#toast"), backdrop: $("#modal-backdrop"),
    epub: $("#epub-view"), text: $("#text-view"), pdf: $("#pdf-view"),
    progress: $("#progress-fill"), position: $("#reader-position"), editDialog: $("#edit-dialog"),
    settings: $("#reader-settings"), contentsPanel: $("#contents-panel"), panelContent: $("#panel-content"),
    scrubber: $("#progress-scrubber"), selectionToolbar: $("#selection-toolbar"),
  };
  let books = [];
  let allBooks = [];
  let activeView = "all";
  let activeCollection = null;
  let activeTag = null;
  let availableTags = [];
  let currentBook = null;
  let rendition = null;
  let pdfDocument = null;
  let pdfPage = 1;
  let pdfZoom = 1;
  let pdfPageObserver = null;
  let pdfCountedPages = new Set();
  let textPage = 0;
  let textPages = [];
  let toastTimer;
  let progressTimer;
  let pollingConversions = false;
  let currentView = "grid";
  let searchDebounce;
  let editBookId = null;
  let dragDepth = 0;
  let readerSettings = loadSettings();
  let refreshPageKey = null;
  let refreshChapterKey = null;
  let pagesSinceRefresh = 0;
  let refreshFlashTimer;
  let panelTab = "contents";
  let savedHighlights = [];
  let savedBookmarks = [];
  let selectedRange = null;
  let locationHistory = [];
  let activeHighlightId = null;
  let sessionStartedAt = null;
  let sessionStartProgress = 0;
  let sessionWords = 0;
  let immersiveTimer;
  let speechActive = false;
  let aiConfigured = false;
  const deviceId = localStorage.getItem("pageandpine-device-id") || (() => {
    const value = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem("pageandpine-device-id", value);
    return value;
  })();

  function loadSettings() {
    const defaults = { theme: "auto", font: "serif", size: 20, lineHeight: 1.6, width: 66, align: "left", hyphenation: false, continuous: false, publisher: false, spread: "auto", refreshFlash: false, refreshEvery: 8, wpm: 230 };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("pageandpine-reader-settings") || "{}") }; }
    catch (error) { console.warn("Saved reader preferences could not be loaded.", error); return defaults; }
  }
  function saveSettings() {
    localStorage.setItem("pageandpine-reader-settings", JSON.stringify(readerSettings));
    applySettings();
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Browser storage request failed."));
    });
  }

  async function locationStore(mode, value) {
    const database = await new Promise((resolve, reject) => {
      const opening = indexedDB.open("pageandpine-reader", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("locations", { keyPath: "bookId" });
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error || new Error("Could not open local reading storage."));
    });
    try {
      const store = database.transaction("locations", mode).objectStore("locations");
      return await idbRequest(mode === "readonly" ? store.get(value) : store.put(value));
    } finally { database.close(); }
  }

  async function clearCachedLocation(bookId) {
    const database = await new Promise((resolve, reject) => {
      const opening = indexedDB.open("pageandpine-reader", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("locations", { keyPath: "bookId" });
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error || new Error("Could not open local reading storage."));
    });
    try { await idbRequest(database.transaction("locations", "readwrite").objectStore("locations").delete(bookId)); }
    finally { database.close(); }
  }
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const coverStyle = (book) => {
    const color = palette[Array.from(book.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length][0];
    return `--cover-bg:${color}`;
  };
  const shortFormat = (book) => book.format.toUpperCase();
  const formatDate = (iso) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));

  function notify(message, isError = false) {
    ui.toast.textContent = message;
    ui.toast.style.background = isError ? "#75483f" : "";
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 3400);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      let detail;
      try {
        const payload = await response.json();
        if (payload.detail) {
          detail = payload.detail;
          message = typeof detail === "string" ? detail : detail.message || message;
        }
      } catch { /* Keep the useful status message when the response is not JSON. */ }
      const error = new Error(message);
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    return response.json();
  }

  function cardMarkup(book, featured = false) {
    const pct = Math.round(book.progress * 100);
    const image = book.hasCover ? `<img class="real-cover" src="/api/books/${book.id}/cover" alt="" loading="lazy" onerror="this.remove()">` : "";
    return `<article class="book-card ${featured ? "featured-card" : ""}" data-id="${book.id}">
      <div class="cover-wrap">
        <button class="open-book" data-open="${book.id}" aria-label="Read ${escapeHtml(book.title)}" ${book.conversionStatus !== "ready" ? "disabled" : ""}>
          <span class="cover" style="${coverStyle(book)}">
            ${image}
            <span class="format-pill">${escapeHtml(shortFormat(book))}</span>
            <span class="cover-title">${escapeHtml(book.title)}</span>
            <span class="cover-author">${escapeHtml(book.author)}</span>
            ${book.conversionStatus === "converting" ? '<span class="conversion-badge">Preparing…</span>' : ""}
          </span>
        </button>
        <details class="book-menu"><summary aria-label="Book actions for ${escapeHtml(book.title)}" title="Book actions">⋯</summary>
          <div class="book-menu-panel">
            <button type="button" data-open="${book.id}" ${book.conversionStatus !== "ready" ? "disabled" : ""}>Open</button>
            <button type="button" data-edit="${book.id}">Edit details</button>
            <button type="button" data-status="${book.id}" data-next-status="${book.status === "finished" ? "reading" : "finished"}">${book.status === "finished" ? "Mark unfinished" : "Mark finished"}</button>
            <button type="button" data-favorite="${book.id}">${book.favorite ? "Remove favorite" : "Add to favorites"}</button>
            <button type="button" class="menu-delete" data-delete="${book.id}">Delete</button>
          </div>
        </details>
        <div class="book-actions">
          ${book.conversionStatus === "failed" ? `<span class="conversion-error" title="${escapeHtml(book.error || "Conversion failed")}">Could not prepare</span><button class="retry-book" data-retry="${book.id}">Retry</button>` : ""}
        </div>
      </div>
      <div class="book-info">
        <div class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</div>
        <div class="book-author">${escapeHtml(book.author)}</div>
        <div class="book-progress"><span style="width:${pct}%"></span></div><div class="book-meta"><span>${pct > 0 ? `${pct}% read` : `Added ${formatDate(book.addedAt)}`}</span><span>${escapeHtml(shortFormat(book))}</span></div>
      </div>
    </article>`;
  }

  function render() {
    const query = ui.search.value.trim().toLowerCase();
    const reading = allBooks.filter((book) => book.status === "reading");
    let visible = books;
    if (activeView === "reading") visible = visible.filter((book) => book.status === "reading");
    if (activeView === "finished") visible = visible.filter((book) => book.status === "finished");
    if (activeView === "favorites") visible = visible.filter((book) => book.favorite);
    if (activeCollection) visible = visible.filter((book) => activeCollection.bookIds.includes(book.id));
    visible = visible.filter((book) => `${book.title} ${book.author} ${book.format} ${book.series}`.toLowerCase().includes(query));
    if (ui.sort.value === "title") visible.sort((a, b) => a.title.localeCompare(b.title));
    else if (ui.sort.value === "progress") visible.sort((a, b) => b.progress - a.progress);
    else visible.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    ui.grid.innerHTML = visible.map((book) => cardMarkup(book)).join("");
    ui.count.textContent = allBooks.length;
    $("#reading-count").textContent = allBooks.filter((book) => book.status === "reading").length;
    $("#finished-count").textContent = allBooks.filter((book) => book.status === "finished").length;
    $("#favorites-count").textContent = allBooks.filter((book) => book.favorite).length;
    ui.shelfCount.textContent = `(${visible.length})`;
    ui.grid.classList.toggle("list-view", currentView === "list");
    ui.empty.hidden = visible.length !== 0;
    if (visible.length === 0) {
      $("#empty-state h3").textContent = query ? "No stories found" : activeView === "reading" ? "Nothing in progress just yet" : activeView === "finished" ? "Your next happily-ever-after is waiting" : "Your bookshelf is waiting";
      $("#empty-state p").hidden = Boolean(query);
      $("#empty-add").hidden = Boolean(query);
    } else {
      $("#empty-state p").hidden = false;
      $("#empty-add").hidden = false;
    }
    ui.continueSection.hidden = true;
    const latestOpened = [...allBooks].filter((book) => book.lastOpenedAt && book.status === "reading")
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0] || reading[0];
    $("#compact-continue").hidden = !latestOpened || activeView !== "all" || Boolean(activeTag);
    $(".welcome-row").hidden = books.length > 0;
    if (latestOpened) {
      $("#compact-title").textContent = latestOpened.title;
      $("#compact-meta").textContent = `${latestOpened.author} · ${Math.round(latestOpened.progress * 100)}% read`;
      $("#compact-cover").innerHTML = cardMarkup(latestOpened).match(/<span class="cover"[\s\S]*?<\/span>/)?.[0] || "";
      $("#compact-resume").dataset.resume = latestOpened.id;
    }
    if (reading.length) {
      const inProgress = latestOpened || reading[0];
      ui.continueCard.innerHTML = cardMarkup(inProgress, true);
      const card = ui.continueCard.querySelector(".book-card");
      card.style.maxWidth = "260px";
      card.querySelector(".cover-wrap").style.height = "145px";
      card.querySelector(".cover").style.flexDirection = "row";
      card.querySelector(".cover").style.alignItems = "center";
      card.querySelector(".cover-title").style.textAlign = "left";
      card.querySelector(".cover-author").style.display = "none";
    }
    $("#current-section").textContent = activeCollection ? activeCollection.name.toUpperCase() : activeTag ? `TAG: ${activeTag.toUpperCase()}` : activeView === "all" ? "ALL BOOKS" : activeView === "reading" ? "CURRENTLY READING" : activeView === "finished" ? "FINISHED" : "FAVORITES";
    $("#shelf-name").textContent = activeCollection ? activeCollection.name : activeTag ? `#${activeTag}` : activeView === "all" ? "Your bookshelf" : activeView === "reading" ? "Currently reading" : activeView === "finished" ? "The finished shelf" : "Your favorites";
    $("#shelf-eyebrow").textContent = activeCollection ? "A COLLECTION OF STORIES" : activeTag ? "BOOKS WITH THIS TAG" : activeView === "all" ? "A SHELF OF POSSIBILITY" : activeView === "reading" ? "STORIES IN MOTION" : activeView === "finished" ? "WELL-READ AND WELL-LOVED" : "BOOKS CLOSE TO YOUR HEART";
    $("#welcome-title").innerHTML = activeView === "all" ? "Your next chapter<br><em>starts here.</em>" : activeView === "reading" ? "Stay awhile.<br><em>Keep reading.</em>" : "Look how far<br><em>you've wandered.</em>";
    $(".welcome-copy").textContent = activeView === "all" ? "A calm little home for all the stories you love." : activeView === "reading" ? "Your stories are right where you left them." : "Every ending is a new beginning.";
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("selected", !activeTag && item.dataset.view === activeView));
    document.querySelectorAll(".tag-nav").forEach((item) => item.classList.toggle("selected", item.dataset.tagFilter === activeTag));
  }

  function renderTagNavigation() {
    const container = $("#tag-navigation");
    container.innerHTML = availableTags.map((tag) =>
      `<button class="tag-nav${tag.name === activeTag ? " selected" : ""}" type="button" data-tag-filter="${escapeHtml(tag.name)}"><span>#</span>${escapeHtml(tag.name)}<small>${tag.bookCount}</small></button>`
    ).join("");
    $("#sidebar-tags").hidden = availableTags.length === 0;
  }

  async function loadBooks() {
    const params = new URLSearchParams({ sort: ui.sort.value });
    if (ui.search.value.trim()) params.set("q", ui.search.value.trim());
    if (activeView === "reading" || activeView === "finished") params.set("status", activeView);
    if (activeView === "favorites") params.set("favorite", "true");
    if (activeTag) params.set("tag", activeTag);
    try {
      [allBooks, books, availableTags] = await Promise.all([
        request("/api/books?sort=last_opened"),
        request(`/api/books?${params}`),
        request("/api/tags"),
      ]);
      const pending = JSON.parse(localStorage.getItem("pageandpine-pending-progress") || "{}");
      let syncedPending = false;
      for (const [bookId, progress] of Object.entries(pending)) {
        try {
          await request(`/api/books/${bookId}/progress`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...progress, deviceId }),
          });
          delete pending[bookId];
          syncedPending = true;
        } catch (error) {
          if (error.status === 404) {
            delete pending[bookId];
            continue;
          }
          if (error.status !== 503) throw error;
        }
      }
      if (syncedPending) {
        [allBooks, books] = await Promise.all([
          request("/api/books?sort=last_opened"),
          request(`/api/books?${params}`),
        ]);
      }
      localStorage.setItem("pageandpine-pending-progress", JSON.stringify(pending));
      localStorage.setItem("pageandpine-library-cache", JSON.stringify(allBooks));
      localStorage.setItem("pageandpine-tags-cache", JSON.stringify(availableTags));
    } catch (error) {
      if (error.status !== 503) throw error;
      const cached = localStorage.getItem("pageandpine-library-cache");
      if (!cached) throw error;
      allBooks = JSON.parse(cached);
      availableTags = JSON.parse(localStorage.getItem("pageandpine-tags-cache") || "[]");
      books = allBooks.filter((book) => (!params.has("status") || book.status === params.get("status")) &&
        (!params.has("favorite") || String(book.favorite) === params.get("favorite")) &&
        (!params.has("q") || `${book.title} ${book.author} ${book.format} ${book.series}`.toLowerCase().includes(params.get("q").toLowerCase())));
      if (params.has("tag")) {
        books = [];
        notify("Tag filters need a connection to the library server.", true);
      } else {
        notify("Offline mode: showing cached library details. Book progress will sync when the server returns.");
      }
    }
    renderTagNavigation();
    render();
  }

  async function pollConversions() {
    if (pollingConversions || !books.some((book) => book.conversionStatus === "converting")) return;
    pollingConversions = true;
    try {
      await loadBooks();
    } catch (error) {
      notify(error.message, true);
    } finally {
      pollingConversions = false;
    }
  }

  async function uploadFiles(files) {
    let added = 0;
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      notify(`Adding “${file.name}”…`);
      try {
        await uploadWithProgress(form, file.name);
        added += 1;
      } catch (error) {
        if (error.status === 409 && error.detail?.existingBookId && window.confirm(`${error.message} Open the existing copy?`)) {
          await openSelectedBook(error.detail.existingBookId);
        } else {
          notify(`${file.name}: ${error.message}`, true);
        }
      }
    }
    await loadBooks();
    if (added) notify(added === 1 ? "Your book is on the shelf." : `${added} books added to your shelf.`);
  }

  function uploadWithProgress(form, filename) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/books");
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) notify(`Adding “${filename}”… ${Math.round(event.loaded / event.total * 100)}%`);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
          return;
        }
        let message = `Upload failed (${xhr.status}).`;
        let detail;
        try {
          const body = JSON.parse(xhr.responseText);
          detail = body.detail;
          message = typeof detail === "string" ? detail : detail?.message || message;
        } catch { /* Keep the useful status message when the body is not JSON. */ }
        const error = new Error(message);
        error.status = xhr.status;
        error.detail = detail;
        reject(error);
      });
      xhr.addEventListener("error", () => reject(new Error("Network error while uploading this book.")));
      xhr.send(form);
    });
  }

  function queueProgress(bookId, progress, locator) {
    const pending = JSON.parse(localStorage.getItem("pageandpine-pending-progress") || "{}");
    pending[bookId] = { progress, locator };
    localStorage.setItem("pageandpine-pending-progress", JSON.stringify(pending));
    const cached = JSON.parse(localStorage.getItem("pageandpine-library-cache") || "[]");
    const book = cached.find((item) => item.id === bookId);
    if (book) Object.assign(book, { progress, locator });
    localStorage.setItem("pageandpine-library-cache", JSON.stringify(cached));
  }

  function clearQueuedProgress(bookId) {
    const pending = JSON.parse(localStorage.getItem("pageandpine-pending-progress") || "{}");
    delete pending[bookId];
    localStorage.setItem("pageandpine-pending-progress", JSON.stringify(pending));
  }

  function saveProgress(progress, locator = "") {
    if (!currentBook) return;
    const normalized = Math.max(0, Math.min(1, Number(progress) || 0));
    ui.progress.style.width = `${normalized * 100}%`;
    ui.scrubber.value = String(Math.round(normalized * 1000));
    ui.scrubber.setAttribute("aria-valuetext", `${Math.round(normalized * 100)}%`);
    currentBook.progress = normalized;
    currentBook.locator = locator;
    queueProgress(currentBook.id, normalized, locator);
    clearTimeout(progressTimer);
    const bookId = currentBook.id;
    progressTimer = setTimeout(() => {
      request(`/api/books/${bookId}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress: normalized, locator, deviceId }),
      }).then(() => { clearQueuedProgress(bookId); return loadBooks(); }).catch((error) => {
        if (error.status === 503) notify("Progress saved on this device. It will sync when the server is back.");
        else notify(error.message, true);
      });
    }, 450);
  }

  function effectiveTheme() {
    if (readerSettings.theme !== "auto") return readerSettings.theme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function isEinkTheme(theme = effectiveTheme()) {
    return theme === "eink" || theme === "eink-dark";
  }

  function isContinuous() {
    return readerSettings.continuous && !isEinkTheme();
  }

  function flashReaderPage() {
    if (!isEinkTheme() || !readerSettings.refreshFlash || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const overlay = $("#reader-refresh-flash");
    overlay.classList.add("active");
    clearTimeout(refreshFlashTimer);
    refreshFlashTimer = setTimeout(() => overlay.classList.remove("active"), 120);
  }

  function trackReaderPage(pageKey, chapterKey = "") {
    const page = String(pageKey ?? "");
    const chapter = String(chapterKey ?? "");
    if (refreshPageKey === null) {
      refreshPageKey = page;
      refreshChapterKey = chapter;
      return;
    }
    const chapterChanged = Boolean(chapter && refreshChapterKey && chapter !== refreshChapterKey);
    const pageChanged = page !== refreshPageKey;
    if (pageChanged) {
      pagesSinceRefresh += 1;
      const interval = Math.max(1, Math.min(100, Number(readerSettings.refreshEvery) || 8));
      if (pagesSinceRefresh % interval === 0) flashReaderPage();
      refreshPageKey = page;
    }
    if (chapterChanged) flashReaderPage();
    if (chapter) refreshChapterKey = chapter;
  }

  function installEinkFont(contents) {
    const frameDocument = contents?.document || contents?.contents?.document;
    if (!frameDocument?.head || frameDocument.getElementById("pageandpine-eink-fonts")) return;
    const style = frameDocument.createElement("style");
    style.id = "pageandpine-eink-fonts";
    const regularFont = new URL("./fonts/literata-variable.woff2", document.baseURI).href;
    const italicFont = new URL("./fonts/literata-italic-400.woff2", document.baseURI).href;
    style.textContent = `@font-face{font-family:Literata;src:url("${regularFont}") format("woff2");font-style:normal;font-weight:400 700;font-display:swap}@font-face{font-family:Literata;src:url("${italicFont}") format("woff2");font-style:italic;font-weight:400;font-display:swap}`;
    frameDocument.head.append(style);
  }

  function applySettings() {
    const modal = $(".reader-modal");
    const theme = effectiveTheme();
    const eink = isEinkTheme(theme);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.documentElement.dataset.theme = theme;
    modal.dataset.theme = theme;
    modal.dataset.font = readerSettings.font;
    modal.style.setProperty("--reader-size", `${readerSettings.size}px`);
    modal.style.setProperty("--reader-line-height", readerSettings.lineHeight);
    modal.style.setProperty("--reader-column", `${readerSettings.width}ch`);
    modal.style.setProperty("--reader-align", readerSettings.align);
    modal.classList.toggle("continuous", isContinuous());
    if (rendition) {
      const colors = theme === "dark" || theme === "black"
        ? { color: "#e5e2d6", background: theme === "black" ? "#000" : "#242923" }
        : theme === "sepia"
          ? { color: "#514435", background: "#f1e8d6" }
          : { color: "#34352f", background: "#fbfaf6" };
      const fonts = { serif: '"Playfair Display", Georgia, serif', readable: "Georgia, serif", dyslexic: "OpenDyslexic, Arial, sans-serif", sans: "Arial, sans-serif", system: "system-ui, sans-serif" };
      if (eink) {
        const textColor = theme === "eink-dark" ? "#dedcd5" : "#161616";
        const paperColor = theme === "eink-dark" ? "#161616" : "#dedcd5";
        rendition.themes.register("eink", {
          "body, body *": {
            "font-family": '"Literata", serif !important',
            color: `${textColor} !important`,
            "background-color": "transparent !important",
            "background-image": "none !important",
            "border-color": `${textColor} !important`,
            "border-width": "2px !important",
            "border-radius": "2px !important",
            "box-shadow": "none !important",
            "text-shadow": "none !important",
            "backdrop-filter": "none !important",
            transition: "none !important",
            animation: "none !important",
            "scroll-behavior": "auto !important",
          },
          body: {
            background: `${paperColor} !important`,
            "line-height": "1.55 !important",
            "text-align": "justify !important",
            hyphens: "auto !important",
          },
          "h1, h2, h3, h4, h5, h6": {
            "font-family": '"Literata", serif !important',
            color: `${textColor} !important`,
            "font-weight": "700 !important",
          },
          a: { "text-decoration": "underline !important", color: `${textColor} !important` },
          "img, svg, video": { filter: "grayscale(1) contrast(1.15) !important" },
          "::selection": { color: `${paperColor} !important`, "background-color": `${textColor} !important` },
        });
        rendition.themes.select("eink");
        rendition.getContents().forEach(installEinkFont);
      } else if (readerSettings.publisher) {
        rendition.themes.register("publisher", {});
        rendition.themes.select("publisher");
      } else {
        rendition.themes.default({
          body: { "font-family": fonts[readerSettings.font] || fonts.serif, color: colors.color, background: colors.background, "font-size": `${readerSettings.size}px`, "line-height": String(readerSettings.lineHeight), "text-align": readerSettings.align, "hyphens": readerSettings.hyphenation ? "auto" : "manual", "max-width": `${readerSettings.width}ch`, margin: "0 auto" },
          p: { "line-height": String(readerSettings.lineHeight), "text-align": readerSettings.align },
          h1: { "font-family": fonts[readerSettings.font] || fonts.serif, color: colors.color },
          h2: { "font-family": fonts[readerSettings.font] || fonts.serif, color: colors.color },
          h3: { "font-family": fonts[readerSettings.font] || fonts.serif, color: colors.color },
        });
      }
      rendition.themes.override("font-size", `${readerSettings.size}px`, true);
      rendition.flow(isContinuous() ? "scrolled-doc" : "paginated");
      rendition.spread(eink || readerSettings.spread === "single" ? "none" : readerSettings.spread === "double" ? "always" : "auto");
    }
    if (!ui.text.hidden) {
      ui.text.style.fontSize = `${readerSettings.size}px`;
      ui.text.style.lineHeight = String(readerSettings.lineHeight);
      ui.text.style.textAlign = readerSettings.align;
    }
    if (pdfDocument) {
      $("#pdf-view").classList.toggle("pdf-dark", theme === "dark" || theme === "black" || theme === "eink-dark");
      $("#pdf-view").classList.toggle("pdf-eink", eink);
    }
    if (pdfDocument) {
      $("#pdf-view").classList.toggle("pdf-continuous", isContinuous());
      $("#reader-canvas").classList.toggle("pdf-continuous", isContinuous());
    }
    $("#setting-theme").value = readerSettings.theme;
    $("#setting-font").value = readerSettings.font;
    $("#setting-size").value = readerSettings.size;
    $("#setting-size-label").textContent = `${readerSettings.size} px`;
    $("#setting-line-height").value = readerSettings.lineHeight;
    $("#setting-line-label").textContent = readerSettings.lineHeight;
    $("#setting-width").value = readerSettings.width;
    $("#setting-width-label").textContent = `${readerSettings.width}ch`;
    $("#setting-align").value = readerSettings.align;
    $("#setting-hyphenation").checked = readerSettings.hyphenation;
    $("#setting-continuous").checked = isContinuous();
    $("#setting-continuous").disabled = eink;
    $("#setting-publisher").checked = readerSettings.publisher;
    $("#setting-immersive").checked = Boolean(readerSettings.immersive);
    $("#setting-spread").value = readerSettings.spread;
    $("#setting-spread").disabled = eink;
    $("#setting-refresh-flash").checked = Boolean(readerSettings.refreshFlash);
    $("#setting-refresh-flash").disabled = reducedMotion;
    $("#setting-refresh-every").value = Math.max(1, Math.min(100, Number(readerSettings.refreshEvery) || 8));
    $("#setting-refresh-every").disabled = !readerSettings.refreshFlash || reducedMotion;
    if (!eink) $("#reader-refresh-flash").classList.remove("active");
  }

  function resetReader() {
    if (rendition) {
      rendition.destroy();
      rendition = null;
    }
    pdfDocument = null;
    pdfCountedPages = new Set();
    refreshPageKey = null;
    refreshChapterKey = null;
    pagesSinceRefresh = 0;
    clearTimeout(refreshFlashTimer);
    $("#reader-refresh-flash").classList.remove("active");
    pdfPageObserver?.disconnect();
    pdfPageObserver = null;
    $("#pdf-view").classList.remove("pdf-continuous");
    $("#reader-canvas").classList.remove("pdf-continuous");
    $("#pdf-single").hidden = false;
    $("#pdf-continuous").hidden = true;
    $("#pdf-continuous").replaceChildren();
    $("#chapter-markers").replaceChildren();
    ui.epub.hidden = true;
    ui.text.hidden = true;
    ui.pdf.hidden = true;
    ui.text.replaceChildren();
    ui.settings.hidden = true;
    ui.contentsPanel.hidden = true;
    ui.selectionToolbar.hidden = true;
    $("#chapter-summary").hidden = true;
    $("#pdf-tools").hidden = true;
    $("#contents-button").hidden = true;
    $("#contents-button").innerHTML = "CONTENTS <span>⌄</span>";
    $("#previous-page").hidden = true;
    $("#next-page").hidden = true;
  }

  async function openBook(book) {
    currentBook = book;
    resetReader();
    locationHistory = [];
    $("#reader-history-back").hidden = true;
    sessionStartedAt = new Date();
    sessionStartProgress = book.progress || 0;
    sessionWords = 0;
    ui.backdrop.hidden = false;
    document.body.style.overflow = "hidden";
    $("#reader-title").textContent = book.title;
    $("#reader-author").textContent = book.author;
    $("#reader-position").textContent = "Opening your book…";
    ui.progress.style.width = `${book.progress * 100}%`;
    ui.scrubber.value = String(Math.round(book.progress * 1000));
    applySettings();
    try {
      const deviceProgress = await request(`/api/books/${book.id}/device-progress?device_id=${encodeURIComponent(deviceId)}`);
      if (deviceProgress.otherDeviceAhead && deviceProgress.otherDevice?.progress > book.progress) {
        const ahead = deviceProgress.otherDevice;
        if (window.confirm(`This book is farther along on another device (${Math.round(ahead.progress * 100)}%). Resume there?`)) {
          book.progress = ahead.progress;
          book.locator = ahead.locator;
        }
      }
    } catch (error) { notify(`Could not check reading progress on your other devices: ${error.message}`, true); }
    const url = `/api/books/${book.id}/file`;
    const format = book.readerFormat;
    $("#chapter-summary").hidden = !aiConfigured || format !== "epub";
    if (format === "epub") {
      if (!window.ePub) throw new Error("The EPUB reader did not load. Check your internet connection and reload.");
      ui.epub.hidden = false;
      $("#previous-page").hidden = false;
      $("#next-page").hidden = false;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not open the EPUB file.");
      const epubBytes = await response.arrayBuffer();
      const epubBook = window.ePub(epubBytes);
      await epubBook.ready;
      rendition = epubBook.renderTo(ui.epub, { width: "100%", height: "100%", flow: isContinuous() ? "scrolled-doc" : "paginated", spread: "none" });
      applySettings();
      const updateEpubPageLabel = () => {
        if (!isEinkTheme() || !epubBook.locations.length()) return;
        const location = rendition.currentLocation();
        const percentage = location?.start?.percentage || 0;
        const totalPages = epubBook.locations.length();
        const locationPage = Number(location?.start?.location);
        const pageNumber = Number.isFinite(locationPage)
          ? Math.max(1, Math.min(totalPages, locationPage + 1))
          : Math.max(1, Math.round(percentage * (totalPages - 1)) + 1);
        ui.position.textContent = `Page ${pageNumber} of ${totalPages}`;
      };
      rendition.on("relocated", (location) => {
        const percentage = location?.start?.percentage || 0;
        const chapter = location?.start?.href ? epubBook.navigation?.get?.(location.start.href)?.label : "";
        const currentLocator = location?.start?.cfi || "";
        const totalPages = Math.max(1, epubBook.locations.length());
        const locationPage = Number(location?.start?.location);
        const pageNumber = Number.isFinite(locationPage)
          ? Math.max(1, Math.min(totalPages, locationPage + 1))
          : Math.max(1, Math.round(percentage * (totalPages - 1)) + 1);
        trackReaderPage(locationPage, location?.start?.href);
        if (currentBook.locator && currentBook.locator !== currentLocator) {
          locationHistory.push(currentBook.locator);
          $("#reader-history-back").hidden = false;
        }
        const totalWords = Math.max(1, (epubBook.spine?.spineItems?.length || 1) * 1800);
        const minutes = Math.ceil(totalWords * (1 - percentage) / (readerSettings.wpm || 230));
        const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
        ui.position.textContent = isEinkTheme()
          ? `Page ${pageNumber} of ${totalPages}`
          : `${chapter || "Reading"} · ${Math.round(percentage * 100)}% · ${remaining} left`;
        saveProgress(percentage, location?.start?.cfi || "");
        const content = rendition.getContents().find((item) => item.document?.body);
        if (content?.document?.body) sessionWords += content.document.body.innerText.trim().split(/\s+/).length;
      });
      rendition.on("selected", (cfiRange, contents) => {
        const text = contents.window.getSelection()?.toString().trim();
        if (!text) return;
        selectedRange = { locator: cfiRange, text };
        ui.selectionToolbar.hidden = false;
      });
      rendition.on("rendered", (section, contents) => {
        updateContents();
        renderChapterMarkers();
        restoreHighlights().catch((error) => notify(error.message, true));
        const frameDocument = contents?.document || contents?.contents?.document;
        if (isEinkTheme()) installEinkFont(contents);
        frameDocument?.querySelectorAll('a[href]').forEach((link) => {
          if (/note|footnote|endnote/i.test(link.getAttribute("epub:type") || link.getAttribute("role") || "") && link.getAttribute("href")?.startsWith("#")) {
            link.addEventListener("click", (event) => {
              const target = frameDocument.getElementById(decodeURIComponent(link.getAttribute("href").slice(1)));
              if (!target) return;
              event.preventDefault();
              showFeature("Footnote", `<div class="feature-dialog-content">${escapeHtml(target.textContent.trim())}</div>`);
            });
          }
        });
      });
      await rendition.display(book.locator || undefined);
      renderChapterMarkers();
      locationStore("readonly", book.id).then((cached) => {
        if (cached?.locations) {
          epubBook.locations.load(cached.locations);
          updateEpubPageLabel();
          return;
        }
        return epubBook.locations.generate(1024).then(async () => {
          await locationStore("readwrite", { bookId: book.id, locations: epubBook.locations.save() });
          updateEpubPageLabel();
        });
      }).catch((error) => notify(`Precise page locations could not be cached: ${error.message}`, true));
      updateContents();
      $("#contents-button").hidden = false;
      await loadAnnotations();
    } else if (format === "pdf") {
      if (!window.pdfjsLib) throw new Error("The PDF reader did not load. Check your internet connection and reload.");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";
      ui.pdf.hidden = false;
      $("#pdf-tools").hidden = false;
      $("#previous-page").hidden = false;
      $("#next-page").hidden = false;
      const bytes = await fetch(url).then((response) => {
        if (!response.ok) throw new Error("Could not open the PDF file.");
        return response.arrayBuffer();
      });
      pdfDocument = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      applySettings();
      pdfPage = Math.max(1, Math.round((book.progress || 0) * pdfDocument.numPages) || 1);
      $("#pdf-page-total").textContent = `/ ${pdfDocument.numPages}`;
      $("#pdf-page-input").max = pdfDocument.numPages;
      await renderPdfPage();
      $("#contents-button").hidden = false;
      $("#contents-button").innerHTML = `PAGE <span id="pdf-page-number">${pdfPage}</span> / ${pdfDocument.numPages}`;
    } else {
      ui.text.hidden = false;
      $("#previous-page").hidden = false;
      $("#next-page").hidden = false;
      let text;
      try {
        const response = await request(`/api/books/${book.id}/text`);
        text = response.text;
      } catch (error) {
        if (error.status !== 503) throw error;
        const file = await fetch(url);
        if (!file.ok) throw new Error("Could not open this cached book while offline.");
        text = await file.text();
        if (["html", "htm"].includes(format)) {
          const documentText = new DOMParser().parseFromString(text, "text/html");
          documentText.querySelectorAll("script,style,head,iframe,object").forEach((node) => node.remove());
          text = documentText.body.textContent || "";
        }
      }
      const words = text.split(/\s+/);
      const perPage = 520;
      textPages = [];
      for (let i = 0; i < words.length; i += perPage) textPages.push(words.slice(i, i + perPage).join(" "));
      textPage = Math.min(textPages.length - 1, Math.floor((book.progress || 0) * textPages.length));
      renderTextPage();
    }
    if (format !== "epub") await loadAnnotations();
  }

  function pdfScale(page) {
    const baseViewport = page.getViewport({ scale: 1 });
    const widthScale = Math.min(1.65, Math.max(1, (ui.pdf.clientWidth - 20) / baseViewport.width));
    const pageScale = Math.max(0.1, Math.min(widthScale, (ui.pdf.clientHeight - 20) / baseViewport.height));
    const selectedFit = $("#pdf-fit").value;
    return (selectedFit === "actual" ? 1 : selectedFit === "page" ? pageScale : widthScale) * pdfZoom;
  }

  async function drawPdfPage(pageNumber, canvas, textLayer) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: pdfScale(page) });
    const context = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width * window.devicePixelRatio);
    canvas.height = Math.floor(viewport.height * window.devicePixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    await page.render({ canvasContext: context, viewport, transform: window.devicePixelRatio !== 1 ? [window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0] : null }).promise;
    textLayer.replaceChildren();
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty("--scale-factor", String(viewport.scale));
    const textContent = await page.getTextContent();
    if (!pdfCountedPages.has(pageNumber)) {
      sessionWords += textContent.items.filter((item) => item.str).length;
      pdfCountedPages.add(pageNumber);
    }
    if (window.pdfjsLib.renderTextLayer) {
      await window.pdfjsLib.renderTextLayer({ textContent, container: textLayer, viewport, textDivs: [] }).promise;
    }
    return viewport;
  }

  function updatePdfPosition() {
    const progress = pdfPage / pdfDocument.numPages;
    const minutes = Math.ceil((pdfDocument.numPages - pdfPage) * 500 / (readerSettings.wpm || 230));
    const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    $("#pdf-page-input").value = pdfPage;
    $("#reader-position").textContent = isEinkTheme()
      ? `Page ${pdfPage} of ${pdfDocument.numPages}`
      : `Page ${pdfPage} of ${pdfDocument.numPages} · ${Math.round(progress * 100)}% · ${remaining} left`;
    trackReaderPage(pdfPage, "pdf");
    const pageNumber = $("#pdf-page-number");
    if (pageNumber) pageNumber.textContent = pdfPage;
    saveProgress(progress, String(pdfPage));
  }

  async function renderPdfContinuous(force = false) {
    const container = $("#pdf-continuous");
    $("#pdf-view").classList.add("pdf-continuous");
    $("#reader-canvas").classList.add("pdf-continuous");
    $("#pdf-single").hidden = true;
    container.hidden = false;
    pdfPageObserver?.disconnect();
    if (force || !container.childElementCount) {
      container.replaceChildren();
      for (let number = 1; number <= pdfDocument.numPages; number += 1) {
        const wrapper = document.createElement("div");
        wrapper.className = "pdf-page";
        wrapper.dataset.pdfPage = String(number);
        wrapper.style.width = "100%";
        wrapper.style.height = `${Math.max(600, ui.pdf.clientHeight)}px`;
        const canvas = document.createElement("canvas");
        const textLayer = document.createElement("div");
        textLayer.className = "textLayer";
        wrapper.append(canvas, textLayer);
        container.append(wrapper);
      }
    }
    pdfPageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.dataset.rendered) continue;
        entry.target.dataset.rendered = "loading";
        const number = Number(entry.target.dataset.pdfPage);
        drawPdfPage(number, entry.target.querySelector("canvas"), entry.target.querySelector(".textLayer"))
          .then((viewport) => {
            entry.target.style.width = `${viewport.width}px`;
            entry.target.style.height = `${viewport.height}px`;
            entry.target.dataset.rendered = "true";
          })
          .catch((error) => {
            delete entry.target.dataset.rendered;
            notify(`Could not render PDF page ${number}: ${error.message}`, true);
          });
      }
      const rootBounds = $("#reader-canvas").getBoundingClientRect();
      const center = rootBounds.top + rootBounds.height / 2;
      const visiblePages = [...container.children]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.bottom > rootBounds.top && bounds.top < rootBounds.bottom;
        })
        .sort((left, right) => Math.abs(left.getBoundingClientRect().top + left.getBoundingClientRect().height / 2 - center)
          - Math.abs(right.getBoundingClientRect().top + right.getBoundingClientRect().height / 2 - center));
      if (visiblePages.length) {
        pdfPage = Number(visiblePages[0].dataset.pdfPage);
        updatePdfPosition();
      }
    }, { root: $("#reader-canvas"), rootMargin: "300px 0px", threshold: 0.15 });
    for (const page of container.children) pdfPageObserver.observe(page);
    const current = container.querySelector(`[data-pdf-page="${pdfPage}"]`);
    current?.scrollIntoView({ block: "start" });
  }

  async function renderPdfPage() {
    if (!pdfDocument) return;
    if (isContinuous()) {
      $("#pdf-view").classList.add("pdf-continuous");
      $("#reader-canvas").classList.add("pdf-continuous");
      $("#pdf-single").hidden = true;
      $("#pdf-continuous").hidden = false;
      if (!$("#pdf-continuous").childElementCount) await renderPdfContinuous();
      $("#pdf-continuous").querySelector(`[data-pdf-page="${pdfPage}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      updatePdfPosition();
      return;
    }
    pdfPageObserver?.disconnect();
    $("#pdf-view").classList.remove("pdf-continuous");
    $("#reader-canvas").classList.remove("pdf-continuous");
    $("#pdf-single").hidden = false;
    $("#pdf-continuous").hidden = true;
    await drawPdfPage(pdfPage, $("#pdf-canvas"), $("#pdf-text-layer"));
    updatePdfPosition();
  }

  function renderTextPage() {
    if (!textPages.length) {
      ui.text.textContent = "This book is empty.";
      return;
    }
    ui.text.textContent = textPages[textPage];
    applySettings();
    ui.text.scrollTop = 0;
    const percentage = (textPage + 1) / textPages.length;
    const minutes = Math.ceil((textPages.length - textPage - 1) * 520 / (readerSettings.wpm || 230));
    ui.position.textContent = isEinkTheme()
      ? `Page ${textPage + 1} of ${textPages.length}`
      : `${textPage + 1} of ${textPages.length} · ${Math.round(percentage * 100)}% · ${minutes}m left`;
    trackReaderPage(textPage + 1, "text");
    saveProgress((textPage + 1) / textPages.length, String(textPage + 1));
    sessionWords += textPages[textPage].trim().split(/\s+/).length;
  }

  function updateContents() {
    const navigation = rendition?.book?.navigation?.toc || [];
    if (panelTab !== "contents") return;
    const currentHref = rendition?.currentLocation?.()?.start?.href || "";
    ui.panelContent.innerHTML = navigation.length
      ? navigation.map((entry) => `<button class="contents-item ${currentHref && entry.href === currentHref ? "current-chapter" : ""}" data-href="${escapeHtml(entry.href)}">${escapeHtml(entry.label.trim())}</button>`).join("")
      : "<p>No table of contents available for this book.</p>";
  }

  function renderChapterMarkers() {
    const container = $("#chapter-markers");
    container.replaceChildren();
    const spine = rendition?.book?.spine;
    if (!spine?.spineItems?.length) return;
    const entries = [];
    const collect = (items) => items.forEach((item) => {
      entries.push(item);
      if (item.subitems?.length) collect(item.subitems);
    });
    collect(rendition.book.navigation?.toc || []);
    for (const entry of entries) {
      const section = spine.get(entry.href.split("#")[0]);
      if (!section) continue;
      const progress = section.index / spine.spineItems.length;
      const marker = document.createElement("span");
      marker.className = "chapter-marker";
      marker.style.left = `${Math.min(100, Math.max(0, progress * 100))}%`;
      marker.dataset.progress = String(progress);
      marker.dataset.chapter = entry.label.trim();
      marker.title = entry.label.trim();
      marker.setAttribute("role", "img");
      marker.setAttribute("aria-label", `Chapter: ${entry.label.trim()}`);
      container.append(marker);
    }
  }

  async function loadAnnotations() {
    if (!currentBook) return;
    const cacheKey = `pageandpine-annotations-${currentBook.id}`;
    try {
      [savedHighlights, savedBookmarks] = await Promise.all([
        request(`/api/books/${currentBook.id}/highlights`),
        request(`/api/books/${currentBook.id}/bookmarks`),
      ]);
      localStorage.setItem(cacheKey, JSON.stringify({ highlights: savedHighlights, bookmarks: savedBookmarks }));
    } catch (error) {
      const cached = localStorage.getItem(cacheKey);
      if (error.status !== 503) throw error;
      if (cached) {
        const annotations = JSON.parse(cached);
        savedHighlights = annotations.highlights;
        savedBookmarks = annotations.bookmarks;
      } else {
        savedHighlights = [];
        savedBookmarks = [];
      }
    }
    await restoreHighlights();
  }

  async function restoreHighlights() {
    if (!rendition || !savedHighlights.length) return;
    for (const highlight of savedHighlights) {
      rendition.annotations.remove(highlight.locator, "highlight");
      rendition.annotations.highlight(highlight.locator, { fill: highlight.color, "fill-opacity": "0.38" }, () => editHighlight(highlight));
    }
  }

  async function createHighlight(color, note = "") {
    if (!currentBook || !selectedRange) return;
    const highlight = await request(`/api/books/${currentBook.id}/highlights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locator: selectedRange.locator,
        text: selectedRange.text,
        color,
        note,
        progress: currentBook.progress || 0,
      }),
    });
    savedHighlights.push(highlight);
    if (rendition) rendition.annotations.highlight(highlight.locator, { fill: color, "fill-opacity": "0.38" }, () => editHighlight(highlight));
    ui.selectionToolbar.hidden = true;
    notify(note ? "Note saved with your highlight." : "Passage highlighted.");
  }

  function editHighlight(highlight) {
    activeHighlightId = highlight.id;
    const form = $("#annotation-form");
    form.elements.note.value = highlight.note || "";
    form.elements.color.value = highlight.color;
    $("#annotation-dialog").showModal();
  }

  $("#annotation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeHighlightId) return;
    const form = event.currentTarget;
    try {
      const updated = await request(`/api/highlights/${activeHighlightId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: form.elements.note.value, color: form.elements.color.value }),
      });
      savedHighlights = savedHighlights.map((item) => item.id === updated.id ? updated : item);
      await restoreHighlights();
      renderPanel();
      $("#annotation-dialog").close();
    } catch (error) { notify(error.message, true); }
  });
  $("#delete-highlight").addEventListener("click", async () => {
    if (!activeHighlightId || !window.confirm("Delete this highlight and its note?")) return;
    try {
      await request(`/api/highlights/${activeHighlightId}`, { method: "DELETE" });
      savedHighlights = savedHighlights.filter((item) => item.id !== activeHighlightId);
      await restoreHighlights();
      renderPanel();
      $("#annotation-dialog").close();
    } catch (error) { notify(error.message, true); }
  });
  $("#annotation-dialog").addEventListener("close", () => { activeHighlightId = null; });
  document.querySelector("[data-close-annotation]").addEventListener("click", () => $("#annotation-dialog").close());

  function renderPanel() {
    document.querySelectorAll("[data-panel-tab]").forEach((tab) => tab.classList.toggle("selected", tab.dataset.panelTab === panelTab));
    if (panelTab === "contents") { updateContents(); return; }
    if (panelTab === "bookmarks") {
      ui.panelContent.innerHTML = `<button class="panel-action" id="add-bookmark">＋ Bookmark this page</button>${savedBookmarks.length
        ? savedBookmarks.map((item) => `<div class="annotation-item"><button data-bookmark="${escapeHtml(item.id)}" data-locator="${escapeHtml(item.locator)}">${escapeHtml(item.label || item.chapter || `Page ${Math.round(item.progress * 100)}%`)}</button><button aria-label="Edit bookmark label" data-edit-bookmark="${escapeHtml(item.id)}">✎</button><button aria-label="Remove bookmark" data-remove-bookmark="${escapeHtml(item.id)}">×</button></div>`).join("")
        : "<p>No bookmarks yet.</p>"}`;
      return;
    }
    if (panelTab === "highlights") {
      ui.panelContent.innerHTML = `<div class="export-links"><a href="/api/books/${currentBook.id}/highlights.md" download>Export Markdown</a><a href="/api/books/${currentBook.id}/highlights.json" download>Export JSON</a></div>${savedHighlights.length
        ? savedHighlights.map((item) => `<div class="annotation-item"><button data-highlight-locator="${escapeHtml(item.locator)}"><span class="highlight-swatch ${escapeHtml(item.color)}"></span>${escapeHtml(item.selected_text.slice(0, 180))}${item.note ? `<small>${escapeHtml(item.note)}</small>` : ""}</button><button aria-label="Edit highlight" data-edit-highlight="${escapeHtml(item.id)}">✎</button><button aria-label="Delete highlight" data-remove-highlight="${escapeHtml(item.id)}">×</button></div>`).join("")
        : "<p>No highlights or notes yet.</p>"}`;
      return;
    }
    ui.panelContent.innerHTML = '<form id="reader-search-form"><label>Search this book<input name="query" type="search" required maxlength="120" placeholder="Words or phrase"></label><button class="primary-button" type="submit">Search</button></form><div id="reader-search-results"></div>';
  }

  async function searchInBook(query) {
    const resultArea = $("#reader-search-results");
    resultArea.textContent = "Searching…";
    const results = [];
    if (rendition?.book?.spine?.each) {
      for (const section of rendition.book.spine.spineItems) {
        try {
          await section.load(rendition.book.load.bind(rendition.book));
          const matches = section.find(query) || [];
          for (const match of matches.slice(0, 20)) results.push({ text: match.excerpt || query, locator: match.cfi, chapter: section.href });
          section.unload();
        } catch (error) { console.warn(`Could not search EPUB section ${section.href}.`, error); }
      }
    } else if (pdfDocument) {
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => item.str || "").join(" ");
        const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if (index >= 0) results.push({ text: text.slice(Math.max(0, index - 70), index + query.length + 90), page: pageNumber });
      }
    } else {
      textPages.forEach((text, index) => {
        const match = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if (match >= 0) results.push({ text: text.slice(Math.max(0, match - 70), match + query.length + 90), page: index + 1 });
      });
    }
    resultArea.innerHTML = results.length
      ? results.map((item, index) => `<button class="search-result" data-search-index="${index}"><span>${escapeHtml(item.chapter || (item.page ? `Page ${item.page}` : "Match"))}</span><small>${escapeHtml(item.text)}</small></button>`).join("")
      : "<p>No matches found.</p>";
    resultArea.searchResults = results;
  }

  function showReaderPosition() {
    const modal = $(".reader-modal");
    modal.classList.remove("immersive-hidden");
    clearTimeout(immersiveTimer);
    if (readerSettings.immersive) immersiveTimer = setTimeout(() => modal.classList.add("immersive-hidden"), 3000);
  }

  async function closeReader() {
    clearTimeout(progressTimer);
    if (currentBook) {
      try {
        await request(`/api/books/${currentBook.id}/progress`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ progress: currentBook.progress, locator: currentBook.locator || "", deviceId }),
        });
        clearQueuedProgress(currentBook.id);
        const durationSeconds = Math.max(1, Math.floor((Date.now() - sessionStartedAt.getTime()) / 1000));
        await request(`/api/books/${currentBook.id}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startedAt: sessionStartedAt.toISOString(),
            durationSeconds,
            progressStart: sessionStartProgress,
            progressEnd: currentBook.progress || 0,
          }),
        });
        if (durationSeconds >= 60 && sessionWords > 0) {
          readerSettings.wpm = Math.max(80, Math.min(800, Math.round(sessionWords / (durationSeconds / 60))));
          localStorage.setItem("pageandpine-reader-settings", JSON.stringify(readerSettings));
        }
      } catch (error) { notify(error.message, true); }
    }
    speechActive = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    clearTimeout(immersiveTimer);
    ui.backdrop.hidden = true;
    document.body.style.overflow = "";
    resetReader();
    currentBook = null;
    await loadBooks();
  }

  function handleBookCardClick(event) {
    const editButton = event.target.closest("[data-edit]");
    if (editButton) {
      event.stopPropagation();
      showEditDialog(editButton.dataset.edit);
      closeBookMenus();
      return;
    }
    const statusButton = event.target.closest("[data-status]");
    if (statusButton) {
      event.stopPropagation();
      updateBook(statusButton.dataset.status, { status: statusButton.dataset.nextStatus });
      closeBookMenus();
      return;
    }
    const favoriteButton = event.target.closest("[data-favorite]");
    if (favoriteButton) {
      event.stopPropagation();
      const book = allBooks.find((item) => item.id === favoriteButton.dataset.favorite);
      if (book) updateBook(book.id, { favorite: !book.favorite });
      closeBookMenus();
      return;
    }
    const retryButton = event.target.closest("[data-retry]");
    if (retryButton) {
      event.stopPropagation();
      retryConversion(retryButton.dataset.retry);
      return;
    }
    const removeButton = event.target.closest("[data-delete]");
    if (removeButton) {
      event.stopPropagation();
      removeBook(removeButton.dataset.delete);
      return;
    }
    const openButton = event.target.closest("[data-open]");
    if (openButton) openSelectedBook(openButton.dataset.open);
  }
  ui.grid.addEventListener("click", handleBookCardClick);
  ui.continueCard.addEventListener("click", handleBookCardClick);
  ui.grid.addEventListener("toggle", (event) => {
    if (event.target.matches(".book-menu") && event.target.open) {
      document.querySelectorAll(".book-menu[open]").forEach((menu) => {
        if (menu !== event.target) menu.open = false;
      });
    }
  }, true);

  function closeBookMenus() {
    document.querySelectorAll(".book-menu[open]").forEach((menu) => { menu.open = false; });
  }

  async function updateBook(id, patch) {
    try {
      await request(`/api/books/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await loadBooks();
      notify("Book details updated.");
    } catch (error) { notify(error.message, true); }
  }

  async function showEditDialog(id) {
    const book = allBooks.find((item) => item.id === id);
    if (!book) return;
    editBookId = id;
    const form = $("#edit-form");
    form.elements.title.value = book.title;
    form.elements.author.value = book.author;
    form.elements.series.value = book.series || "";
    try { form.elements.tags.value = (await request(`/api/books/${id}/tags`)).join(", "); }
    catch (error) { notify(error.message, true); return; }
    form.elements.status.value = book.status;
    form.elements.favorite.checked = book.favorite;
    ui.editDialog.showModal();
    form.elements.title.focus();
  }

  $("#edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editBookId) return;
    const form = event.currentTarget;
    const patch = {
      title: form.elements.title.value.trim(),
      author: form.elements.author.value.trim(),
      series: form.elements.series.value.trim(),
      status: form.elements.status.value,
      favorite: form.elements.favorite.checked,
    };
    try {
      await request(`/api/books/${editBookId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await request(`/api/books/${editBookId}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: form.elements.tags.value.split(",").map((tag) => tag.trim()).filter(Boolean) }),
      });
      ui.editDialog.close();
      editBookId = null;
      await loadBooks();
      notify("Book details updated.");
    } catch (error) { notify(error.message, true); }
  });
  $("#close-edit").addEventListener("click", () => ui.editDialog.close());
  $("#cancel-edit").addEventListener("click", () => ui.editDialog.close());
  ui.editDialog.addEventListener("close", () => { editBookId = null; });

  async function retryConversion(id) {
    try {
      await request(`/api/books/${id}/retry`, { method: "POST" });
      await loadBooks();
      notify("Preparing your book…");
    } catch (error) { notify(error.message, true); }
  }

  async function openSelectedBook(id) {
    const book = books.find((item) => item.id === id) || allBooks.find((item) => item.id === id);
    if (!book) return;
    try { await openBook(book); } catch (error) {
      ui.backdrop.hidden = true;
      document.body.style.overflow = "";
      resetReader();
      currentBook = null;
      notify(error.message, true);
    }
  }

  async function removeBook(id) {
    const book = allBooks.find((item) => item.id === id);
    if (!book || !window.confirm(`Delete “${book.title}” and its file from your library?`)) return;
    try {
      await request(`/api/books/${id}`, { method: "DELETE" });
      navigator.serviceWorker?.controller?.postMessage({ type: "delete-book", bookId: id });
      localStorage.removeItem(`pageandpine-annotations-${id}`);
      await clearCachedLocation(id).catch((error) => console.warn("Could not clear cached EPUB locations.", error));
      await loadBooks();
      notify("Book deleted from your library.");
    } catch (error) { notify(error.message, true); }
  }

  function showFeature(title, content) {
    $("#feature-title").textContent = title;
    $("#feature-content").innerHTML = content;
    $("#feature-dialog").showModal();
  }

  function showFeatureForm(title, markup, onSubmit) {
    showFeature(title, `<div class="feature-dialog-content">${markup}</div>`);
    $("#feature-content form").addEventListener("submit", (event) => {
      event.preventDefault();
      onSubmit(new FormData(event.currentTarget));
    });
    $("#feature-content").querySelector("input, select, textarea")?.focus();
  }

  async function showCollections() {
    const collections = await request("/api/collections");
    activeCollection = null;
    activeTag = null;
    renderTagNavigation();
    $(".welcome-row").hidden = true;
    $("#shelf-name").textContent = "Your collections";
    $("#shelf-eyebrow").textContent = "A HOME FOR EVERY KIND OF STORY";
    $("#current-section").textContent = "COLLECTIONS";
    ui.shelfCount.textContent = `(${collections.length})`;
    ui.grid.innerHTML = `<button class="collection-card new-collection" id="new-collection">＋ Create collection</button>${collections.map((item) =>
      `<article class="collection-card"><h3>${escapeHtml(item.name)}</h3><p>${Number(item.book_count)} books</p><div><button data-collection-open="${escapeHtml(item.id)}">Open</button><button data-collection-add="${escapeHtml(item.id)}">Add books</button><button data-collection-delete="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.name)}">Delete</button></div></article>`
    ).join("")}`;
    ui.empty.hidden = true;
  }

  async function showReadingStats() {
    const stats = await request("/api/stats");
    const daily = stats.daily || [];
    const max = Math.max(1, ...daily.map((day) => Number(day.seconds) || 0));
    const bars = daily.slice(-30).map((day) =>
      `<div class="stats-day" title="${escapeHtml(day.day)}: ${Math.round(day.seconds / 60)} minutes"><i style="height:${Math.max(3, day.seconds / max * 100)}%"></i><span>${escapeHtml(day.day.slice(5))}</span></div>`
    ).join("");
    showFeature("Your reading life", `<div class="stats-cards"><div><strong>${stats.booksFinished}</strong><span>books finished</span></div><div><strong>${Math.round(stats.secondsRead / 3600 * 10) / 10}</strong><span>hours read</span></div><div><strong>${stats.streakDays}</strong><span>day streak</span></div></div><h3>Recent reading</h3><div class="stats-chart">${bars || "<p>No reading sessions recorded yet.</p>"}</div><p><a href="/opds" target="_blank" rel="noopener">Open OPDS catalog</a></p><button class="icon-button" id="logout-button">Sign out</button>`);
    $("#logout-button")?.addEventListener("click", async () => {
      try { await request("/api/auth/logout", { method: "POST" }); $("#feature-dialog").close(); window.location.reload(); }
      catch (error) { notify(error.message, true); }
    });
  }

  async function initializeAuth() {
    const status = await request("/api/auth/status");
    navigator.serviceWorker?.controller?.postMessage({ type: "set-auth-required", required: status.enabled });
    if (!status.enabled || status.authenticated) return true;
    const dialog = $("#auth-dialog");
    dialog.showModal();
    return false;
  }

  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: form.elements.pin.value }),
      });
      $("#auth-dialog").close();
      form.reset();
      await loadBooks();
    } catch (error) {
      $("#auth-error").textContent = error.message;
      $("#auth-error").hidden = false;
      form.elements.pin.select();
    }
  });

  $("#feature-dialog").addEventListener("click", (event) => {
    if (event.target.closest("[data-close-feature]")) $("#feature-dialog").close();
  });
  ui.grid.addEventListener("click", async (event) => {
    if (event.target.closest("#new-collection")) {
      showFeatureForm("Create a collection", '<form id="create-collection-form"><label>Collection name<input name="name" maxlength="120" required></label><div class="dialog-actions"><button class="primary-button" type="submit">Create</button></div></form>', async (form) => {
        try {
          await request("/api/collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.get("name") }) });
          $("#feature-dialog").close();
          await showCollections();
        } catch (error) { notify(error.message, true); }
      });
      return;
    }
    const open = event.target.closest("[data-collection-open]");
    if (open) {
      try {
        const collectionId = open.dataset.collectionOpen;
        const collectionBooks = await request(`/api/collections/${collectionId}/books`);
        const collections = await request("/api/collections");
        activeCollection = { ...(collections.find((item) => item.id === collectionId) || {}), bookIds: collectionBooks.map((book) => book.id) };
        activeTag = null;
        activeView = "all";
        books = allBooks;
        render();
      } catch (error) { notify(error.message, true); }
      return;
    }
    const add = event.target.closest("[data-collection-add]");
    if (add) {
      const options = allBooks.map((book) => `<option value="${escapeHtml(book.id)}">${escapeHtml(book.title)} — ${escapeHtml(book.author)}</option>`).join("");
      showFeatureForm("Add a book", `<form id="add-collection-book-form"><label>Book<select name="bookId" required>${options}</select></label><div class="dialog-actions"><button class="primary-button" type="submit">Add to collection</button></div></form>`, async (form) => {
        try {
          await request(`/api/collections/${add.dataset.collectionAdd}/books`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: form.get("bookId") }) });
          $("#feature-dialog").close();
          await showCollections();
        } catch (error) { notify(error.message, true); }
      });
      return;
    }
    const remove = event.target.closest("[data-collection-delete]");
    if (remove && window.confirm("Delete this collection? Books in your library will not be deleted.")) {
      try { await request(`/api/collections/${remove.dataset.collectionDelete}`, { method: "DELETE" }); await showCollections(); }
      catch (error) { notify(error.message, true); }
    }
  });

  $("#add-book").addEventListener("click", () => ui.file.click());
  $("#empty-add").addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", async () => {
    if (ui.file.files.length) await uploadFiles(Array.from(ui.file.files));
    ui.file.value = "";
  });
  ui.search.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadBooks().catch((error) => notify(error.message, true)), 250);
  });
  ui.sort.addEventListener("change", () => loadBooks().catch((error) => notify(error.message, true)));
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => {
    activeView = item.dataset.view;
    activeCollection = null;
    activeTag = null;
    renderTagNavigation();
    if (activeView === "collections") showCollections().catch((error) => notify(error.message, true));
    else if (activeView === "stats") showReadingStats().catch((error) => notify(error.message, true));
    else {
      $(".welcome-row").hidden = false;
      loadBooks().catch((error) => notify(error.message, true));
    }
    $("#sidebar").classList.remove("open");
  }));
  $("#tag-navigation").addEventListener("click", (event) => {
    const tag = event.target.closest("[data-tag-filter]");
    if (!tag) return;
    activeTag = tag.dataset.tagFilter;
    activeView = "all";
    activeCollection = null;
    $(".welcome-row").hidden = false;
    renderTagNavigation();
    loadBooks().catch((error) => notify(error.message, true));
    $("#sidebar").classList.remove("open");
  });
  $("#search-toggle").addEventListener("click", () => {
    $("#search-box").classList.toggle("visible");
    if ($("#search-box").classList.contains("visible")) ui.search.focus();
  });
  $("#view-toggle").addEventListener("click", () => {
    currentView = currentView === "grid" ? "list" : "grid";
    localStorage.setItem("pageandpine-view", currentView);
    $("#view-toggle").setAttribute("aria-label", `Switch to ${currentView === "grid" ? "list" : "grid"} view`);
    render();
  });
  currentView = localStorage.getItem("pageandpine-view") === "list" ? "list" : "grid";
  $("#view-toggle").setAttribute("aria-label", `Switch to ${currentView === "grid" ? "list" : "grid"} view`);
  $("#compact-resume").addEventListener("click", (event) => openSelectedBook(event.currentTarget.dataset.resume));
  document.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    dragDepth += 1;
    $("#drop-overlay").hidden = false;
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("#drop-overlay").hidden = true;
  });
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    dragDepth = 0;
    $("#drop-overlay").hidden = true;
    uploadFiles(Array.from(event.dataTransfer.files));
  });
  $("#menu-button").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#close-reader").addEventListener("click", closeReader);
  document.querySelector("[data-close-feature]").addEventListener("click", () => $("#feature-dialog").close());
  ui.backdrop.addEventListener("click", (event) => { if (event.target === ui.backdrop) closeReader(); });
  $("#previous-page").addEventListener("click", () => {
    if (rendition) rendition.prev().catch((error) => notify(error.message, true));
    else if (pdfDocument && pdfPage > 1) { pdfPage -= 1; renderPdfPage().catch((error) => notify(error.message, true)); }
    else if (textPages.length && textPage > 0) { textPage -= 1; renderTextPage(); }
  });
  $("#next-page").addEventListener("click", () => {
    if (rendition) rendition.next().catch((error) => notify(error.message, true));
    else if (pdfDocument && pdfPage < pdfDocument.numPages) { pdfPage += 1; renderPdfPage().catch((error) => notify(error.message, true)); }
    else if (textPages.length && textPage < textPages.length - 1) { textPage += 1; renderTextPage(); }
  });
  $("#pdf-page-input").addEventListener("change", () => {
    if (!pdfDocument) return;
    pdfPage = Math.max(1, Math.min(pdfDocument.numPages, Number($("#pdf-page-input").value) || 1));
    renderPdfPage().catch((error) => notify(error.message, true));
  });
  $("#pdf-fit").addEventListener("change", () => {
    const update = pdfDocument && isContinuous() ? renderPdfContinuous(true) : renderPdfPage();
    update.catch((error) => notify(error.message, true));
  });
  $("#pdf-zoom-in").addEventListener("click", () => {
    pdfZoom = Math.min(3, pdfZoom + 0.15);
    const update = pdfDocument && isContinuous() ? renderPdfContinuous(true) : renderPdfPage();
    update.catch((error) => notify(error.message, true));
  });
  $("#pdf-zoom-out").addEventListener("click", () => {
    pdfZoom = Math.max(0.5, pdfZoom - 0.15);
    const update = pdfDocument && isContinuous() ? renderPdfContinuous(true) : renderPdfPage();
    update.catch((error) => notify(error.message, true));
  });
  $("#font-smaller").addEventListener("click", () => {
    readerSettings.size = Math.max(14, Number(readerSettings.size) - 2);
    saveSettings();
  });
  $("#font-larger").addEventListener("click", () => {
    readerSettings.size = Math.min(32, Number(readerSettings.size) + 2);
    saveSettings();
  });
  $("#theme-toggle").addEventListener("click", () => {
    const themes = ["light", "sepia", "dark", "eink", "eink-dark"];
    const index = themes.indexOf(effectiveTheme());
    const wasContinuous = isContinuous();
    readerSettings.theme = themes[(index + 1) % themes.length];
    saveSettings();
    if (pdfDocument && wasContinuous !== isContinuous()) {
      renderPdfPage().catch((error) => notify(error.message, true));
    }
  });
  $("#reader-settings-toggle").addEventListener("click", () => {
    ui.contentsPanel.hidden = true;
    ui.settings.hidden = !ui.settings.hidden;
  });
  $("#reader-menu").addEventListener("click", () => {
    ui.settings.hidden = true;
    ui.contentsPanel.hidden = !ui.contentsPanel.hidden;
    if (!ui.contentsPanel.hidden) renderPanel();
  });
  $("#contents-button").addEventListener("click", () => {
    panelTab = "contents";
    ui.contentsPanel.hidden = false;
    renderPanel();
  });
  document.querySelectorAll("[data-close-panel]").forEach((button) => button.addEventListener("click", () => {
    ui.settings.hidden = true;
    ui.contentsPanel.hidden = true;
  }));
  document.querySelectorAll("[data-panel-tab]").forEach((button) => button.addEventListener("click", async () => {
    panelTab = button.dataset.panelTab;
    if (panelTab === "bookmarks" || panelTab === "highlights") {
      try { await loadAnnotations(); } catch (error) { notify(error.message, true); }
    }
    renderPanel();
  }));
  ui.panelContent.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-href]");
    if (button && rendition) {
      rendition.display(button.dataset.href).catch((error) => notify(error.message, true));
      ui.contentsPanel.hidden = true;
      return;
    }
    const bookmark = event.target.closest("[data-bookmark]");
    if (bookmark) {
      if (rendition) await rendition.display(bookmark.dataset.locator);
      else if (pdfDocument) { pdfPage = Number(bookmark.dataset.locator) || 1; await renderPdfPage(); }
      else if (textPages.length) { textPage = Math.max(0, Number(bookmark.dataset.locator) - 1); renderTextPage(); }
      return;
    }
    const editBookmark = event.target.closest("[data-edit-bookmark]");
    if (editBookmark) {
      const item = savedBookmarks.find((entry) => entry.id === editBookmark.dataset.editBookmark);
      showFeatureForm("Edit bookmark", `<form id="edit-bookmark-form"><label>Bookmark label<input name="label" value="${escapeHtml(item?.label || "")}" maxlength="500" required></label><div class="dialog-actions"><button class="primary-button" type="submit">Save</button></div></form>`, async (form) => {
        try {
          await request(`/api/bookmarks/${editBookmark.dataset.editBookmark}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: form.get("label") }),
          });
          $("#feature-dialog").close();
          await loadAnnotations(); renderPanel();
        } catch (error) { notify(error.message, true); }
      });
      return;
    }
    const editHighlightButton = event.target.closest("[data-edit-highlight]");
    if (editHighlightButton) {
      const item = savedHighlights.find((entry) => entry.id === editHighlightButton.dataset.editHighlight);
      if (item) editHighlight(item);
      return;
    }
    const highlight = event.target.closest("[data-highlight-locator]");
    if (highlight) {
      if (rendition) await rendition.display(highlight.dataset.highlightLocator);
      else if (pdfDocument) { pdfPage = Math.max(1, Number(highlight.dataset.highlightLocator) || 1); await renderPdfPage(); }
      else if (textPages.length) { textPage = Math.max(0, Number(highlight.dataset.highlightLocator) - 1); renderTextPage(); }
      return;
    }
    const removeBookmark = event.target.closest("[data-remove-bookmark]");
    if (removeBookmark) {
      try {
        await request(`/api/bookmarks/${removeBookmark.dataset.removeBookmark}`, { method: "DELETE" });
        await loadAnnotations(); renderPanel();
      } catch (error) { notify(error.message, true); }
      return;
    }
    const removeHighlight = event.target.closest("[data-remove-highlight]");
    if (removeHighlight) {
      try {
        await request(`/api/highlights/${removeHighlight.dataset.removeHighlight}`, { method: "DELETE" });
        savedHighlights = savedHighlights.filter((item) => item.id !== removeHighlight.dataset.removeHighlight);
        await restoreHighlights(); renderPanel();
      } catch (error) { notify(error.message, true); }
      return;
    }
    if (event.target.closest("#add-bookmark") && currentBook) {
      const locator = currentBook.locator || String(pdfPage || textPage + 1);
      showFeatureForm("Bookmark this place", '<form id="create-bookmark-form"><label>Bookmark label (optional)<input name="label" maxlength="500"></label><div class="dialog-actions"><button class="primary-button" type="submit">Save bookmark</button></div></form>', async (form) => {
        try {
          const item = await request(`/api/books/${currentBook.id}/bookmarks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ locator, label: form.get("label") || "", progress: currentBook.progress || 0 }),
          });
          savedBookmarks.push(item);
          $("#feature-dialog").close();
          renderPanel(); notify("Bookmark added.");
        } catch (error) { notify(error.message, true); }
      });
      return;
    }
    const searchResult = event.target.closest("[data-search-index]");
    if (searchResult) {
      const result = $("#reader-search-results").searchResults?.[Number(searchResult.dataset.searchIndex)];
      if (result?.locator && rendition) {
        await rendition.display(result.locator);
        rendition.annotations.highlight(result.locator, { fill: "yellow", "fill-opacity": "0.5" });
      }
      else if (result?.page && pdfDocument) { pdfPage = result.page; await renderPdfPage(); }
      else if (result?.page) { textPage = result.page - 1; renderTextPage(); }
    }
  });
  ui.panelContent.addEventListener("submit", (event) => {
    if (event.target.id !== "reader-search-form") return;
    event.preventDefault();
    searchInBook(new FormData(event.target).get("query").toString()).catch((error) => {
      $("#reader-search-results").textContent = error.message;
    });
  });
  ui.selectionToolbar.addEventListener("click", async (event) => {
    const highlight = event.target.closest("[data-highlight]");
    if (highlight) {
      try { await createHighlight(highlight.dataset.highlight); } catch (error) { notify(error.message, true); }
    }
  });
  $("#selection-note").addEventListener("click", async () => {
    showFeatureForm("Add a note", '<form id="create-note-form"><label>Note<textarea name="note" rows="4" maxlength="10000" required></textarea></label><div class="dialog-actions"><button class="primary-button" type="submit">Save highlight and note</button></div></form>', async (form) => {
      try {
        await createHighlight("yellow", form.get("note"));
        $("#feature-dialog").close();
      } catch (error) { notify(error.message, true); }
    });
  });
  $("#selection-copy").addEventListener("click", async () => {
    if (!selectedRange?.text) return;
    try { await navigator.clipboard.writeText(selectedRange.text); notify("Passage copied."); }
    catch (error) { notify(`Could not copy the passage: ${error.message}`, true); }
  });
  $("#selection-define").addEventListener("click", async () => {
    if (!selectedRange?.text || !window.confirm("Look up this passage on the internet? The selected text will be sent to Free Dictionary."))
      return;
    try {
      const word = selectedRange.text.trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu, "");
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (!response.ok) throw new Error("No dictionary entry was found.");
      const entries = await response.json();
      const definition = entries[0]?.meanings?.[0]?.definitions?.[0]?.definition;
      window.alert(`${word}: ${definition || "No definition available."}`);
    } catch (error) { notify(error.message, true); }
  });
  document.querySelectorAll("#reader-settings input, #reader-settings select").forEach((control) => {
    control.addEventListener("input", () => {
      const { id, type, value, checked } = control;
      const fields = {
        "setting-theme": ["theme", value], "setting-font": ["font", value],
        "setting-size": ["size", Number(value)], "setting-line-height": ["lineHeight", Number(value)],
        "setting-width": ["width", Number(value)], "setting-align": ["align", value],
        "setting-hyphenation": ["hyphenation", checked], "setting-continuous": ["continuous", checked],
        "setting-publisher": ["publisher", checked], "setting-immersive": ["immersive", checked], "setting-spread": ["spread", value],
        "setting-refresh-flash": ["refreshFlash", checked], "setting-refresh-every": ["refreshEvery", Math.max(1, Math.min(100, Number(value) || 8))],
      };
      if (!fields[id]) return;
      readerSettings[fields[id][0]] = fields[id][1];
      saveSettings();
      if (pdfDocument && (id === "setting-continuous" || id === "setting-theme")) {
        const update = isContinuous() ? renderPdfContinuous(true) : renderPdfPage();
        update.catch((error) => notify(error.message, true));
      }
    });
  });
  $("#progress-scrubber").addEventListener("change", async (event) => {
    const target = Number(event.currentTarget.value) / 1000;
    if (rendition?.book?.locations?.cfiFromPercentage) {
      try {
        const cfi = rendition.book.locations.cfiFromPercentage(target);
        await rendition.display(cfi);
      } catch (error) {
        const spineItems = rendition.book.spine.spineItems;
        const section = spineItems[Math.min(spineItems.length - 1, Math.floor(target * spineItems.length))];
        if (!section) {
          notify(`Could not move to that reading position: ${error.message}`, true);
          return;
        }
        try {
          await rendition.display(section.href);
          notify("Moved to the nearest chapter because this book has incomplete page locations.");
        } catch (fallbackError) {
          notify(`Could not move to that reading position: ${fallbackError.message}`, true);
        }
      }
    } else if (pdfDocument) {
      pdfPage = Math.max(1, Math.min(pdfDocument.numPages, Math.round(target * pdfDocument.numPages) || 1));
      await renderPdfPage();
    } else if (textPages.length) {
      textPage = Math.max(0, Math.min(textPages.length - 1, Math.floor(target * textPages.length)));
      renderTextPage();
    }
  });
  $("#progress-scrubber").addEventListener("input", (event) => {
    const percentage = Number(event.currentTarget.value) / 1000;
    const markers = [...$("#chapter-markers").children];
    const chapter = markers
      .filter((marker) => Number(marker.dataset.progress) <= percentage)
      .sort((left, right) => Number(right.dataset.progress) - Number(left.dataset.progress))[0]
      ?.dataset.chapter;
    event.currentTarget.title = `${chapter ? `${chapter} · ` : ""}${Math.round(percentage * 100)}%`;
  });
  $("#speech-toggle").addEventListener("click", () => {
    if (!("speechSynthesis" in window)) { notify("Text-to-speech is not available in this browser.", true); return; }
    if (speechActive) { window.speechSynthesis.cancel(); speechActive = false; $("#speech-toggle").textContent = "Listen"; $("#speech-caption").hidden = true; return; }
    const pdfText = pdfDocument
      ? (isContinuous()
        ? $("#pdf-continuous").querySelector(`[data-pdf-page="${pdfPage}"] .textLayer`)?.innerText
        : $("#pdf-text-layer").innerText)
      : "";
    const text = !ui.text.hidden ? ui.text.textContent : pdfDocument ? pdfText : rendition?.getContents().map((item) => item.document?.body?.innerText || "").join(" ") || "";
    if (!text) { notify("This page does not have readable text available.", true); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = Math.max(0.5, Math.min(2, (readerSettings.wpm || 230) / 230));
    const sentences = [...text.matchAll(/[^.!?]+[.!?]+|[^.!?]+$/g)];
    if (sentences[0]) {
      $("#speech-caption").textContent = sentences[0][0].trim();
      $("#speech-caption").hidden = false;
    }
    utterance.onboundary = (event) => {
      const sentence = sentences.find(([value, offset]) => event.charIndex >= offset && event.charIndex < offset + value.length)?.[0];
      if (sentence) {
        $("#speech-caption").textContent = sentence.trim();
        $("#speech-caption").hidden = false;
      }
    };
    utterance.onend = () => {
      speechActive = false;
      $("#speech-toggle").textContent = "Listen";
      window.setTimeout(() => { $("#speech-caption").hidden = true; }, 1800);
    };
    utterance.onerror = () => {
      speechActive = false;
      $("#speech-toggle").textContent = "Listen";
      $("#speech-caption").hidden = true;
      notify("Speech playback stopped unexpectedly.", true);
    };
    speechActive = true; $("#speech-toggle").textContent = "Stop"; window.speechSynthesis.speak(utterance);
  });
  $("#reader-settings-toggle").addEventListener("dblclick", () => {
    readerSettings.immersive = !readerSettings.immersive; saveSettings(); showReaderPosition();
  });
  $("#reader-history-back").addEventListener("click", async () => {
    const locator = locationHistory.pop();
    if (!locator || !rendition) return;
    try { await rendition.display(locator); } catch (error) { notify(error.message, true); }
    $("#reader-history-back").hidden = locationHistory.length === 0;
  });
  $(".reader-modal").addEventListener("pointermove", showReaderPosition);
  $(".reader-modal").addEventListener("click", (event) => {
    const canvas = event.target.closest("#reader-canvas");
    if (canvas && event.clientX > window.innerWidth * 0.35 && event.clientX < window.innerWidth * 0.65) showReaderPosition();
  });
  let touchStartX = 0;
  $(".reader-modal").addEventListener("touchstart", (event) => { touchStartX = event.changedTouches[0].clientX; }, { passive: true });
  $(".reader-modal").addEventListener("touchend", (event) => {
    const delta = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(delta) > 55 && !isContinuous()) (delta > 0 ? $("#previous-page") : $("#next-page")).click();
    else if (event.target.closest("#reader-canvas")) {
      const bounds = $("#reader-canvas").getBoundingClientRect();
      const x = (event.changedTouches[0].clientX - bounds.left) / bounds.width;
      const tapZone = isEinkTheme() ? 0.4 : 0.3;
      if (x < tapZone) $("#previous-page").click();
      else if (x > 1 - tapZone) $("#next-page").click();
      else if (readerSettings.immersive) {
        const modal = $(".reader-modal");
        if (modal.classList.contains("immersive-hidden")) showReaderPosition();
        else modal.classList.add("immersive-hidden");
      }
    }
  }, { passive: true });
  document.addEventListener("selectionchange", () => {
    if (!currentBook || rendition) return;
    const selection = window.getSelection()?.toString().trim();
    if (!selection) return;
    selectedRange = { locator: String(pdfPage || textPage + 1), text: selection };
    ui.selectionToolbar.hidden = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && ui.backdrop.hidden && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      event.preventDefault();
      $("#search-box").classList.add("visible");
      ui.search.focus();
      return;
    }
    if (ui.backdrop.hidden) return;
    if (event.key === "Escape") {
      if (!ui.settings.hidden || !ui.contentsPanel.hidden) { ui.settings.hidden = true; ui.contentsPanel.hidden = true; }
      else closeReader();
      return;
    }
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (event.key === "ArrowLeft" || event.key === "PageUp") $("#previous-page").click();
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") { event.preventDefault(); $("#next-page").click(); }
    if (event.key.toLowerCase() === "a") $("#reader-settings-toggle").click();
    if (event.key.toLowerCase() === "t") $("#contents-button").click();
    if (event.key.toLowerCase() === "b") { panelTab = "bookmarks"; ui.contentsPanel.hidden = false; renderPanel(); $("#add-bookmark").click(); }
    if (event.key === "/") { panelTab = "search"; ui.contentsPanel.hidden = false; renderPanel(); ui.panelContent.querySelector("input")?.focus(); }
  });
  $("#selection-explain").addEventListener("click", async () => {
    if (!selectedRange?.text) return;
    if (!window.confirm("Your selected book excerpt and question will be sent to the AI provider configured by the server administrator. Continue?")) return;
    showFeatureForm("Explain a passage", '<form id="explain-form"><label>Question<textarea name="question" rows="3" maxlength="1000" required>Explain this passage in clear, plain language.</textarea></label><div class="dialog-actions"><button class="primary-button" type="submit">Ask the configured AI</button></div></form>', async (form) => {
      try {
        const answer = await request("/api/ai/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passage: selectedRange.text, question: form.get("question") }),
        });
        showFeature("Passage explanation", `<div class="feature-dialog-content">${escapeHtml(answer.answer).replace(/\n/g, "<br>")}</div>`);
      } catch (error) { notify(error.message, true); }
    });
  });
  $("#chapter-summary").addEventListener("click", () => {
    const passage = rendition?.getContents().map((item) => item.document?.body?.innerText || "").join("\n\n").trim().slice(0, 12000);
    if (!passage) { notify("No EPUB chapter text is available to summarize.", true); return; }
    if (!window.confirm("This EPUB chapter text will be sent to the AI provider configured by the server administrator. Continue?")) return;
    showFeatureForm("Summarize this chapter", '<form id="chapter-summary-form"><label>Instructions<textarea name="question" rows="3" maxlength="1000" required>Summarize this chapter in concise bullet points.</textarea></label><div class="dialog-actions"><button class="primary-button" type="submit">Generate summary</button></div></form>', async (form) => {
      try {
        const result = await request("/api/ai/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passage, question: form.get("question") }),
        });
        showFeature("Chapter summary", `<div class="feature-dialog-content">${escapeHtml(result.answer).replace(/\n/g, "<br>")}</div>`);
      } catch (error) { notify(error.message, true); }
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden" || !currentBook) return;
    queueProgress(currentBook.id, currentBook.progress || 0, currentBook.locator || "");
    fetch(`/api/books/${currentBook.id}/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: currentBook.progress || 0, locator: currentBook.locator || "", deviceId }),
      keepalive: true,
    }).catch((error) => console.warn("Could not save progress while the page was hidden.", error));
  });
  window.addEventListener("beforeunload", () => {
    if (!currentBook) return;
    queueProgress(currentBook.id, currentBook.progress || 0, currentBook.locator || "");
    fetch(`/api/books/${currentBook.id}/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: currentBook.progress || 0, locator: currentBook.locator || "", deviceId }),
      keepalive: true,
    }).catch((error) => console.warn("Could not save progress before closing the page.", error));
  });
  applySettings();
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", applySettings);
  $("#welcome-date").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date()).toUpperCase();
  initializeAuth().then((allowed) => {
    if (!allowed) return;
    loadBooks().catch((error) => notify(error.message, true));
    request("/api/ai/config").then((config) => {
      aiConfigured = config.configured;
      $("#selection-explain").hidden = !aiConfigured;
      $("#chapter-summary").hidden = !aiConfigured || !rendition;
    })
      .catch((error) => console.warn("Could not check optional AI availability.", error));
  }).catch((error) => {
    const cached = localStorage.getItem("pageandpine-library-cache");
    if (cached) {
      allBooks = books = JSON.parse(cached);
      render();
      notify("Could not reach the server; showing cached books.", true);
    } else notify(error.message, true);
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => notify(`Offline support could not be enabled: ${error.message}`, true));
  }
  window.setInterval(pollConversions, 2500);
})();
