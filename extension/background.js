chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    backendUrl: "http://localhost:8787",
    riskStyle: "balanced"
  });
});
