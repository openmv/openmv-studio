// Shared connection helper for child WebviewWindows.
// Probes the connected board via cmd_romfs_partitions, and asks the
// main window to connect (auto-pick) by emitting "request-connect".
(function() {
  var invoke = window.__TAURI__.core.invoke;
  var emit = window.__TAURI__.event.emit;

  async function isBoardConnected() {
    try {
      var parts = await invoke("cmd_romfs_partitions");
      return Array.isArray(parts) && parts.length > 0;
    } catch (e) {
      return false;
    }
  }

  async function ensureConnected(timeoutMs) {
    if (await isBoardConnected()) {
      return true;
    }
    emit("request-connect");
    var deadline = Date.now() + (timeoutMs || 500);
    while (Date.now() < deadline) {
      await new Promise(function(r) { setTimeout(r, 100); });
      if (await isBoardConnected()) {
        return true;
      }
    }
    return false;
  }

  window.openmv = window.openmv || {};
  window.openmv.ensureConnected = ensureConnected;
  window.openmv.isBoardConnected = isBoardConnected;
})();
