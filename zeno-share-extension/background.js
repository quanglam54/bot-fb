// Zeno Share Bot - chạy nền: lịch tự share, điều khiển tab Facebook, báo kết quả lên Supabase
importScripts('config.js', 'fbscripts.js');

const VERSION = chrome.runtime.getManifest().version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const ymd = (d = new Date()) => d.toLocaleDateString('sv-SE');

const DEFAULT_SETTINGS = { pages: DEFAULT_PAGES, auto: false, hour: 9, perDay: 1 };

// ---------- Lưu trữ ----------
const get = async (k, def) => (await chrome.storage.local.get(k))[k] ?? def;
const set = (k, v) => chrome.storage.local.set({ [k]: v });
const settings = async () => ({ ...DEFAULT_SETTINGS, ...(await get('settings', {})) });

async function patchState(p) {
  const s = await get('state', {});
  await set('state', { ...s, ...p });
}
async function log(msg) {
  const s = await get('state', {});
  const logs = [...(s.logs || []), `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`].slice(-60);
  await set('state', { ...s, logs });
}

// ---------- Supabase ----------
async function sb(pathname, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(SB_URL + pathname, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token || SB_KEY}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const m = (data && (data.msg || data.message || data.error_description || data.error)) || `HTTP ${res.status}`;
    throw new Error(/Invalid login/i.test(m) ? 'Sai email hoặc mật khẩu.' : m);
  }
  return data;
}

async function saveSession(d) {
  const session = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    user: { id: d.user.id, email: d.user.email, name: d.user.user_metadata?.name || '' },
  };
  await set('session', session);
  return session;
}

async function session() {
  let s = await get('session', null);
  if (!s) throw new Error('Extension chưa kết nối tài khoản. Mở web và đăng nhập.');
  if (s.expires_at - 60 < Date.now() / 1000) {
    try {
      s = await saveSession(await sb('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } }));
    } catch (e) {
      await chrome.storage.local.remove('session');
      throw new Error('Phiên đăng nhập hết hạn. Mở web và kết nối lại extension.');
    }
  }
  return s;
}

// ---------- Tab Facebook ----------
function waitTab(tabId, timeout = 45000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(on);
  });
}

async function openFb(url, prev) {
  if (prev) {
    await chrome.tabs.update(prev.tabId, { url });
    await waitTab(prev.tabId);
    await sleep(rand(4000, 6500));
    return prev;
  }
  const win = await chrome.windows.create({ url, focused: false, width: 1100, height: 850, left: 40, top: 40 });
  const tabId = win.tabs[0].id;
  await waitTab(tabId);
  await sleep(rand(4000, 6500));
  return { windowId: win.id, tabId };
}

async function inTab(fb, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: fb.tabId }, func, args, world: 'MAIN' });
  return r && r.result;
}

// ---------- Công việc chính ----------
let running = false;

async function runJob({ url = null, auto = false } = {}) {
  if (running) throw new Error('Bot đang chạy, đợi xong lượt này.');
  running = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  await patchState({ running: true, lastRunAt: new Date().toISOString() });
  let fb = null;
  try {
    const s = await session();
    const cfg = await settings();
    await log(auto ? 'Bắt đầu lượt tự share hằng ngày' : 'Bắt đầu share');

    // Bài đã share (theo tài khoản), danh sách bài chung, caption
    const [mine, common, caps] = await Promise.all([
      sb(`/rest/v1/shares?select=post_url&user_id=eq.${s.user.id}`, { token: s.access_token }),
      sb('/rest/v1/posts?select=url&hidden=eq.false&order=created_at.desc&limit=200', { token: s.access_token }),
      sb('/rest/v1/captions?select=text', { token: s.access_token }),
    ]);
    const done = new Set(mine.map((x) => x.post_url));

    let target = url;
    if (!target) {
      const candidates = [];
      for (const page of cfg.pages) {
        await log(`Quét page: ${page.replace('https://www.facebook.com/', '')}`);
        fb = await openFb(page, fb);
        const r = await inTab(fb, fbScan, [15, page]);
        if (!r || !r.ok) throw Object.assign(new Error(fbError(r && r.code)), { code: r && r.code });
        await log(`  -> ${r.urls.length} bài`);
        candidates.push(...r.urls);
        // Tài khoản admin: đẩy bài quét được lên danh sách chung cho team (người khác không có quyền -> bỏ qua)
        if (r.urls.length) {
          sb('/rest/v1/posts?on_conflict=url', {
            method: 'POST', token: s.access_token,
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: [...r.urls].reverse().map((url) => ({ url, page_url: page })),
          }).catch(() => {});
        }
      }
      candidates.push(...common.map((x) => x.url));
      target = candidates.find((u) => !done.has(u));
    }
    if (!target) {
      await log('Không còn bài nào chưa share 🎉');
      await patchState({ lastResult: { ok: true, nothing: true, at: new Date().toISOString() } });
      return { nothing: true };
    }

    const caption = caps.length ? caps[rand(0, caps.length)].text : '';
    await log(`Mở bài: ${target.replace('https://www.facebook.com/', '').slice(0, 60)}…`);
    fb = await openFb(target, fb);
    const r = await inTab(fb, fbShare, [caption, false]);
    if (!r || !r.ok) throw Object.assign(new Error((r && r.msg) || 'Share thất bại.'), { code: r && r.code });

    await log('✅ Đã share công khai');
    const sharedAt = new Date().toISOString();
    try {
      await sb('/rest/v1/shares', {
        method: 'POST', token: s.access_token, headers: { Prefer: 'return=minimal' },
        body: { user_id: s.user.id, post_url: target, caption, source: 'ext', shared_at: sharedAt },
      });
    } catch (e) {
      // Mất mạng -> lưu lại gửi sau
      const q = await get('pending', []);
      q.push({ user_id: s.user.id, post_url: target, caption, source: 'ext', shared_at: sharedAt });
      await set('pending', q);
      await log(`(Chưa báo lên hệ thống được, sẽ gửi lại: ${e.message})`);
    }
    await patchState({ needFb: null, lastResult: { ok: true, url: target, at: sharedAt } });
    return { ok: true, url: target };
  } catch (e) {
    await log(`❌ ${e.message}`);
    await patchState({
      needFb: ['login', 'checkpoint'].includes(e.code) ? e.code : null,
      lastResult: { ok: false, error: e.message, at: new Date().toISOString() },
    });
    throw e;
  } finally {
    if (fb) chrome.windows.remove(fb.windowId).catch(() => {});
    clearInterval(keepAlive);
    running = false;
    await patchState({ running: false });
  }
}

