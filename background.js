chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/* Alt+Shift+R rebuilds the extension without visiting chrome://extensions.
   Content scripts are NOT re-injected into open tabs, so refresh WhatsApp Web too. */
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'reload-extension') chrome.runtime.reload();
});
