// Only responsibility: open the sidepanel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'v2c-sidepanel-lifecycle') return;
  let sourceTabId = null;

  port.onMessage.addListener((message) => {
    if (typeof message?.tabId === 'number') sourceTabId = message.tabId;
  });

  port.onDisconnect.addListener(() => {
    if (sourceTabId == null) return;
    chrome.tabs.sendMessage(sourceTabId, { type: 'STOP_INSPECTION' }).catch(() => {});
    chrome.tabs.sendMessage(sourceTabId, { type: 'STOP_ANNOTATOR' }).catch(() => {});
  });
});