function fbError(code) {
  if (code === 'login') return 'Chưa đăng nhập Facebook trên Chrome. Mở facebook.com và đăng nhập.';
  if (code === 'checkpoint') return 'Nick Facebook đang bị checkpoint, mở facebook.com để xác minh.';
  return 'Không đọc được page.';
}

async function flushPending() {
  const q = await get('pending', []);
  if (!q.length) return;
  const s = await session();
  await sb('/rest/v1/shares?on_conflict=user_id,post_url,shared_at', {
    method: 'POST', token: s.access_token, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: q,
  });
  await set('pending', []);
  await log(`Đã gửi bù ${q.length} lượt share`);
}

// ---------- Lịch tự share ----------
async function sharedToday(s) {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const rows = await sb(`/rest/v1/shares?select=id&user_id=eq.${s.user.id}&shared_at=gte.${from.toISOString()}`, { token: s.access_token });
  return rows.length;
}

async function tick() {
  await flushPending().catch(() => {});
  const cfg = await settings();
  if (!cfg.auto || running) return;
  const s = await get('session', null);
  if (!s) return;

  const today = ymd();
  const st = await get('state', {});
  // Mỗi ngày chọn 1 thời điểm ngẫu nhiên trong 90 phút sau giờ đã đặt
  let plan = st.plan;
  if (!plan || plan.date !== today) {
    plan = { date: today, minute: cfg.hour * 60 + rand(0, 90), attempts: 0 };
    await patchState({ plan });
  }
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < plan.minute || plan.attempts >= 3) return;

  try {
    if ((await sharedToday(await session())) >= cfg.perDay) return;
    await patchState({ plan: { ...plan, attempts: plan.attempts + 1 } });
    await runJob({ auto: true });
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 10 }));
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('tick', { periodInMinutes: 10 });
  setTimeout(tick, 60000);
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick(); });

// ---------- Tin nhắn từ trang web ----------
const handlers = {
  async ping() {
    const s = await get('session', null);
    return { version: VERSION, user: s ? s.user : null };
  },
  async connect({ email, password }) {
    const d = await sb('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    const s = await saveSession(d);
    await log(`Đã kết nối tài khoản ${s.user.email}`);
    return { user: s.user };
  },
  async disconnect() {
    await chrome.storage.local.remove('session');
    return { ok: true };
  },
  async getState() {
    const s = await get('session', null);
    return { version: VERSION, user: s ? s.user : null, settings: await settings(), state: { ...(await get('state', {})), running } };
  },
  async saveSettings(p) {
    const cfg = { ...(await settings()), ...p };
    cfg.pages = (cfg.pages || []).filter(Boolean);
    cfg.hour = Math.min(22, Math.max(0, +cfg.hour || 9));
    cfg.perDay = Math.min(3, Math.max(1, +cfg.perDay || 1));
    await set('settings', cfg);
    if (cfg.auto) await patchState({ plan: null });
    return cfg;
  },
  async runNow({ url } = {}) {
    if (running) throw new Error('Bot đang chạy, đợi xong lượt này.');
    runJob({ url }).catch(() => {});
    return { started: true };
  },
  async clearLog() {
    await patchState({ logs: [] });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const origin = sender.origin || (sender.url && new URL(sender.url).origin);
  const fromPopup = sender.id === chrome.runtime.id && !sender.tab;
  if (!fromPopup && !WEB_ORIGINS.includes(origin)) return;
  const h = handlers[msg && msg.type];
  if (!h) return;
  h(msg.payload || {}).then((result) => sendResponse({ result }), (e) => sendResponse({ error: e.message }));
  return true;
});
