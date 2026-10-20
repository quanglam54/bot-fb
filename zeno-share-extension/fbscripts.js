// Các hàm chạy BÊN TRONG tab Facebook (chrome.scripting.executeScript).
// Mỗi hàm phải tự chứa đủ mọi thứ, không dùng biến bên ngoài.

// Kiểm tra trạng thái đăng nhập FB
function fbCheckLogin() {
  if (/checkpoint/.test(location.href)) return 'checkpoint';
  if (/\/login/.test(location.href) || document.querySelector('input[name="email"], input[name="pass"]')) return 'login';
  return 'ok';
}

// Quét page: cuộn và gom link bài viết
async function fbScan(scrollTimes, pageUrl) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  if (/checkpoint/.test(location.href)) return { ok: false, code: 'checkpoint' };
  if (/\/login/.test(location.href) || document.querySelector('input[name="email"], input[name="pass"]')) return { ok: false, code: 'login' };

  const normalize = (href) => {
    try {
      const u = new URL(href, 'https://www.facebook.com');
      if (/permalink\.php|story\.php/.test(u.pathname)) {
        return `https://www.facebook.com${u.pathname}?story_fbid=${u.searchParams.get('story_fbid')}&id=${u.searchParams.get('id')}`;
      }
      return `https://www.facebook.com${u.pathname}`.replace(/\/$/, '');
    } catch { return null; }
  };

  // Chỉ lấy bài của chính page đó (bỏ bài người khác share lại, bài được gắn thẻ...)
  let base = null, pageId = null;
  try {
    const p = new URL(pageUrl);
    if (/profile\.php/.test(p.pathname)) pageId = p.searchParams.get('id');
    else base = `https://www.facebook.com/${p.pathname.split('/').filter(Boolean)[0]}/`.toLowerCase();
  } catch {}
  const ofPage = (u) => {
    if (base) return u.toLowerCase().startsWith(base);
    if (pageId) return u.includes(`id=${pageId}`) || u.includes(`/${pageId}/`);
    return true;
  };

  const found = [];
  for (let i = 0; i < scrollTimes; i++) {
    // FB chỉ gắn href thật cho link thời gian khi rê chuột vào
    document.querySelectorAll('[role="article"] a, div[aria-posinset] a, [role="feed"] a').forEach((a) => {
      for (const t of ['mouseover', 'mouseenter', 'focus']) a.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    });
    await sleep(800);
    for (const a of document.querySelectorAll('a[href]')) {
      if (/\/(posts|videos|reel)\/[^/?#]+|permalink\.php|story\.php/.test(a.href)) {
        const n = normalize(a.href);
        if (n && ofPage(n) && !found.includes(n)) found.push(n);
      }
    }
    window.scrollBy(0, rand(1500, 2500));
    await sleep(rand(2000, 3500));
  }
  return { ok: true, urls: found };
}

// Share bài đang mở: chọn Công khai, điền caption, bấm "Chia sẻ ngay"
async function fbShare(caption, dryRun) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); }
    return null;
  };
  const click = async (el) => { el.scrollIntoView({ block: 'center' }); await sleep(rand(500, 1000)); el.click(); };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || '').trim();
  const fail = (code, msg) => ({ ok: false, code, msg });

  if (/checkpoint/.test(location.href)) return fail('checkpoint', 'Nick đang bị Facebook checkpoint.');
  if (/\/login/.test(location.href) || document.querySelector('input[name="email"], input[name="pass"]')) return fail('login', 'Chưa đăng nhập Facebook trên Chrome.');

  // 1. Nút "Chia sẻ" của bài (bài thường mở trong popup -> ưu tiên trong popup)
  const SHARE = ['[aria-label*="đăng lên trang cá nhân"]', '[aria-label*="post it on your profile"]'];
  const findShare = () => {
    for (const scope of ['[role="dialog"] ', '']) {
      for (const s of SHARE) {
        const el = [...document.querySelectorAll(scope + s)].find(visible);
        if (el) return el;
      }
    }
    return null;
  };
  const shareBtn = await waitFor(findShare, 20000);
  if (!shareBtn) return fail('noshare', 'Không thấy nút Chia sẻ của bài.');
  await click(shareBtn);

  // 2. Ô caption của hộp chia sẻ (KHÔNG phải ô bình luận)
  const COMPOSER = ['nói gì đó', 'Say something'].flatMap((t) =>
    [`[role="textbox"][aria-label*="${t}"]`, `[role="textbox"][aria-placeholder*="${t}"]`]).join(', ');
  const findBox = () => [...document.querySelectorAll(COMPOSER)].find(visible);
  let box = await waitFor(findBox, 8000);
  if (!box) {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) => /Bảng feed|Share to Feed|Chia sẻ lên trang cá nhân/i.test(e.innerText));
    if (item) { await click(item); box = await waitFor(findBox, 12000); }
  }
  if (!box) return fail('nobox', 'Không thấy ô "Hãy nói gì đó..." trong hộp chia sẻ.');
  await sleep(rand(1000, 2000));

  // 3. Đối tượng: Công khai
  const PRIV = '[aria-label^="Chỉnh sửa quyền riêng tư"], [aria-label^="Edit privacy"]';
  const privLabel = () => (document.querySelector(PRIV)?.getAttribute('aria-label') || '');
  if (document.querySelector(PRIV) && !/Công khai|Public/i.test(privLabel())) {
    await click(document.querySelector(PRIV));
    const panel = await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].reverse()
      .find((d) => /Ai có thể xem bài viết của bạn|Who can see your post/.test(d.innerText)), 8000);
    if (!panel) return fail('privacy', 'Không mở được menu quyền riêng tư.');
    const opt = [...panel.querySelectorAll('span')].find((s) => /^(Công khai|Public)$/.test(s.innerText.trim()));
    if (!opt) return fail('privacy', 'Không thấy lựa chọn Công khai.');
    await click(opt);
    await sleep(rand(800, 1400));
    const done = [...panel.querySelectorAll('[role="button"], button')].reverse().find((b) => /^(Xong|Done)$/.test(label(b)));
    if (done) await click(done);
    await sleep(rand(1000, 1800));
    if (!/Công khai|Public/i.test(privLabel())) return fail('privacy', 'Không chuyển được sang Công khai -> không share.');
  }

  // 4. Caption
  box = await waitFor(findBox, 8000);
  if (!box) return fail('nobox', 'Mất ô caption sau khi chọn Công khai.');
  if (caption) {
    await click(box);
    box.focus();
    document.execCommand('insertText', false, caption);
    await sleep(800);
    const probe = caption.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 8);
    if (probe && !box.innerText.includes(probe)) {
      box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: caption, bubbles: true, cancelable: true }));
      await sleep(800);
    }
  }
  await sleep(rand(1000, 2000));

  // 5. Nút "Chia sẻ ngay" cùng hộp với ô caption
  const dialog = box.closest('[role="dialog"]') || document;
  const postBtn = [...dialog.querySelectorAll('[role="button"], button')].find((b) => /^(Chia sẻ ngay|Share now)$/.test(label(b)));
  if (!postBtn) return fail('nopost', 'Không thấy nút "Chia sẻ ngay".');

  if (dryRun) return { ok: true, dry: true, privacy: privLabel(), text: box.innerText };

  await click(postBtn);
  const gone = await waitFor(() => !document.contains(box) || !visible(box), 30000);
  if (!gone) return fail('notposted', 'Đã bấm "Chia sẻ ngay" nhưng hộp chia sẻ không đóng.');
  await sleep(2000);
  return { ok: true };
}
