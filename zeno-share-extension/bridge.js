// Cầu nối giữa trang web (bot-fb.netlify.app) và extension
document.documentElement.setAttribute('data-zeno-ext', chrome.runtime.getManifest().version);

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.zeno !== 'req') return;
  const { id, type, payload } = e.data;
  chrome.runtime.sendMessage({ type, payload }, (resp) => {
    const err = chrome.runtime.lastError;
    window.postMessage({
      zeno: 'res', id,
      result: resp && resp.result,
      error: err ? 'Extension vừa được cập nhật, tải lại trang (F5).' : resp && resp.error,
    }, location.origin);
  });
});
