// Watchdog: if the app has not started after 8 s (e.g. iOS kept an old build's files), offer a
// reload, or a reset that drops the service worker and its caches. A file with its styles set from
// here: the Content-Security-Policy allows no inline script or style (DISP-72).
setTimeout(function () {
  if (window.__dispatchStarted) return;
  var button = function (text, css, onclick) {
    var b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'font:inherit;padding:10px 18px;border-radius:10px;' + css;
    b.onclick = onclick;
    return b;
  };
  var el = document.createElement('div');
  el.id = 'boot-fail';
  el.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0e0e10;color:#ededef;font:15px -apple-system,system-ui,sans-serif;padding:24px;text-align:center';
  el.appendChild(document.createElement('div')).textContent = 'Dispatch did not start.';
  el.appendChild(button('Reload', 'border:1px solid #2c2c31;background:#222226;color:inherit', function () { location.reload(); }));
  el.appendChild(button('Reset app', 'border:0;background:#6e6ff0;color:#fff', async function () {
    try {
      var regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(function (r) { return r.unregister(); }));
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) {}
    location.replace('/?reset=' + Date.now());
  }));
  document.body.appendChild(el);
}, 8000);
