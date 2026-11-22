/** The toolbar button opens the side panel; everything else runs there. */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
