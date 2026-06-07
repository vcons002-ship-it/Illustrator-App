/**
 * Service worker. Toolbar click toggles the overlay in the active tab. The
 * heavy lifting (engine, providers, storage) lives in the content script so it
 * shares the exact same `@visual-reader/core` engine as the web app — this
 * worker is just platform glue.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: "visual-reader/toggle" }).catch(() => {
    // Content script may not be injected on this page (e.g. chrome:// URLs).
  });
});
