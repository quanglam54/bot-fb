const send = (type, payload) => new Promise((res) => chrome.runtime.sendMessage({ type, payload }, (r) => res(r || {})));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function render() {
  const { result: s } = await send('getState');
  if (!s) return;
  const st = s.state || {};
  const last = st.lastResult;
  document.getElementById('body').innerHTML = `
    <div class="row">Tài khoản: <b>${s.user ? esc(s.user.name || s.user.email) : 'chưa kết nối'}</b></div>
    <div class="row">Tự share mỗi ngày: <b>${s.settings.auto ? `Bật (từ ${s.settings.hour}h)` : 'Tắt'}</b></div>
    <div class="row">Trạng thái: <b>${st.running ? '⏳ Đang chạy…' : 'Chờ'}</b></div>
    ${last ? `<div class="row">Lần gần nhất: <b>${last.ok ? (last.nothing ? 'Hết bài để share' : '✅ Thành công') : '❌ ' + esc(last.error)}</b></div>` : ''}
    ${st.needFb ? '<div class="warn">Cần đăng nhập lại Facebook trên Chrome.</div>' : ''}
    ${!s.user ? '<div class="warn">Mở trang quản lý share và đăng nhập để kết nối.</div>' : ''}`;
  document.getElementById('run').disabled = !s.user || st.running;
}

document.getElementById('run').onclick = async () => {
  const r = await send('runNow');
  if (r.error) alert(r.error);
  render();
};
document.getElementById('open').onclick = () => chrome.tabs.create({ url: WEB_URL });
render();
setInterval(render, 2000);
