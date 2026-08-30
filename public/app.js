"use strict";

(() => {
  const $app = document.getElementById("app");
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    user: null, // null = ausgeloggt, sonst PublicUser
    booted: false,
  };

  let listConn = null; // aktive WebSocket-Verbindung der Listen-Ansicht
  let closeActiveSwipe = null; // offene Swipe-Zelle der aktuellen Liste zumachen

  // ---------- Helfer ----------

  function el(tag, attrs = {}, ...children) {
    const isSvg = tag === "svg" || tag === "circle" || tag === "path";
    const node = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.setAttribute("class", value);
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else if (value !== undefined && value !== null) {
        node.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.append(child);
    }
    return node;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // keine JSON-Antwort
    }
    if (!res.ok) {
      const err = new Error(data?.error ?? `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    let node = document.querySelector(".toast");
    if (!node) {
      node = el("div", { class: "toast", role: "status" });
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2500);
  }

  // Löschen mit Bestätigung: erster Tap bewaffnet (3 s), zweiter Tap führt aus.
  function deleteButton({ cls, icon, caption, confirmText, ariaLabel, onConfirm }) {
    const btn = el("button", { class: cls, type: "button", "aria-label": ariaLabel ?? confirmText });
    let armed = false;
    let timer = null;
    const paint = (isArmed) => {
      btn.classList.toggle("armed", isArmed);
      if (isArmed) {
        btn.replaceChildren(el("span", { class: "del-cap", text: confirmText }));
      } else {
        btn.replaceChildren(
          ...(icon ? [el("span", { class: "del-icon", "aria-hidden": "true", text: icon })] : []),
          ...(caption ? [el("span", { class: "del-cap", text: caption })] : [])
        );
      }
    };
    btn.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        paint(true);
        timer = setTimeout(() => {
          armed = false;
          paint(false);
        }, 3000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      paint(false);
      onConfirm();
    });
    // von außen abrufen (z. B. wenn der Kontext verschwindet)
    btn.reset = () => {
      clearTimeout(timer);
      armed = false;
      paint(false);
    };
    paint(false);
    return btn;
  }

  // Bottom-Sheet: Background-Tap, Esc oder close() schließt.
  function openSheet(build) {
    const backdrop = el("div", { class: "sheet-backdrop" });
    const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    function close() {
      document.removeEventListener("keydown", onKey);
      backdrop.classList.remove("open");
      sheet.classList.remove("open");
      setTimeout(() => backdrop.remove(), 220);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    build(sheet, close);
    backdrop.append(sheet);
    document.body.append(backdrop);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        backdrop.classList.add("open");
        sheet.classList.add("open");
      })
    );
  }

  // ---------- Gemeinsame Helfer für Verlauf & Kochmodus ----------

  // Duplikat-Schlüssel wie im Durable Object: „  Milch “ == „milch“
  function normKey(name) {
    return name.trim().replace(/\s+/g, " ").toLowerCase();
  }

  // Kochschritte: neuer Stand {text, timerSekunden?}, alter Stand reiner String
  function parseSteps(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        if (entry.trim()) out.push({ text: entry.trim() });
      } else if (entry && typeof entry === "object" && typeof entry.text === "string" && entry.text.trim()) {
        const step = { text: entry.text.trim() };
        if (typeof entry.timerSekunden === "number" && entry.timerSekunden > 0) {
          step.timerSekunden = Math.min(7200, Math.round(entry.timerSekunden));
        }
        out.push(step);
      }
    }
    return out;
  }

  // Führende Zahl einer Freitext-Menge hochrechnen ("500 g" → "750 g")
  function scaleMenge(menge, factor) {
    if (!menge || factor === 1 || !Number.isFinite(factor) || factor <= 0) return menge;
    const match = menge.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
    if (!match) return menge;
    const scaled = Number.parseFloat(match[1].replace(",", ".")) * factor;
    if (!Number.isFinite(scaled)) return menge;
    return `${Math.round(scaled * 100) / 100}`.replace(".", ",") + match[2];
  }

  function fmtTimer(sekunden) {
    const min = Math.round(sekunden / 60);
    if (min < 60) return `⏱ ${min} min`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return `⏱ ${h} h${rest ? ` ${rest} min` : ""}`;
  }

  function relTime(ts) {
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return "gerade eben";
    if (min < 60) return `vor ${min} Min.`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `vor ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "gestern";
    if (days < 7) return `vor ${days} Tagen`;
    const weeks = Math.floor(days / 7);
    if (weeks === 1) return "vor 1 Woche";
    if (weeks < 5) return `vor ${weeks} Wochen`;
    const months = Math.floor(days / 30);
    return months <= 1 ? "vor einem Monat" : `vor ${months} Monaten`;
  }

  // Kurzer Signalton für den Ablauf eines Koch-Timers (nur nach Nutzerinteraktion)
  function cookBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.1);
      osc.start();
      osc.stop(ctx.currentTime + 1.15);
      osc.onended = () => ctx.close().catch(() => {});
    } catch {
      // Ton ist optional
    }
  }

  // ---------- Kategorien (Wörterbuch: public/data/categories.json) ----------

  // Wird in boot() geladen; leer = alles läuft unter „Sonstiges“.
  const SONSTIGES = "sonstiges";
  let categoryData = [];

  async function loadCategories() {
    try {
      const res = await fetch("/data/categories.json");
      if (res.ok) categoryData = await res.json();
    } catch {
      // Wörterbuch fehlt → Artikel laufen unter „Sonstiges“, App bleibt funktionsfähig
    }
  }

  // Längster Stichwort-Treffer gewinnt („kokosmilch“ → Vorrat, „milch“ → Molkerei)
  function classify(name) {
    const n = normKey(name);
    let best = null;
    let bestLen = 0;
    for (const cat of categoryData) {
      for (const kw of cat.keywords) {
        if (kw.length > bestLen && n.includes(kw)) {
          best = cat.id;
          bestLen = kw.length;
        }
      }
    }
    return best;
  }

  function categoryLabel(id) {
    const cat = categoryData.find((c) => c.id === id);
    return cat ? cat.label : "Sonstiges";
  }

  function categoryOrder() {
    return [...categoryData.map((c) => c.id), SONSTIGES];
  }

  // ---------- Router ----------

  function navigate(path, { replace = false } = {}) {
    history[replace ? "replaceState" : "pushState"]({}, "", path);
    render();
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-link]");
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute("href"));
  });

  // Tippt man neben eine offene Swipe-Zelle, klappt sie zu.
  document.addEventListener("click", (event) => {
    if (closeActiveSwipe && !event.target.closest?.(".swipe-cell")) closeActiveSwipe();
  });

  window.addEventListener("popstate", () => render());

  async function boot() {
    await loadCategories();
    registerServiceWorker();
    try {
      const data = await api("/api/auth/me");
      state.user = data.user;
    } catch {
      state.user = null;
    }
    state.booted = true;
    render();
  }

  // ---------- PWA: Service Worker + Web Push ----------

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // Neuen Service Worker sofort übernehmen und die Seite einmal neu laden,
      // damit niemand auf der alten (ggf. defekten) App-Shell hängen bleibt.
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "activated" && navigator.serviceWorker.controller) {
            window.location.reload();
          }
        });
      });
    }).catch(() => {
      // SW ist optional – die App funktioniert auch ohne.
    });
  }

  /**
   * Fragt den öffentlichen VAPID-Key ab und zeigt den Push-Status an.
   * enabled = ob der Nutzer gerade eine aktive Subscription hat (lokaler Merker).
   */
  async function renderPushToggle(container) {
    let vapidData = null;
    try {
      vapidData = await api("/api/push/vapid-key");
    } catch {
      // Server nicht erreichbar – Toggle ausblenden
    }
    if (!vapidData?.configured) {
      container.hidden = true;
      return;
    }

    const stateRow = el(
      "div",
      { class: "profile-row" },
      el("span", { class: "profile-icon", "aria-hidden": "true", text: "🔔" }),
      el(
        "span",
        { class: "profile-main" },
        el("span", { class: "profile-name", text: "Benachrichtigungen" }),
        el("span", { class: "profile-mail muted", text: "Wenn jemand die Liste ändert" })
      )
    );

    const status = el("span", { class: "push-status", text: "…" });
    const toggle = el("button", { class: "btn ghost push-toggle", type: "button", text: "Aktivieren" });
    container.append(stateRow, el("div", { class: "push-row" }, status, toggle));

    const getSubscription = () =>
      ("serviceWorker" in navigator && navigator.serviceWorker.ready
        ? navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription())
        : Promise.resolve(null));

    function refresh() {
      getSubscription().then((sub) => {
        const on = !!sub && !sub.expirationTime && sub.endpoint;
        if (!sub) {
          toggle.hidden = false;
          toggle.textContent = "Aktivieren";
          status.textContent = "Aus";
          return;
        }
        toggle.hidden = false;
        toggle.textContent = "Deaktivieren";
        status.textContent = "An";
      });
    }

    toggle.addEventListener("click", async () => {
      const sub = await getSubscription();
      if (sub) {
        try {
          await api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } });
          await sub.unsubscribe();
          refresh();
          toast("Benachrichtigungen aus");
        } catch (err) {
          toast(err.message);
        }
        return;
      }
      try {
        if (Notification.permission === "denied") {
          toast("Benachrichtigungen sind im Browser blockiert.");
          return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          toast("Benachrichtigungen wurden abgelehnt.");
          return;
        }
        if (!("serviceWorker" in navigator)) {
          toast("Dein Browser unterstützt kein Push.");
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const newSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey),
        });
        await api("/api/push/subscribe", {
          body: {
            endpoint: newSub.endpoint,
            keys: newSub.toJSON().keys,
          },
        });
        refresh();
        toast("Benachrichtigungen an");
      } catch (err) {
        toast("Push konnte nicht aktiviert werden.");
      }
    });

    refresh();
  }

  // Routen mit Bottom-Nav; Liste, Kochmodus und Login laufen bewusst ohne
  const NAV_PATHS = ["/", "/rezepte", "/profil"];

  function updateBottomNav(path) {
    const nav = document.querySelector(".bottom-nav");
    if (!nav) return;
    nav.hidden = path === null;
    document.body.classList.toggle("has-nav", path !== null);
    for (const link of nav.querySelectorAll(".bottom-nav-item")) {
      const active = link.getAttribute("href") === path;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function render() {
    if (!state.booted) return;
    leaveListView();
    leaveCookView();
    document.querySelectorAll(".sheet-backdrop").forEach((n) => n.remove());

    const path = location.pathname;
    document.body.classList.toggle("has-addbar", /^\/list\/[A-Za-z0-9-]+$/.test(path));
    updateBottomNav(state.user && NAV_PATHS.includes(path) ? path : null);

    if (path === "/login") return renderAuth("login");
    if (path === "/register") return renderAuth("register");

    // Geschützte Routen: ohne Session zum Login, danach zurück zur Zielseite
    if (!state.user) {
      sessionStorage.setItem("afterLogin", path);
      return renderAuth("login", "Zum Ansehen musst du eingeloggt sein.");
    }

    if (path === "/") return renderLists();
    if (path === "/rezepte") return renderRecipes();
    if (path === "/profil") return renderProfile();

    let match = path.match(/^\/list\/([A-Za-z0-9-]+)$/);
    if (match) return renderList(match[1]);

    match = path.match(/^\/list\/([A-Za-z0-9-]+)\/kochen\/([A-Za-z0-9-]+)$/);
    if (match) return renderCook(match[1], match[2]);

    match = path.match(/^\/join\/([A-Za-z0-9_-]+)$/);
    if (match) return renderJoin(match[1]);

    renderNotFound();
  }

  // ---------- Login / Registrierung ----------

  function renderAuth(mode, note) {
    const isRegister = mode === "register";

    const email = el("input", {
      class: "input",
      type: "email",
      name: "email",
      placeholder: "E-Mail",
      autocomplete: "email",
      required: true,
    });
    const password = el("input", {
      class: "input",
      type: "password",
      name: "password",
      placeholder: isRegister ? "Passwort (mind. 8 Zeichen)" : "Passwort",
      autocomplete: isRegister ? "new-password" : "current-password",
      minlength: isRegister ? "8" : undefined,
      required: true,
    });
    const displayName = isRegister
      ? el("input", {
          class: "input",
          type: "text",
          name: "displayName",
          placeholder: "Anzeigename (z. B. Anna)",
          maxlength: "40",
          required: true,
        })
      : null;
    const errorBox = el("p", { class: "error", hidden: true });
    const submit = el("button", {
      class: "btn primary",
      type: "submit",
      text: isRegister ? "Konto erstellen" : "Einloggen",
    });

    const form = el(
      "form",
      {
        class: "card form",
        onsubmit: async (event) => {
          event.preventDefault();
          errorBox.hidden = true;
          submit.disabled = true;
          try {
            const body = { email: email.value, password: password.value };
            if (isRegister) body.displayName = displayName.value;
            const data = await api(`/api/auth/${isRegister ? "register" : "login"}`, { body });
            state.user = data.user;
            const after = sessionStorage.getItem("afterLogin") ?? "/";
            sessionStorage.removeItem("afterLogin");
            navigate(after, { replace: true });
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
          } finally {
            submit.disabled = false;
          }
        },
      },
      displayName,
      email,
      password,
      errorBox,
      submit
    );

    $app.replaceChildren(
      el(
        "div",
        { class: "auth-wrap" },
        el("h1", { class: "logo", text: "🛒 Buylist" }),
        el("p", { class: "subtitle", text: note ?? "Gemeinsame Einkaufslisten in Echtzeit." }),
        el(
          "nav",
          { class: "tabs" },
          el("a", { "data-link": "", href: "/login", class: !isRegister ? "active" : "", text: "Login" }),
          el("a", { "data-link": "", href: "/register", class: isRegister ? "active" : "", text: "Registrieren" })
        ),
        form
      )
    );
  }

  // ---------- Koch-Assistent & Rezepte (geteilt zwischen Startseite und Liste) ----------

  function recipeMetaText(recipe) {
    const p = recipe.portionen === 1 ? "1 Portion" : `${recipe.portionen} Portionen`;
    return [p, recipe.zeit].filter(Boolean).join(" · ");
  }

  /**
   * Rezept-Details (Zutaten + Schritte). Mit `selectable` werden die Zutaten
   * zu an-/abwählbaren Zeilen; `selection` ist das parallel zu `zutaten`
   * liegende Boolean-Array, das die Aufruferin hält. `onSelect` läuft nach
   * jedem Umschalten.
   */
  function recipeDetailsEl(recipe, { selectable = false, selection = null, onSelect = null } = {}) {
    const sel = selection ?? recipe.zutaten.map(() => true);

    const ingList = el("ul", { class: "recipe-ingredients" + (selectable ? " selectable" : "") });
    recipe.zutaten.forEach((z, i) => {
      if (!selectable) {
        ingList.append(
          el(
            "li",
            {},
            el("span", { text: z.name }),
            z.menge ? el("span", { class: "recipe-menge", text: z.menge }) : null
          )
        );
        return;
      }
      const on = !!sel[i];
      const toggle = el(
        "button",
        {
          class: "ing-row" + (on ? " on" : ""),
          type: "button",
          "aria-pressed": String(on),
          "aria-label": `${z.name} ${on ? "abwählen" : "auswählen"}`,
        },
        el("span", { class: "ing-row-check", "aria-hidden": "true", text: "✓" }),
        el("span", { class: "ing-row-name", text: z.name }),
        z.menge ? el("span", { class: "recipe-menge", text: z.menge }) : null
      );
      toggle.addEventListener("click", () => {
        sel[i] = !sel[i];
        toggle.classList.toggle("on", sel[i]);
        toggle.setAttribute("aria-pressed", String(sel[i]));
        if (onSelect) onSelect(sel);
      });
      ingList.append(el("li", {}, toggle));
    });

    return el(
      "div",
      { class: "recipe-details" },
      el("h4", { class: "recipe-label", text: "Zutaten" }),
      ingList,
      el("h4", { class: "recipe-label", text: "Zubereitung" }),
      el(
        "ol",
        { class: "recipe-steps" },
        ...parseSteps(recipe.schritte).map((s) =>
          el(
            "li",
            {},
            el("span", { text: s.text }),
            s.timerSekunden ? el("span", { class: "recipe-timer", text: fmtTimer(s.timerSekunden) }) : null
          )
        )
      )
    );
  }

  /**
   * Koch-Assistent (Gemini-Generierung + Vorschau + Speichern auf eine Liste).
   * Ohne `lists` fest an `listId` gebunden (Listen-Ansicht); mit `lists` zeigt
   * das Formular einen Auswahl für die Ziel-Liste (Startseite).
   * `loadOpenItems(listId)` (optional, async) lädt die offenen Artikel einer
   * Liste on demand (z. B. per Snapshot) – sie stehen im „Aus meinen Zutaten“-
   * Modus als anwählbare Chips bereit.
   * onSaved({ data, recipe, listId, listName, showSuccess }) läuft nach dem
   * erfolgreichen Speichern – wer showSuccess nicht nutzt, bekommt die
   * Standard-Leerung der Vorschau.
   */
  function createRecipeAssistant({ listId, lists, onSaved, loadOpenItems }) {
    let targetListId = listId ?? null;
    let listNameOf = () => "";

    let listSelect = null;
    if (Array.isArray(lists) && lists.length) {
      const last = localStorage.getItem("bl-last-list");
      targetListId = lists.some((l) => l.id === last) ? last : lists[0].id;
      const nameById = new Map(lists.map((l) => [l.id, l.name]));
      listNameOf = (id) => nameById.get(id) ?? "";
      listSelect = el(
        "select",
        { class: "input assistant-list", "aria-label": "Einkaufsliste" },
        ...lists.map((l) => el("option", { value: l.id, text: `🛒 ${l.name}` }))
      );
      listSelect.value = targetListId;
      listSelect.addEventListener("change", () => {
        targetListId = listSelect.value;
        selectedChips.clear();
        if (modus === "zutaten") void rebuildChips();
      });
    }

    // Modus: "gericht" oder "zutaten" (Resteverwertung)
    let modus = "gericht";

    const gerichtInput = el("input", {
      class: "input gericht",
      type: "text",
      placeholder: "Gericht, z. B. Spaghetti Carbonara",
      maxlength: "120",
      autocomplete: "off",
    });
    const zutatenInput = el("input", {
      class: "input zutaten",
      type: "text",
      placeholder: "z. B. Milch, Eier, Mehl (mit Komma getrennt)",
      maxlength: "300",
      autocomplete: "off",
    });
    const portionenInput = el("input", {
      class: "input portionen",
      type: "number",
      min: "1",
      max: "12",
      value: "2",
      inputmode: "numeric",
      "aria-label": "Portionen",
    });
    const generateBtn = el("button", { class: "btn primary", type: "submit", text: "Rezept erstellen" });
    const assistantError = el("p", { class: "error", hidden: true });
    const previewEl = el("div", {});

    // Zutaten-Chips aus den offenen Listeneinträgen – werden jedes Mal neu
    // aufgebaut, wenn man in den „Meine Zutaten“-Modus wechselt (die Liste
    // kann sich zwischenzeitlich geändert haben).
    const selectedChips = new Set();
    let chipsWrap = el("div", { class: "zutaten-chips" });
    let chipsSeq = 0;

    async function rebuildChips() {
      chipsWrap.replaceChildren();
      const seq = ++chipsSeq;
      let source = [];
      if (typeof loadOpenItems === "function") {
        try {
          const loaded = await loadOpenItems(targetListId);
          if (Array.isArray(loaded)) source = loaded;
        } catch {
          // Fehler ignorieren – dann bleiben die Chips leer.
        }
      }
      // Stale Antworten verwerfen, wenn zwischenzeitlich die Liste gewechselt
      // wurde oder ein neuerer Aufruf läuft.
      if (seq !== chipsSeq) return;
      if (!Array.isArray(source) || !source.length) return;
      const seen = new Set();
      for (const item of source) {
        const key = normKey(item.name);
        if (seen.has(key)) continue;
        seen.add(key);
        const chip = el(
          "button",
          {
            class: "chip" + (selectedChips.has(key) ? " on" : ""),
            type: "button",
            "aria-pressed": String(selectedChips.has(key)),
          },
          el("span", { class: "chip-name", text: item.name })
        );
        chip.addEventListener("click", () => {
          if (selectedChips.has(key)) {
            selectedChips.delete(key);
            chip.classList.remove("on");
            chip.setAttribute("aria-pressed", "false");
          } else {
            selectedChips.add(key);
            chip.classList.add("on");
            chip.setAttribute("aria-pressed", "true");
          }
        });
        chipsWrap.append(chip);
      }
    }

    const gerichtWrap = el("div", { class: "assistant-row" }, gerichtInput, portionenInput);
    const zutatenWrap = el("div", { class: "assistant-mode zutaten-mode", hidden: true },
      el("p", { class: "muted", text: "Was hast du noch im Schrank? Der Assistent macht ein Rezept daraus." }),
      zutatenInput,
      chipsWrap
    );

    function setModus(next) {
      modus = next;
      gerichtWrap.hidden = next !== "gericht";
      zutatenWrap.hidden = next !== "zutaten";
      for (const tab of form.querySelectorAll(".assistant-tab")) {
        tab.classList.toggle("active", tab.dataset.mode === next);
      }
      if (next === "zutaten") void rebuildChips();
    }

    const tabGericht = el("button", { class: "assistant-tab active", type: "button", "data-mode": "gericht", text: "🍽 Gericht" });
    const tabZutaten = el("button", { class: "assistant-tab", type: "button", "data-mode": "zutaten", text: "🧺 Meine Zutaten" });
    tabGericht.addEventListener("click", () => setModus("gericht"));
    tabZutaten.addEventListener("click", () => setModus("zutaten"));
    const modeTabs = el("div", { class: "assistant-tabs" }, tabGericht, tabZutaten);

    const clearPreview = () => {
      previewEl.replaceChildren();
      gerichtInput.value = "";
      zutatenInput.value = "";
      selectedChips.clear();
      for (const chip of zutatenWrap.querySelectorAll(".chip")) {
        chip.classList.remove("on");
        chip.setAttribute("aria-pressed", "false");
      }
    };
    const showSuccess = (...nodes) => previewEl.replaceChildren(...nodes);

    function showPreview(recipe) {
      const selection = recipe.zutaten.map(() => true);
      const saveBtn = el("button", {
        class: "btn primary",
        type: "button",
        text: `Alle ${recipe.zutaten.length} Zutaten auf die Liste`,
      });
      const updateSaveLabel = () => {
        const n = selection.filter(Boolean).length;
        saveBtn.textContent = n === recipe.zutaten.length
          ? `Alle ${recipe.zutaten.length} Zutaten auf die Liste`
          : `${n} Zutat${n === 1 ? "" : "en"} auf die Liste`;
      };
      const detailsEl = recipeDetailsEl(recipe, {
        selectable: true,
        selection,
        onSelect: updateSaveLabel,
      });
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
          const aufListe = recipe.zutaten.filter((_, i) => selection[i]);
          const data = await api(`/api/list/${targetListId}/recipes`, { body: { ...recipe, aufListe } });
          toast(`Rezept gespeichert – ${data.added} Artikel hinzugefügt`);
          if (onSaved) {
            onSaved({
              data,
              recipe: data.rezept ?? recipe,
              listId: targetListId,
              listName: listNameOf(targetListId),
              showSuccess,
            });
          }
          // Hat onSaved keine eigene Erfolgsanzeige gesetzt, Vorschau zurücksetzen
          if (!previewEl.querySelector(".preview")) clearPreview();
        } catch (err) {
          toast(err.message);
          saveBtn.disabled = false;
        }
      };
      const discardBtn = el("button", {
        class: "btn ghost",
        type: "button",
        text: "Verwerfen",
        onclick: () => previewEl.replaceChildren(),
      });

      previewEl.replaceChildren(
        el(
          "div",
          { class: "card recipe-card preview" },
          el(
            "div",
            { class: "recipe-head static" },
            el(
              "div",
              { class: "recipe-head-main" },
              el("span", { class: "recipe-title", text: recipe.titel }),
              el("span", { class: "recipe-sub muted", text: recipeMetaText(recipe) })
            )
          ),
          el("p", { class: "ing-hint muted", text: "Nicht nötige Zutaten abwählen – nur Ausgewählte landen auf der Liste." }),
          detailsEl,
          el("div", { class: "recipe-actions" }, saveBtn, discardBtn)
        )
      );
    }

    const form = el(
      "form",
      {
        class: "card form assistant-form",
        onsubmit: async (event) => {
          event.preventDefault();
          const portionen = Number(portionenInput.value) || 2;
          if (modus === "gericht") {
            const gericht = gerichtInput.value.trim();
            if (!gericht) {
              gerichtInput.focus();
              return;
            }
            generateBtn.disabled = true;
            generateBtn.textContent = "Rezept wird erstellt…";
            assistantError.hidden = true;
            try {
              const data = await api(`/api/list/${targetListId}/generate`, {
                body: { gericht, portionen },
              });
              showPreview(data.rezept);
            } catch (err) {
              assistantError.textContent = err.message;
              assistantError.hidden = false;
            } finally {
              generateBtn.disabled = false;
              generateBtn.textContent = "Rezept erstellen";
            }
            return;
          }
          // Modus "zutaten": Chips + Freitext zusammenführen
          const zutaten = [...selectedChips];
          for (const part of zutatenInput.value.split(/[,;\n]/)) {
            const name = part.trim();
            if (name && !zutaten.includes(name)) zutaten.push(name);
          }
          if (!zutaten.length) {
            zutatenInput.focus();
            toast("Wähle Zutaten aus oder tippe sie unten ein.");
            return;
          }
          generateBtn.disabled = true;
          generateBtn.textContent = "Rezept wird erstellt…";
          assistantError.hidden = true;
          try {
            const data = await api(`/api/list/${targetListId}/generate`, {
              body: { zutaten, portionen },
            });
            showPreview(data.rezept);
          } catch (err) {
            assistantError.textContent = err.message;
            assistantError.hidden = false;
          } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = "Rezept erstellen";
          }
        },
      },
      el("p", { class: "assistant-title", text: "✨ Koch-Assistent" }),
      modeTabs,
      el("div", { class: "assistant-mode" }, gerichtWrap),
      zutatenWrap,
      listSelect,
      generateBtn,
      assistantError
    );

    return el("div", { class: "assistant" }, form, previewEl);
  }

  /**
   * Sheet „Zutaten auf die Liste“: auswählbare Zutatenliste eines gespeicherten
   * Rezepts, mit einem Button, der die Auswahl an /api/list/:id/items schickt.
   * Standard: alle aktiv.
   */
  function openAddIngredientsSheet(recipe, listId, listName) {
    openSheet((sheet, close) => {
      const selection = recipe.zutaten.map(() => true);
      const confirmBtn = el("button", {
        class: "btn primary",
        type: "button",
        text: `Alle ${recipe.zutaten.length} Zutaten auf die Liste`,
      });
      const updateLabel = () => {
        const n = selection.filter(Boolean).length;
        confirmBtn.textContent = n === recipe.zutaten.length
          ? `Alle ${recipe.zutaten.length} Zutaten auf die Liste`
          : `${n} Zutat${n === 1 ? "" : "en"} auf die Liste`;
      };
      const detailsEl = recipeDetailsEl(recipe, { selectable: true, selection, onSelect: updateLabel });

      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        try {
          const items = recipe.zutaten.filter((_, i) => selection[i]);
          const res = await api(`/api/list/${listId}/items`, { body: { items } });
          toast(`${res.added} Artikel auf „${listName}“`);
          close();
        } catch (err) {
          toast(err.message);
          confirmBtn.disabled = false;
        }
      });

      sheet.append(
        el("div", { class: "sheet-handle", "aria-hidden": "true" }),
        el("h2", { class: "sheet-title", text: recipe.titel }),
        el("p", { class: "sheet-sub muted", text: "Wähle aus, was du brauchst – alles andere bleibt im Rezept." }),
        el("div", { class: "sheet-pad" }, detailsEl),
        el("div", { class: "sheet-actions" }, confirmBtn)
      );
    });
  }

  // ---------- Rezept-Karte (Rezepte-Tab) ----------

  function recipeCard(recipe) {
    return el(
      "div",
      { class: "card recent-recipe-card" },
      el(
        "div",
        { class: "recent-recipe-main" },
        el("span", { class: "recipe-title", text: recipe.titel }),
        el("span", {
          class: "recipe-sub muted",
          text: [recipeMetaText(recipe), `🛒 ${recipe.listName}`].filter(Boolean).join(" · "),
        })
      ),
      el(
        "div",
        { class: "recipe-actions" },
        el("a", {
          class: "btn primary recipe-cook",
          "data-link": "",
          href: `/list/${recipe.listId}/kochen/${recipe.id}`,
          text: "🍳 Kochen",
        }),
        el("button", {
          class: "btn ghost recipe-add",
          type: "button",
          text: "🛒 Auf die Liste",
          onclick: () => openAddIngredientsSheet(recipe, recipe.listId, recipe.listName),
        })
      )
    );
  }

  /** Topbar der Tab-Ansichten: Titel mittig, beide Seiten als Platzhalter. */
  function tabTopbar(title) {
    return el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-inner" },
        el("span", { class: "icon-btn", style: "visibility:hidden", "aria-hidden": "true", text: "‹" }),
        el("h1", { class: "topbar-title", text: title }),
        el("span", { class: "icon-btn", style: "visibility:hidden", "aria-hidden": "true", text: "‹" })
      )
    );
  }

  // ---------- Listen-Übersicht ----------

  function renderLists() {
    const listContainer = el("div", { class: "list-rows" }, el("p", { class: "muted empty", text: "Lade Listen…" }));

    const nameInput = el("input", {
      class: "input",
      type: "text",
      placeholder: "Name der neuen Liste (z. B. Wocheneinkauf)",
      maxlength: "80",
      required: true,
    });
    const createBtn = el("button", { class: "btn primary", type: "submit", text: "+ Liste erstellen" });

    const createForm = el(
      "form",
      {
        class: "card form",
        onsubmit: async (event) => {
          event.preventDefault();
          if (!nameInput.value.trim()) return;
          createBtn.disabled = true;
          try {
            const data = await api("/api/lists", { body: { name: nameInput.value } });
            navigate(`/list/${data.list.id}`);
          } catch (err) {
            toast(err.message);
            createBtn.disabled = false;
          }
        },
      },
      nameInput,
      createBtn
    );

    const header = tabTopbar("Meine Listen");

    $app.replaceChildren(
      header,
      el("p", { class: "greeting", text: `Hallo, ${state.user.displayName}! 👋` }),
      el("h2", { class: "section-title", text: "Deine Listen" }),
      listContainer,
      el("h2", { class: "section-title", text: "Neue Liste" }),
      createForm
    );

    api("/api/lists")
      .then((data) => {
        listContainer.replaceChildren();
        if (!data.lists.length) {
          listContainer.append(el("p", { class: "muted empty", text: "Noch keine Liste – leg unten deine erste an!" }));
          return;
        }
        for (const list of data.lists) {
          listContainer.append(
            el(
              "a",
              { class: "list-row", "data-link": "", href: `/list/${list.id}` },
              el("span", { class: "list-row-icon", "aria-hidden": "true", text: "🛒" }),
              el(
                "span",
                { class: "list-row-main" },
                el("span", { class: "list-row-name", text: list.name }),
                el("span", {
                  class: "list-row-sub muted",
                  text: `${list.memberCount} ${list.memberCount === 1 ? "Mitglied" : "Mitglieder"}`,
                })
              ),
              el("span", { class: "chevron", "aria-hidden": "true", text: "›" })
            )
          );
        }
      })
      .catch((err) => {
        if (err.status === 401) {
          state.user = null;
          navigate("/login", { replace: true });
          return;
        }
        listContainer.replaceChildren(el("p", { class: "error empty", text: err.message }));
      });
  }

  // ---------- Rezepte-Tab ----------

  function renderRecipes() {
    const assistantWrap = el("div", {});
    const cards = el("div", { class: "recent-recipes" }, el("p", { class: "muted empty", text: "Lade Rezepte…" }));

    function loadRecipes() {
      api("/api/recipes")
        .then((data) => {
          cards.replaceChildren();
          if (!data.rezepte.length) {
            cards.append(
              el("p", { class: "muted empty", text: "Noch keine Rezepte – lass sie dir oben vom Assistenten erstellen." })
            );
            return;
          }
          for (const recipe of data.rezepte) cards.append(recipeCard(recipe));
        })
        .catch((err) => {
          if (err.status === 401) {
            state.user = null;
            navigate("/login", { replace: true });
            return;
          }
          cards.replaceChildren(el("p", { class: "error empty", text: err.message }));
        });
    }

    $app.replaceChildren(
      tabTopbar("Rezepte"),
      assistantWrap,
      el("h2", { class: "section-title", text: "Gespeicherte Rezepte" }),
      cards
    );
    loadRecipes();

    api("/api/lists")
      .then((data) => {
        if (!data.lists.length) {
          assistantWrap.replaceChildren(
            el("p", { class: "muted empty", text: "Lege zuerst eine Liste an – dann kann der Assistent loslegen." })
          );
          return;
        }
        assistantWrap.replaceChildren(
          createRecipeAssistant({
            lists: data.lists,
            loadOpenItems: async (id) => {
              try {
                const s = await api(`/api/list/${id}/snapshot`);
                return (s.items ?? []).filter((i) => !i.erledigt);
              } catch {
                return [];
              }
            },
            onSaved: ({ recipe, listId, listName, showSuccess }) => {
              loadRecipes();
              showSuccess(
                el(
                  "div",
                  { class: "card recipe-card preview" },
                  el("p", { class: "assistant-title", text: `✅ Zutaten sind auf „${listName}“` }),
                  el(
                    "div",
                    { class: "recipe-actions" },
                    el("a", {
                      class: "btn primary recipe-cook",
                      "data-link": "",
                      href: `/list/${listId}/kochen/${recipe.id}`,
                      text: "🍳 Loskochen",
                    }),
                    el("a", {
                      class: "btn ghost",
                      "data-link": "",
                      href: `/list/${listId}`,
                      text: "Zur Liste",
                    })
                  )
                )
              );
            },
          })
        );
      })
      .catch((err) => {
        if (err.status === 401) {
          state.user = null;
          navigate("/login", { replace: true });
          return;
        }
        assistantWrap.replaceChildren(el("p", { class: "error empty", text: err.message }));
      });
  }

  // ---------- Profil-Tab ----------

  const DIAET_OPTIONEN = ["keine", "vegetarisch", "vegan", "pescetarisch", "glutenfrei", "laktosefrei"];

  function renderProfile() {
    const logoutBtn = el("button", {
      class: "btn ghost logout-btn",
      type: "button",
      text: "Logout",
      onclick: async () => {
        try {
          await api("/api/auth/logout", { method: "POST" });
        } catch {
          // Cookie ist danach eh ungültig
        }
        state.user = null;
        navigate("/login", { replace: true });
      },
    });

    const card = el(
      "div",
      { class: "card profile-card" },
      el(
        "div",
        { class: "profile-row" },
        el("span", { class: "profile-icon", "aria-hidden": "true", text: "👤" }),
        el(
          "span",
          { class: "profile-main" },
          el("span", { class: "profile-name", text: state.user.displayName }),
          el("span", { class: "profile-mail muted", text: state.user.email })
        )
      ),
      logoutBtn
    );

    const prefsCard = el(
      "div",
      { class: "card profile-card" },
      el(
        "div",
        { class: "profile-row" },
        el("span", { class: "profile-icon", "aria-hidden": "true", text: "🥗" }),
        el(
          "span",
          { class: "profile-main" },
          el("span", { class: "profile-name", text: "Essens-Profil" }),
          el("span", { class: "profile-mail muted", text: "Der Koch-Assistent achtet darauf." })
        )
      )
    );

    const diaetLabel = el("label", { class: "prefs-label", for: "prefs-diaet", text: "Diätform" });
    const diaetSelect = el("select", {
      class: "input prefs-diaet",
      id: "prefs-diaet",
      "aria-label": "Diätform",
    });
    diaetSelect.replaceChildren(...DIAET_OPTIONEN.map((d) => el("option", { value: d, text: d === "keine" ? "Keine / egal" : d })));

    const allergeneInput = el("input", {
      class: "input",
      type: "text",
      placeholder: "Allergene, z. B. Erdnüsse, Gluten",
      maxlength: "300",
      autocomplete: "off",
    });
    const allergeneHint = el("p", { class: "muted prefs-hint", text: "Mit Komma getrennt – werden bei der Rezept-Generierung gemieden." });
    const prefsStatus = el("p", { class: "error prefs-status", hidden: true });
    const savePrefsBtn = el("button", {
      class: "btn primary prefs-save",
      type: "button",
      text: "Speichern",
      onclick: async () => {
        savePrefsBtn.disabled = true;
        prefsStatus.hidden = true;
        const allergene = allergeneInput.value
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20);
        try {
          await api("/api/preferences", { method: "PUT", body: { diaet: diaetSelect.value, allergene } });
          prefsStatus.classList.remove("error");
          prefsStatus.classList.add("prefs-ok");
          prefsStatus.textContent = "Gespeichert ✓";
          prefsStatus.hidden = false;
        } catch (err) {
          prefsStatus.classList.add("error");
          prefsStatus.classList.remove("prefs-ok");
          prefsStatus.textContent = err.message;
          prefsStatus.hidden = false;
        } finally {
          savePrefsBtn.disabled = false;
        }
      },
    });

    prefsCard.append(
      el(
        "div",
        { class: "prefs-form" },
        diaetLabel,
        diaetSelect,
        el("label", { class: "prefs-label", for: "prefs-allergene", text: "Allergene & Unverträglichkeiten" }),
        allergeneInput,
        allergeneHint,
        prefsStatus,
        savePrefsBtn
      )
    );

    // Bestehende Präferenzen laden
    api("/api/preferences")
      .then((data) => {
        if (data?.preferences?.diaet) diaetSelect.value = data.preferences.diaet;
        if (Array.isArray(data?.preferences?.allergene)) {
          allergeneInput.value = data.preferences.allergene.join(", ");
        }
      })
      .catch(() => {
        // Profil bleibt ohne Vorgaben nutzbar
      });

    const pushCard = el("div", { class: "card profile-card" });
    renderPushToggle(pushCard);

    $app.replaceChildren(tabTopbar("Profil"), card, prefsCard, pushCard);
  }

  // ---------- Listen-Detail ----------

  function leaveListView() {
    if (listConn) {
      listConn.close();
      listConn = null;
    }
    closeActiveSwipe = null;
  }

  // Kochmodus: Wake-Lock und Timer-Intervall beim Verlassen der Route freigeben
  let cookCleanup = null;

  function leaveCookView() {
    if (cookCleanup) {
      cookCleanup();
      cookCleanup = null;
    }
  }

  async function renderList(listId) {
    // Für den Koch-Assistenten auf der Startseite: zuletzt geöffnete Liste als Default
    localStorage.setItem("bl-last-list", listId);

    const items = []; // Server-Stand (wird bei jedem sync ersetzt)
    const history = []; // „Zuletzt gekauft“ aus dem Server-Stand
    const pendingAdds = []; // optimistisch hinzugefügte Artikel, warten auf den sync
    let popId = null; // Artikel, dessen Abhak-Animation beim nächsten refresh() läuft

    // ---------- Topbar ----------

    const statusDot = el("span", { class: "status-dot connecting" });
    const statusText = el("span", { class: "status-text", text: "Verbinde…" });
    const chipLabel = el("span", { class: "list-chip-label", text: "…" });
    const progressFill = el("div", { class: "progress-fill" });
    const progressText = el("span", { class: "progress-text" });

    // Einstieg zum Verlauf: die bisher tote Fortschrittszeile wird antippbar
    const progressBtn = el(
      "button",
      {
        class: "progress-btn",
        type: "button",
        "aria-haspopup": "dialog",
        "aria-label": "Zuletzt gekauft anzeigen",
        title: "Zuletzt gekauft",
        onclick: () => openHistorySheet(),
      },
      progressText
    );

    const chip = el(
      "button",
      { class: "list-chip", type: "button", "aria-haspopup": "dialog", onclick: () => openListSwitcher() },
      chipLabel,
      el("span", { class: "list-chip-caret", "aria-hidden": "true", text: "▾" })
    );

    const header = el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-inner" },
        el("a", { class: "icon-btn", "data-link": "", href: "/", "aria-label": "Zur Übersicht", text: "‹" }),
        chip,
        el("button", {
          class: "icon-btn",
          type: "button",
          "aria-label": "Mitglieder verwalten",
          text: "👥",
          onclick: () => openMembersSheet(),
        })
      ),
      el(
        "div",
        { class: "topbar-meta" },
        el("div", { class: "progress", "aria-hidden": "true" }, progressFill),
        progressBtn,
        el("span", { class: "status" }, statusDot, statusText)
      )
    );

    async function shareInvite() {
      try {
        const data = await api(`/api/list/${listId}/invite`);
        if (navigator.share) {
          await navigator.share({ title: "Buylist-Einladung", text: "Tretet meiner Einkaufsliste bei:", url: data.url });
        } else {
          await navigator.clipboard.writeText(data.url);
          toast("Einladungslink kopiert!");
        }
      } catch (err) {
        if (err.name !== "AbortError") toast(err.message);
      }
    }

    // ---------- Mitglieder-Verwaltung (Bottom-Sheet) ----------

    function openMembersSheet() {
      openSheet((sheet, close) => {
        const membersWrap = el("div", { class: "sheet-list" }, el("p", { class: "muted empty", text: "Lade Mitglieder…" }));
        const actionRowWrap = el("div", {});
        sheet.append(
          el("div", { class: "sheet-handle", "aria-hidden": "true" }),
          el("h2", { class: "sheet-title", text: "Mitglieder" }),
          membersWrap,
          el(
            "button",
            { class: "sheet-row sheet-row-action", type: "button", onclick: () => shareInvite() },
            el("span", { class: "sheet-row-name", text: "🔗 Einladungslink teilen" })
          ),
          actionRowWrap
        );

        async function loadMembers() {
          try {
            const meData = await api("/api/auth/me");
            state.user = meData.user;
            const me = state.user.id;
            const data = await api(`/api/list/${listId}/members`);
            const isOwner = data.ownerId ? data.ownerId === me : data.members.some((m) => m.id === me && m.role === "owner");
            membersWrap.replaceChildren();
            if (!data.members.length) {
              membersWrap.append(el("p", { class: "muted empty", text: "Keine Mitglieder." }));
            }
            for (const member of data.members) {
              const actions = [];
              if (isOwner && member.id !== me && member.role !== "owner") {
                actions.push(
                  el(
                    "button",
                    {
                      class: "member-action",
                      type: "button",
                      "aria-label": `Entfernen: ${member.displayName}`,
                      text: "✕",
                      onclick: () => removeMember(member.id, loadMembers),
                    }
                  )
                );
                actions.push(
                  el(
                    "button",
                    {
                      class: "member-action transfer",
                      type: "button",
                      "aria-label": `Owner übertragen an ${member.displayName}`,
                      text: "Owner",
                      title: "Owner-Rolle übertragen",
                      onclick: () => transferOwner(member.id),
                    }
                  )
                );
              }
              membersWrap.append(
                el(
                  "div",
                  { class: "sheet-row member-row" },
                  el(
                    "span",
                    { class: "sheet-row-name" },
                    el("span", { text: member.displayName }),
                    el("span", { class: "muted member-sub", text: member.id === me ? "Du" : member.email })
                  ),
                  el(
                    "span",
                    { class: "member-role" + (member.role === "owner" ? " owner" : ""), text: member.role === "owner" ? "Owner" : "Mitglied" }
                  ),
                  ...actions
                )
              );
            }

            // Aktionen am Ende des Sheets: Verlassen immer möglich. Nur das
            // Verlassen eines Owners kann serverseitig die Liste löschen (wenn er
            // das letzte Mitglied ist) – deshalb immer bewaffneter 2-Tap-Button,
            // unabhängig vom (evtl. veralteten) Sheet-Snapshot. Der Owner bekommt
            // zusätzlich die Lösch-Aktion.
            const alone = data.members.length === 1;
            const leaveAction = alone || isOwner
              ? deleteButton({
                  cls: "sheet-row sheet-row-action del-list",
                  icon: "🚪",
                  caption: "Liste verlassen",
                  confirmText: alone ? "Liste wird gelöscht. Sicher?" : "Wirklich verlassen?",
                  ariaLabel: "Liste verlassen",
                  onConfirm: () => leaveList(close),
                })
              : el(
                  "button",
                  { class: "sheet-row sheet-row-action", type: "button", onclick: () => leaveList(close) },
                  el("span", { class: "sheet-row-name", text: "🚪 Liste verlassen" })
                );
            if (isOwner) {
              actionRowWrap.replaceChildren(
                leaveAction,
                el(
                  "div",
                  { class: "del-list-wrap" },
                  deleteButton({
                    cls: "sheet-row sheet-row-action del-list",
                    icon: "🗑",
                    caption: "Liste löschen",
                    confirmText: "Wirklich löschen?",
                    ariaLabel: "Liste löschen",
                    onConfirm: async () => {
                      try {
                        await api(`/api/list/${listId}`, { method: "DELETE" });
                        toast("Liste gelöscht");
                        close();
                        navigate("/", { replace: true });
                      } catch (err) {
                        if (err.status === 403) {
                          toast("Du bist nicht (mehr) der Owner dieser Liste.");
                          loadMembers();
                        } else {
                          toast(err.message);
                        }
                      }
                    },
                  }),
                  el("p", {
                    class: "muted del-list-hint",
                    text: "Alle Artikel, Rezepte und wiederkehrenden Artikel werden gelöscht – alle Mitglieder verlieren den Zugriff. Nicht rückgängig zu machen.",
                  })
                )
              );
            } else {
              actionRowWrap.replaceChildren(leaveAction);
            }
          } catch (err) {
            if (err.status === 401) {
              state.user = null;
              navigate("/login", { replace: true });
              return;
            }
            membersWrap.replaceChildren(el("p", { class: "error empty", text: err.message }));
          }
        }

        async function removeMember(userId, reload) {
          try {
            await api(`/api/list/${listId}/members`, { method: "DELETE", body: { userId } });
            toast("Mitglied entfernt");
            reload();
          } catch (err) {
            toast(err.message);
          }
        }

        async function transferOwner(userId) {
          try {
            await api(`/api/list/${listId}/owner`, { method: "POST", body: { userId } });
            toast("Owner übertragen");
            loadMembers();
          } catch (err) {
            toast(err.message);
          }
        }

        async function leaveList(sheetClose) {
          try {
            const res = await api(`/api/list/${listId}/leave`, { method: "POST" });
            toast(res?.deleted ? "Liste verlassen und gelöscht" : "Liste verlassen");
            sheetClose();
            navigate("/", { replace: true });
          } catch (err) {
            toast(err.message);
          }
        }

        loadMembers();
      });
    }

    // ---------- Listen-Switcher (Bottom-Sheet) ----------

    function openListSwitcher() {
      openSheet((sheet, close) => {
        const listWrap = el("div", { class: "sheet-list" }, el("p", { class: "muted empty", text: "Lade Listen…" }));
        sheet.append(
          el("div", { class: "sheet-handle", "aria-hidden": "true" }),
          el("h2", { class: "sheet-title", text: "Liste wechseln" }),
          listWrap
        );
        api("/api/lists")
          .then((data) => {
            listWrap.replaceChildren();
            for (const list of data.lists) {
              const current = list.id === listId;
              listWrap.append(
                el(
                  "a",
                  {
                    class: "sheet-row" + (current ? " current" : ""),
                    "data-link": "",
                    href: `/list/${list.id}`,
                    onclick: () => close(),
                  },
                  el("span", { class: "sheet-row-name", text: list.name }),
                  current ? el("span", { class: "sheet-check", "aria-label": "Aktuelle Liste", text: "✓" }) : null,
                  el("span", { class: "chevron", "aria-hidden": "true", text: "›" })
                )
              );
            }
            listWrap.append(
              el(
                "button",
                {
                  class: "sheet-row sheet-row-action",
                  type: "button",
                  onclick: () => {
                    close();
                    openRecurringSheet();
                  },
                },
                el("span", { class: "sheet-row-name", text: "Wiederkehrende Artikel…" }),
                el("span", { class: "chevron", "aria-hidden": "true", text: "›" })
              ),
              el(
                "a",
                { class: "sheet-row sheet-row-new", "data-link": "", href: "/", onclick: () => close() },
                el("span", { class: "sheet-row-name", text: "Alle Listen & neue Liste…" })
              )
            );
          })
          .catch((err) => listWrap.replaceChildren(el("p", { class: "error empty", text: err.message })));
      });
    }

    // ---------- Verlauf „Zuletzt gekauft“ (Bottom-Sheet) ----------

    function openHistorySheet() {
      openSheet((sheet) => {
        sheet.append(
          el("div", { class: "sheet-handle", "aria-hidden": "true" }),
          el("h2", { class: "sheet-title", text: "Zuletzt gekauft" }),
          el("p", { class: "sheet-sub muted", text: "Abgehakte Artikel landen hier – zum Wiederbestellen antippen." })
        );
        if (!history.length) {
          sheet.append(
            el("p", { class: "muted empty", text: "Noch nichts gekauft. Hake Artikel ab, und sie erscheinen hier." })
          );
          return;
        }
        const openKeys = new Set(items.filter((i) => !i.erledigt).map((i) => normKey(i.name)));
        const chips = el("div", { class: "hist-chips" });
        for (const entry of history) {
          const onList = openKeys.has(normKey(entry.name));
          const chipEl = el(
            "button",
            {
              class: "hist-chip" + (onList ? " onlist" : ""),
              type: "button",
              disabled: onList ? "" : undefined,
            },
            el("span", { class: "hist-chip-name", text: entry.name }),
            el("span", {
              class: "hist-chip-sub muted",
              text: onList ? "auf der Liste" : [entry.menge, relTime(entry.gekauftAm)].filter(Boolean).join(" · "),
            })
          );
          if (!onList) {
            chipEl.addEventListener("click", () => {
              if (!listConn || listConn.readyState() !== WebSocket.OPEN) {
                toast("Nicht verbunden – versuch es gleich nochmal.");
                return;
              }
              listConn.send({ type: "add", name: entry.name, menge: entry.menge, kategorie: classify(entry.name) });
              pendingAdds.push({
                id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: entry.name,
                menge: entry.menge,
                kategorie: classify(entry.name),
                erledigt: false,
                hinzugefuegtVon: state.user.displayName,
                timestamp: Date.now(),
                pending: true,
              });
              refresh();
              chipEl.classList.add("added");
              chipEl.disabled = true;
              chipEl.replaceChildren(
                el("span", { class: "hist-chip-name", text: entry.name }),
                el("span", { class: "hist-chip-sub", text: "✓ auf die Liste" })
              );
            });
          }
          chips.append(chipEl);
        }
        sheet.append(chips);
      });
    }

    // ---------- Wiederkehrende Artikel (Bottom-Sheet) ----------

    const INTERVALL_OPTIONEN = [
      { tage: 7, label: "wöchentlich" },
      { tage: 14, label: "alle 2 Wochen" },
      { tage: 30, label: "monatlich" },
    ];

    function intervallLabel(tage) {
      const treffer = INTERVALL_OPTIONEN.find((o) => o.tage === tage);
      if (treffer) return treffer.label;
      return tage === 1 ? "täglich" : `alle ${tage} Tage`;
    }

    function openRecurringSheet() {
      openSheet((sheet, close) => {
        sheet.append(
          el("div", { class: "sheet-handle", "aria-hidden": "true" }),
          el("h2", { class: "sheet-title", text: "Wiederkehrende Artikel" }),
          el("p", {
            class: "sheet-sub muted",
            text: "Fällige Artikel erscheinen automatisch auf der Liste – ohne Erinnerung, ohne Badge.",
          })
        );

        const rulesWrap = el("div", { class: "sheet-list" }, el("p", { class: "muted empty", text: "Lade Regeln…" }));
        sheet.append(rulesWrap);

        async function loadRules() {
          try {
            const data = await api(`/api/list/${listId}/recurring`);
            rulesWrap.replaceChildren();
            if (!data.recurring.length) {
              rulesWrap.append(
                el("p", { class: "muted empty", text: "Noch keine Regeln. z. B. „Toilettenpapier alle 2 Wochen“." })
              );
              return;
            }
            for (const rule of data.recurring) {
              const delBtn = deleteButton({
                cls: "recurring-del",
                icon: "✕",
                confirmText: "Wirklich?",
                ariaLabel: `Regel „${rule.name}“ löschen`,
                onConfirm: async () => {
                  try {
                    await api(`/api/list/${listId}/recurring/${rule.id}`, { method: "DELETE" });
                    loadRules();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              });
              rulesWrap.append(
                el(
                  "div",
                  { class: "sheet-row recurring-row" },
                  el(
                    "span",
                    { class: "sheet-row-name" },
                    el("span", { text: rule.name }),
                    rule.menge ? el("span", { class: "muted", text: ` · ${rule.menge}` }) : null
                  ),
                  el("span", { class: "recurring-interval muted", text: intervallLabel(rule.intervallTage) }),
                  delBtn
                )
              );
            }
          } catch (err) {
            rulesWrap.replaceChildren(el("p", { class: "error empty", text: err.message }));
          }
        }
        loadRules();

        // Neue Regel anlegen
        const nameInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "Artikel, z. B. Toilettenpapier",
          maxlength: "120",
          "aria-label": "Artikel",
        });
        const mengeInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "Menge (optional)",
          maxlength: "40",
          "aria-label": "Menge",
        });
        const intervallSelect = el(
          "select",
          { class: "input", "aria-label": "Intervall" },
          ...INTERVALL_OPTIONEN.map((o, i) =>
            el("option", { value: String(o.tage), selected: i === 1 ? "" : undefined, text: o.label })
          ),
          el("option", { value: "custom", text: "eigenes Intervall…" })
        );
        const customWrap = el("div", { class: "recurring-custom", hidden: "" });
        const customInput = el("input", {
          class: "input",
          type: "number",
          min: "1",
          max: "365",
          placeholder: "Tage",
          "aria-label": "Intervall in Tagen",
        });
        customWrap.append(customInput);
        intervallSelect.addEventListener("change", () => {
          customWrap.hidden = intervallSelect.value !== "custom";
        });

        const addBtn = el("button", { class: "btn primary recurring-add", type: "button", text: "Regel anlegen" });
        addBtn.addEventListener("click", async () => {
          const name = nameInput.value.trim();
          if (!name) {
            toast("Bitte gib einen Artikel an.");
            nameInput.focus();
            return;
          }
          const tage =
            intervallSelect.value === "custom" ? Number(customInput.value) : Number(intervallSelect.value);
          if (!Number.isInteger(tage) || tage < 1 || tage > 365) {
            toast("Das Intervall muss zwischen 1 und 365 Tagen liegen.");
            return;
          }
          addBtn.disabled = true;
          try {
            await api(`/api/list/${listId}/recurring`, {
              method: "POST",
              body: { name, menge: mengeInput.value, intervallTage: tage },
            });
            nameInput.value = "";
            mengeInput.value = "";
            loadRules();
          } catch (err) {
            toast(err.message);
          } finally {
            addBtn.disabled = false;
          }
        });

        sheet.append(
          el(
            "div",
            { class: "recurring-form" },
            nameInput,
            mengeInput,
            el("div", { class: "recurring-form-row" }, intervallSelect, addBtn),
            customWrap
          ),
          el(
            "button",
            { class: "btn ghost recurring-done", type: "button", text: "Fertig", onclick: () => close() }
          )
        );
      });
    }

    // ---------- Artikel-Liste ----------

    const itemsEl = el("ul", { class: "items" }, ...skeletonCells());
    const emptyEl = el(
      "div",
      { class: "empty-state", hidden: true },
      el("div", { class: "empty-icon", "aria-hidden": "true", text: "🧺" }),
      el("p", { class: "empty-title", text: "Dein Zettel ist leer" }),
      el("p", { class: "empty-sub muted", text: "Schreib unten rein, was du brauchst – z. B. „Milch“ oder „2× Apfel“." })
    );

    const doneLabel = el("span", { class: "done-label" });
    const doneClear = deleteButton({
      cls: "done-clear",
      caption: "Entfernen",
      confirmText: "Wirklich entfernen?",
      ariaLabel: "Erledigte Artikel entfernen",
      onConfirm: clearDoneItems,
    });
    const doneDivider = el("li", { class: "done-divider", hidden: true }, doneLabel, doneClear);

    function skeletonCells() {
      return [0, 1, 2, 3].map(() =>
        el(
          "li",
          { class: "swipe-cell skeleton-cell", "aria-hidden": "true" },
          el(
            "div",
            { class: "swipe-content" },
            el("span", { class: "skeleton-circle" }),
            el("span", { class: "skeleton-lines" }, el("span", { class: "skeleton-line" }), el("span", { class: "skeleton-line short" }))
          )
        )
      );
    }

    function checkSvg() {
      return el(
        "svg",
        { class: "check-svg", viewBox: "0 0 30 30", "aria-hidden": "true" },
        el("circle", { class: "ring", cx: "15", cy: "15", r: "13" }),
        el("path", { class: "check-path", d: "M9 15.5l4 4L21 10.5" })
      );
    }

    // Swipe-Geste: horizontales Aufziehen legt die Löschen-Fläche dahinter bloß,
    // vertikales Scrollen bleibt unberührt (touch-action: pan-y).
    const SWIPE_MAX = 88;
    let openSwipe = null;

    function closeOpenSwipe() {
      if (!openSwipe) return;
      openSwipe.close();
      openSwipe = null;
    }

    function attachSwipe(cell, content) {
      let startX = 0;
      let startY = 0;
      let dx = 0;
      let tracking = false;
      let horizontal = null;

      const setX = (x, animate) => {
        content.style.transition = animate ? "" : "none";
        content.style.transform = x ? `translateX(${x}px)` : "";
        cell.classList.toggle("swiped", x < 0); // Löschen-Fläche nur sichtbar, wenn wirklich offen
      };
      const close = () => setX(0, true);
      // Nach einer echten Zieh-Bewegung den danach folgenden Klick schlucken.
      const swallowClick = () => {
        const swallow = (event) => {
          event.stopPropagation();
          event.preventDefault();
        };
        content.addEventListener("click", swallow, true);
        setTimeout(() => content.removeEventListener("click", swallow, true), 400);
      };

      content.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        startX = event.clientX;
        startY = event.clientY;
        dx = 0;
        horizontal = null;
        tracking = true;
      });

      content.addEventListener("pointermove", (event) => {
        if (!tracking) return;
        const mx = event.clientX - startX;
        const my = event.clientY - startY;
        if (horizontal === null) {
          if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
          if (Math.abs(mx) <= Math.abs(my)) {
            tracking = false; // vertikales Scrollen gewinnt
            return;
          }
          horizontal = true;
          try {
            content.setPointerCapture(event.pointerId);
          } catch {
            // nicht schlimm – Ziehen funktioniert trotzdem
          }
          closeOpenSwipe();
          openSwipe = { close, cell };
          content.classList.add("dragging");
          swallowClick();
        }
        dx = Math.max(-SWIPE_MAX, Math.min(0, mx)); // nur nach links
        setX(dx, false);
      });

      const finish = () => {
        if (!tracking) return;
        tracking = false;
        if (horizontal !== true) return;
        content.classList.remove("dragging");
        if (dx >= -SWIPE_MAX * 0.4) {
          setX(0, true);
          if (openSwipe?.close === close) openSwipe = null;
        }
      };
      content.addEventListener("pointerup", finish);
      content.addEventListener("pointercancel", finish);
    }

    function renderItem(item) {
      const li = el("li", {
        class: "swipe-cell" + (item.erledigt ? " done" : "") + (item.pending ? " pending" : ""),
      });
      const content = el("div", { class: "swipe-content" });

      const checkbox = el(
        "button",
        {
          class: "checkbox" + (item.erledigt ? " checked" : "") + (item.pending ? " pending" : ""),
          type: "button",
          "aria-pressed": String(item.erledigt),
          "aria-label": item.pending
            ? "Wird hinzugefügt…"
            : item.erledigt
              ? "Als offen markieren"
              : "Als erledigt abhaken",
          disabled: item.pending ? "" : undefined,
        },
        checkSvg()
      );
      checkbox.addEventListener("click", () => {
        if (item.pending) return;
        item.erledigt = !item.erledigt;
        popId = item.erledigt ? item.id : null; // Animation nur beim Abhaken
        listConn?.send({ type: "toggle", itemId: item.id, erledigt: item.erledigt });
        refresh();
      });

      const remove = () => removeItem(item, li);
      const swipeDelete = deleteButton({
        cls: "swipe-delete",
        icon: "🗑",
        caption: "Löschen",
        confirmText: "Sicher?",
        ariaLabel: "Artikel löschen",
        onConfirm: remove,
      });

      content.append(
        checkbox,
        el(
          "div",
          { class: "item-main" },
          el("span", { class: "item-name", text: item.name }),
          el("span", {
            class: "item-meta",
            text: item.pending ? "wird hinzugefügt…" : [item.menge, `von ${item.hinzugefuegtVon}`].filter(Boolean).join(" · "),
          })
        )
      );

      // Desktop/Tastatur: Papierkorb am Zeilenende (Hover/Fokus), gleiche Bestätigung
      if (!item.pending) {
        content.append(
          deleteButton({
            cls: "delete-btn",
            icon: "🗑",
            caption: "",
            confirmText: "Sicher?",
            ariaLabel: "Artikel löschen",
            onConfirm: remove,
          })
        );
      }

      li.append(el("div", { class: "swipe-action" }, swipeDelete), content);
      attachSwipe(li, content);

      if (popId === item.id) {
        popId = null;
        if (item.erledigt) {
          li.classList.add("just-done");
          content.querySelector(".checkbox")?.classList.add("pop");
        }
        li.classList.add("pop-settle");
      }
      return li;
    }

    function removeItem(item, li) {
      if (item.pending) {
        // noch nicht bestätigt – nur lokal wegnehmen
        const idx = pendingAdds.indexOf(item);
        if (idx >= 0) pendingAdds.splice(idx, 1);
        refresh();
        return;
      }
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx >= 0) items.splice(idx, 1);
      listConn?.send({ type: "delete", itemId: item.id });
      li.classList.add("removing");
      setTimeout(() => refresh(), 170);
    }

    function clearDoneItems() {
      const doneItems = items.filter((i) => i.erledigt);
      if (!doneItems.length) return;
      for (const it of doneItems) listConn?.send({ type: "delete", itemId: it.id });
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].erledigt) items.splice(i, 1);
      }
      refresh();
      toast(`${doneItems.length} erledigte${doneItems.length === 1 ? "r Artikel" : " Artikel"} entfernt`);
    }

    function refresh() {
      closeOpenSwipe();
      const open = [];
      const done = [];
      for (const it of items) (it.erledigt ? done : open).push(it);
      done.sort((a, b) => a.timestamp - b.timestamp);
      const openAll = [...open, ...pendingAdds];

      // Nach Kategorie gruppieren (feste Markt-Reihenfolge), im Gruppenuntergang
      // nach Zeit; Header nur ab zwei Gruppen, damit Ein-Kategorie-Listen ruhig bleiben.
      const order = categoryOrder();
      const groups = new Map();
      for (const it of openAll) {
        const id = it.kategorie && order.includes(it.kategorie) ? it.kategorie : SONSTIGES;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(it);
      }
      for (const group of groups.values()) group.sort((a, b) => a.timestamp - b.timestamp);

      const frag = document.createDocumentFragment();
      const groupIds = order.filter((id) => groups.has(id));
      const showHeaders = groupIds.length > 1;
      for (const id of groupIds) {
        if (showHeaders) {
          frag.append(el("li", { class: "cat-divider" }, el("span", { class: "cat-label", text: categoryLabel(id) })));
        }
        for (const it of groups.get(id)) frag.append(renderItem(it));
      }

      doneDivider.hidden = done.length === 0;
      if (done.length) {
        doneLabel.textContent = `Erledigt · ${done.length}`;
        frag.append(doneDivider);
        for (const it of done) frag.append(renderItem(it));
      } else {
        doneClear.reset?.();
      }
      itemsEl.replaceChildren(frag);

      const total = items.length;
      progressText.textContent = total ? `${done.length} von ${total} erledigt` : "";
      progressFill.style.width = total ? `${Math.round((done.length / total) * 100)}%` : "0%";
      emptyEl.hidden = total > 0 || pendingAdds.length > 0;
    }

    // ---------- Add-Bar ----------

    const nameInput = el("input", {
      class: "input",
      type: "text",
      placeholder: "Artikel, z. B. Milch",
      maxlength: "120",
      autocomplete: "off",
      enterkeyhint: "send",
    });
    const mengeInput = el("input", {
      class: "input menge",
      type: "text",
      placeholder: "2× / 500g",
      maxlength: "40",
      autocomplete: "off",
    });
    const addBtn = el("button", { class: "btn primary add-btn", type: "submit", "aria-label": "Artikel hinzufügen", text: "+" });

    const addForm = el(
      "form",
      {
        class: "add-bar",
        onsubmit: (event) => {
          event.preventDefault();
          const name = nameInput.value.trim();
          const menge = mengeInput.value.trim();
          if (!name) {
            nameInput.focus();
            return;
          }
          if (!listConn || listConn.readyState() !== WebSocket.OPEN) {
            toast("Nicht verbunden – versuch es gleich nochmal.");
            return;
          }
          // Server führt Duplikate zusammen – hier nur User-Feedback dazu
          const dup = [...items, ...pendingAdds].some(
            (i) => !i.erledigt && normKey(i.name) === normKey(name)
          );
          const kategorie = classify(name);
          listConn.send({ type: "add", name, menge: menge || undefined, kategorie });
          pendingAdds.push({
            id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            menge: menge || undefined,
            kategorie,
            erledigt: false,
            hinzugefuegtVon: state.user.displayName,
            timestamp: Date.now(),
            pending: true,
          });
          nameInput.value = "";
          mengeInput.value = "";
          refresh();
          if (dup) toast(`„${name}“ ist schon auf der Liste – Menge ergänzt.`);
          itemsEl.querySelector(".pending")?.scrollIntoView({ block: "nearest" });
          nameInput.focus();
        },
      },
      nameInput,
      mengeInput,
      addBtn
    );

    // ---------- Anzeigen ----------

    $app.replaceChildren(header, itemsEl, emptyEl, addForm);

    // sync verarbeiten: Pending-Adds abgleichen, nur neu zeichnen, wenn sich
    // wirklich etwas geändert hat (sonst würden Animationen abgewürgt).
    function reconcilePending(serverItems) {
      if (!pendingAdds.length) return;
      const names = new Set(serverItems.map((i) => i.name.trim().toLowerCase()));
      for (let i = pendingAdds.length - 1; i >= 0; i--) {
        if (names.has(pendingAdds[i].name.trim().toLowerCase())) pendingAdds.splice(i, 1);
      }
    }

    function applyList(list) {
      chipLabel.textContent = list.name;
      const hadPending = pendingAdds.length > 0;
      reconcilePending(list.items);
      const same = JSON.stringify([list.items, list.history]) === JSON.stringify([items, history]);
      items.length = 0;
      items.push(...list.items);
      history.length = 0;
      history.push(...(list.history ?? []));
      if (!same || hadPending) refresh();
    }

    // Erst Snapshot (initiales Laden), dann WebSocket für Live-Updates
    try {
      const snapshot = await api(`/api/list/${listId}/snapshot`);
      chipLabel.textContent = snapshot.name;
      items.length = 0;
      items.push(...snapshot.items);
      history.length = 0;
      history.push(...(snapshot.history ?? []));
      refresh();
    } catch (err) {
      if (err.status === 404) {
        toast("Liste nicht gefunden.");
        navigate("/", { replace: true });
        return;
      }
      if (err.status === 401) {
        state.user = null;
        navigate("/login", { replace: true });
        return;
      }
      toast(err.message);
      itemsEl.replaceChildren(
        el("li", { class: "list-error" }, el("p", { class: "error empty", text: "Liste konnte nicht geladen werden." }))
      );
      return;
    }

    listConn = openListSocket(listId, {
      onSync: applyList,
      onStatus(status) {
        statusDot.className = `status-dot ${status}`;
        statusText.textContent =
          status === "open" ? "Live" : status === "connecting" ? "Verbinde…" : "Neu verbinden…";
      },
    });

    closeActiveSwipe = closeOpenSwipe;
  }

  function openListSocket(listId, { onSync, onStatus }) {
    let ws = null;
    let closedByUs = false;
    let attempt = 0;
    let pingTimer = null;
    let reconnectTimer = null;

    function clearTimers() {
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      pingTimer = null;
      reconnectTimer = null;
    }

    function scheduleReconnect() {
      attempt += 1;
      const delay = Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4));
      onStatus("reconnecting");
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/list/${listId}/ws`);
      onStatus(attempt === 0 ? "connecting" : "reconnecting");

      ws.onopen = () => {
        attempt = 0;
        onStatus("open");
        // Heartbeat: "ping" beantwortet das DO per Auto-Response, ohne zu erwachen.
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 25_000);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "sync") onSync(msg.list);
          else if (msg.type === "deleted") {
            clearTimers();
            closedByUs = true;
            try {
              ws.close();
            } catch {
              // schon zu
            }
            toast("Die Liste wurde gelöscht.");
            navigate("/", { replace: true });
          } else if (msg.type === "error" && msg.message) toast(msg.message);
        } catch {
          // fehlerhafte Nachrichten ignorieren
        }
      };
      ws.onclose = () => {
        clearTimers();
        if (closedByUs) return;
        // Client ohne offene Verbindung verpasst das "deleted"-Broadcast. Statt
        // endlos neu zu verbinden, prüfen wir per Snapshot, ob die Liste noch
        // existiert – 404/401 heißt "Liste weg" und führt zur Übersicht.
        api(`/api/list/${listId}/snapshot`)
          .then(() => scheduleReconnect())
          .catch((err) => {
            if (err.status === 404 || err.status === 401) {
              toast("Die Liste wurde gelöscht.");
              navigate("/", { replace: true });
            } else {
              scheduleReconnect();
            }
          });
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // schon zu
        }
      };
    }

    connect();

    return {
      send(message) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      readyState: () => (ws ? ws.readyState : WebSocket.CONNECTING),
      close() {
        closedByUs = true;
        clearTimers();
        if (ws) {
          try {
            ws.close();
          } catch {
            // schon zu
          }
        }
      },
    };
  }

  // ---------- Kochmodus (eigene, bewusst betretene Route) ----------

  function renderCook(listId, recipeId) {
    const shell = el("p", { class: "muted empty", text: "Rezept wird geladen…" });
    $app.replaceChildren(shell);

    api(`/api/list/${listId}/recipes`)
      .then((data) => {
        const recipe = (data.rezepte ?? []).find((r) => r.id === recipeId);
        if (!recipe) {
          toast("Rezept nicht gefunden.");
          navigate(`/list/${listId}`, { replace: true });
          return;
        }
        mountCook(listId, recipe);
      })
      .catch((err) => {
        if (err.status === 401) {
          state.user = null;
          navigate("/login", { replace: true });
          return;
        }
        if (err.status === 404) {
          toast("Liste nicht gefunden.");
          navigate("/", { replace: true });
          return;
        }
        shell.textContent = err.message || "Rezept konnte nicht geladen werden.";
        shell.className = "error empty";
      });
  }

  function mountCook(listId, recipe) {
    const steps = parseSteps(recipe.schritte);
    const SKEY = `bl-cook:${listId}:${recipe.id}`;

    // Sitzungsstatus (Schritt, Portionen, abgehakte Zutaten, laufender Timer)
    // lebt bewusst nur im localStorage – kein Sync-Overhead, Fortschritt bleibt
    // beim Neu laden und Wiederkommen erhalten.
    function loadCookState() {
      const base = {
        step: 0,
        portions: recipe.portionen,
        checked: recipe.zutaten.map(() => false),
        timerEnd: null,
      };
      try {
        const raw = JSON.parse(localStorage.getItem(SKEY) ?? "null");
        if (raw && typeof raw === "object") {
          base.step = Math.min(Math.max(0, Number(raw.step) || 0), steps.length);
          base.portions = Math.min(12, Math.max(1, Number(raw.portions) || recipe.portionen));
          base.checked = recipe.zutaten.map((_, i) => !!(Array.isArray(raw.checked) && raw.checked[i]));
          base.timerEnd = typeof raw.timerEnd === "number" && raw.timerEnd > Date.now() ? raw.timerEnd : null;
        }
      } catch {
        // kaputter Stand → zurücksetzen
      }
      return base;
    }

    let cook = loadCookState();

    function saveCookState() {
      try {
        localStorage.setItem(SKEY, JSON.stringify(cook));
      } catch {
        // Speichern ist optional
      }
    }

    // ---------- Topbar ----------

    const header = el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-inner" },
        el("a", { class: "icon-btn", "data-link": "", href: `/list/${listId}`, "aria-label": "Zurück zur Liste", text: "‹" }),
        el("h1", { class: "topbar-title cook-title", text: recipe.titel }),
        el("span", { class: "icon-btn", style: "visibility:hidden", "aria-hidden": "true", text: "‹" })
      )
    );

    // ---------- Zutaten ----------

    const portionenVal = el("span", { class: "cook-portions-val", text: String(cook.portions) });
    const ingList = el("ul", { class: "cook-ings" });

    function paintIngredients() {
      const factor = cook.portions / (recipe.portionen || 1);
      ingList.replaceChildren(
        ...recipe.zutaten.map((z, i) => {
          const checked = !!cook.checked[i];
          return el(
            "li",
            {},
            el(
              "button",
              {
                class: "cook-ing" + (checked ? " checked" : ""),
                type: "button",
                "aria-pressed": String(checked),
                "aria-label": `${z.name} ${checked ? "wieder brauchen" : "schon da"}`,
                onclick: () => {
                  cook.checked[i] = !cook.checked[i];
                  saveCookState();
                  paintIngredients();
                },
              },
              el("span", { class: "cook-ing-dot", "aria-hidden": "true" }),
              z.menge ? el("span", { class: "cook-ing-menge", text: scaleMenge(z.menge, factor) }) : null,
              el("span", { class: "cook-ing-name", text: z.name })
            )
          );
        })
      );
    }

    function changePortions(delta) {
      const next = Math.min(12, Math.max(1, cook.portions + delta));
      if (next === cook.portions) return;
      cook.portions = next;
      portionenVal.textContent = String(cook.portions);
      saveCookState();
      paintIngredients();
    }

    const ingCard = el(
      "section",
      { class: "card cook-card" },
      el(
        "div",
        { class: "cook-card-head" },
        el("h2", { class: "cook-card-label", text: "Zutaten" }),
        el(
          "div",
          { class: "cook-portions" },
          el("span", { class: "cook-portions-label muted", text: "Portionen" }),
          el("button", {
            class: "cook-portion-btn",
            type: "button",
            "aria-label": "Eine Portion weniger",
            text: "−",
            onclick: () => changePortions(-1),
          }),
          portionenVal,
          el("button", {
            class: "cook-portion-btn",
            type: "button",
            "aria-label": "Eine Portion mehr",
            text: "+",
            onclick: () => changePortions(1),
          })
        )
      ),
      ingList
    );

    // ---------- Schritt ----------

    const stepLabel = el("span", { class: "cook-step-label" });
    const dots = el("span", { class: "cook-dots", "aria-hidden": "true" });
    const stepText = el("p", { class: "cook-step-text" });
    const timerArea = el("div", { class: "cook-timer-row" });
    const advanceBtn = el("button", { class: "btn primary cook-advance", type: "button" });
    const backBtn = el("button", { class: "btn ghost cook-back", type: "button", text: "‹ Zurück" });

    const stepCard = el(
      "section",
      { class: "card cook-card cook-step-card" },
      el("div", { class: "cook-card-head" }, stepLabel, dots),
      stepText,
      timerArea,
      el("div", { class: "cook-nav" }, backBtn, advanceBtn)
    );

    // ---------- Abschluss ----------

    const finishCard = el(
      "section",
      { class: "card cook-card cook-finish", hidden: true },
      el("div", { class: "cook-finish-icon", "aria-hidden": "true", text: "🎉" }),
      el("p", { class: "cook-finish-title", text: "Fertig!" }),
      el("p", { class: "muted", text: `„${recipe.titel}“ ist zubereitet. Guten Appetit!` }),
      el("a", { class: "btn primary", "data-link": "", href: `/list/${listId}`, text: "Zur Liste zurück" }),
      el("button", {
        class: "btn ghost",
        type: "button",
        text: "Von vorn beginnen",
        onclick: () => {
          cook = {
            step: 0,
            portions: cook.portions,
            checked: recipe.zutaten.map(() => false),
            timerEnd: null,
          };
          portionenVal.textContent = String(cook.portions);
          saveCookState();
          paintIngredients();
          paintStep();
          window.scrollTo({ top: 0 });
        },
      })
    );

    // ---------- Timer (einer gleichzeitig) ----------

    let timerInterval = null;
    let timerDone = false;

    function clearTimerInterval() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    function startTimer(sekunden) {
      timerDone = false;
      cook.timerEnd = Date.now() + sekunden * 1000;
      saveCookState();
      paintTimer();
    }

    function cancelTimer() {
      timerDone = false;
      cook.timerEnd = null;
      saveCookState();
      paintTimer();
    }

    function paintTimer() {
      clearTimerInterval();
      timerDone = false;
      timerArea.replaceChildren();

      if (cook.timerEnd) {
        const chip = el("button", {
          class: "cook-timer running",
          type: "button",
          "aria-label": "Timer abbrechen",
        });
        const finish = () => {
          timerDone = true;
          cook.timerEnd = null;
          saveCookState();
          clearTimerInterval();
          cookBeep();
          toast("⏱ Timer fertig!");
          chip.className = "cook-timer finished";
          chip.textContent = "⏱ Fertig!";
          chip.setAttribute("aria-label", "Timer-Meldung übernehmen");
        };
        const tick = () => {
          const remain = cook.timerEnd - Date.now();
          if (remain <= 0) {
            finish();
            return;
          }
          const totalSec = Math.ceil(remain / 1000);
          chip.textContent = `⏱ ${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
        };
        chip.addEventListener("click", () => {
          if (timerDone) paintTimer();
          else cancelTimer();
        });
        timerArea.append(chip);
        tick();
        if (!timerDone) timerInterval = setInterval(tick, 250);
        return;
      }

      const stepTimer = steps[cook.step]?.timerSekunden;
      if (stepTimer) {
        const chip = el("button", {
          class: "cook-timer",
          type: "button",
          text: `⏱ ${Math.round(stepTimer / 60)} min starten`,
        });
        chip.addEventListener("click", () => startTimer(stepTimer));
        timerArea.append(chip);
      } else {
        const presets = el("div", { class: "cook-presets" }, el("span", { class: "cook-presets-label muted", text: "⏱ Timer:" }));
        for (const min of [5, 10, 15]) {
          const preset = el("button", {
            class: "cook-preset",
            type: "button",
            text: `${min}′`,
            "aria-label": `${min} Minuten Timer starten`,
          });
          preset.addEventListener("click", () => startTimer(min * 60));
          presets.append(preset);
        }
        timerArea.append(presets);
      }
    }

    // ---------- Schrittnavigation ----------

    function gotoStep(i) {
      cook.step = Math.min(Math.max(0, i), steps.length);
      saveCookState();
      paintStep();
      window.scrollTo({ top: 0 });
    }

    function paintStep() {
      if (cook.step >= steps.length) {
        stepCard.hidden = true;
        finishCard.hidden = false;
        clearTimerInterval();
        return;
      }
      stepCard.hidden = false;
      finishCard.hidden = true;
      const step = steps[cook.step];
      stepLabel.textContent = `Schritt ${cook.step + 1} von ${steps.length}`;
      dots.replaceChildren(
        ...steps.map((_, i) => el("span", { class: "cook-dot" + (i <= cook.step ? " active" : "") }))
      );
      stepText.textContent = step.text;
      advanceBtn.textContent = cook.step === steps.length - 1 ? "Fertig kochen 🎉" : "Schritt erledigt ✓";
      backBtn.hidden = cook.step === 0;
      paintTimer();
    }

    advanceBtn.addEventListener("click", () => gotoStep(cook.step + 1));
    backBtn.addEventListener("click", () => gotoStep(cook.step - 1));

    // ---------- Anzeigen ----------

    $app.replaceChildren(header, el("div", { class: "cook-main" }, ingCard, stepCard, finishCard));
    paintIngredients();
    paintStep();

    // ---------- Wake Lock: Display bleibt an, solange gekocht wird ----------

    let wakeLock = null;
    async function requestWakeLock() {
      try {
        if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
      } catch {
        // nicht verfügbar (z. B. ohne Nutzerinteraktion) – kein Problem
      }
    }
    const onVisChange = () => {
      if (document.visibilityState === "visible") requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisChange);
    requestWakeLock();

    cookCleanup = () => {
      clearTimerInterval();
      document.removeEventListener("visibilitychange", onVisChange);
      if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
      }
    };
  }

  // ---------- Per Einladungslink beitreten ----------

  function renderJoin(token) {
    const errorBox = el("p", { class: "error", hidden: true });
    const joinBtn = el("button", { class: "btn primary", type: "submit", text: "Liste beitreten" });

    $app.replaceChildren(
      el(
        "div",
        { class: "auth-wrap" },
        el("h1", { class: "logo", text: "🛒 Buylist" }),
        el("p", { class: "subtitle", text: "Du wurdest zu einer Einkaufsliste eingeladen." }),
        el(
          "form",
          {
            class: "card form",
            onsubmit: async (event) => {
              event.preventDefault();
              joinBtn.disabled = true;
              try {
                const data = await api("/api/join", { body: { token } });
                navigate(`/list/${data.list.id}`, { replace: true });
              } catch (err) {
                errorBox.textContent = err.message;
                errorBox.hidden = false;
                joinBtn.disabled = false;
              }
            },
          },
          errorBox,
          joinBtn
        )
      )
    );
  }

  function renderNotFound() {
    $app.replaceChildren(
      el(
        "div",
        { class: "auth-wrap" },
        el("h1", { class: "logo", text: "404" }),
        el("p", { class: "muted", text: "Diese Seite gibt es nicht." }),
        el("a", { class: "btn primary", "data-link": "", href: "/", text: "Zur Übersicht" })
      )
    );
  }

  boot();
})();
