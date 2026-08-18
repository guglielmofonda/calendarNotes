/*
 * Call Notes — background worker.
 *
 * One job: when the extension is installed, updated, or reloaded, re-inject
 * the content script into Calendar tabs that are already open. Without
 * this, an existing tab keeps running the previous script with a dead
 * storage connection — the panel looks alive but nothing saves.
 * The injected script sweeps up the old generation's UI and takes over.
 */
chrome.runtime.onInstalled.addListener(function () {
  chrome.tabs.query({ url: 'https://calendar.google.com/*' }, function (tabs) {
    (tabs || []).forEach(function (tab) {
      if (!tab.id) return;
      chrome.scripting.insertCSS(
        { target: { tabId: tab.id }, files: ['content/content.css'] },
        function () {
          void chrome.runtime.lastError; // discarded/sleeping tabs — fine
        }
      );
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          files: ['common/store.js', 'content/content.js']
        },
        function () {
          void chrome.runtime.lastError;
        }
      );
    });
  });
});
