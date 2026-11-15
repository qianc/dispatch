// Before the first paint: the theme chosen on this device. A file, not an inline script: the
// Content-Security-Policy allows scripts from Dispatch's own origin only (DISP-72).
try { var t = localStorage.getItem('dispatch:theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
