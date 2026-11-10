const filters = document.querySelectorAll(".chip");
const cards = document.querySelectorAll("#site-grid .card");
const count = document.getElementById("result-count");
const header = document.querySelector(".site-header");

filters.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;

    filters.forEach((other) => {
      const active = other === button;
      other.classList.toggle("is-active", active);
      other.setAttribute("aria-pressed", String(active));
    });

    let shown = 0;
    cards.forEach((card) => {
      const tags = (card.dataset.tags || "").split(" ");
      const match = filter === "all" || tags.includes(filter);
      card.classList.toggle("card-hidden", !match);
      if (match) shown += 1;
    });

    count.textContent =
      shown === 1
        ? "Showing 1 of 6 sites"
        : `Showing ${shown} of 6 sites`;
  });
});

// Install prompt: shown only once the browser offers one, hidden when installed.
const installBtn = document.getElementById("install-app");
let installPrompt = null;

const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  window.navigator.standalone === true;

if (installBtn && !isInstalled()) {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (!installPrompt) {
      installBtn.hidden = true;
      return;
    }
    installBtn.hidden = true;
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } catch (error) {}
    installPrompt = null;
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installBtn.hidden = true;
  });
}

// Get-the-app dialog: the Android and iOS QR codes, opened from the footer,
// from #get-app, or from ?app=1 (the link on the admin sign-in page).
const appDialog = document.getElementById("get-app");

if (appDialog && typeof appDialog.showModal === "function") {
  const openAppDialog = (event) => {
    if (event) event.preventDefault();
    if (!appDialog.open) appDialog.showModal();
  };

  document
    .querySelectorAll("[data-open-app]")
    .forEach((trigger) => trigger.addEventListener("click", openAppDialog));

  appDialog.addEventListener("click", (event) => {
    if (event.target === appDialog) appDialog.close();
    else if (event.target.closest("[data-close-app]")) appDialog.close();
  });

  appDialog.addEventListener("close", () => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("app") === "1" || url.hash === "#get-app") {
      url.searchParams.delete("app");
      url.hash = "";
      history.replaceState(null, "", url.pathname + url.search);
    }
  });

  if (
    new URLSearchParams(window.location.search).get("app") === "1" ||
    window.location.hash === "#get-app"
  ) {
    openAppDialog();
  }
}

const onScroll = () => {
  header.classList.toggle("is-scrolled", window.scrollY > 8);
};

onScroll();
window.addEventListener("scroll", onScroll, { passive: true });
