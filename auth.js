// auth.js
// Handles Google OAuth token retrieval via chrome.identity.
// Currently unused in the core detection flow but retained for future
// features (e.g., saving sessions to Google Drive, syncing across devices).
//
// To use: add "auth.js" to the content_scripts or background service worker
// in manifest.json, then send a "GET_TOKEN" message from any context.

/**
 * Requests an OAuth token interactively (shows the Google sign-in dialog
 * if the user hasn't authorized the extension yet).
 * @returns {Promise<string>} The OAuth access token.
 */
function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        console.error("[PasteScope] Auth error:", chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

// Message listener — allows any extension context to request a token
// by sending: chrome.runtime.sendMessage({ type: "GET_TOKEN" })
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "GET_TOKEN") return false;

  getAuthToken()
    .then((token) => sendResponse({ token }))
    .catch((err)  => sendResponse({ error: err.message }));

  return true; // Keep channel open for async response
});