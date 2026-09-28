/* ISOLATED world. Pure pipe between the side panel and the page. */
const pending = new Map();
let seq = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.__cpf !== 'res') return;
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
});

function callPage(action, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ __cpf: 'req', id, action, args }, '*');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('page timeout: ' + action)); }
    }, 120000);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.__cpf !== 'call') return;
  callPage(msg.action, msg.args)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
