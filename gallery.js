/* =============================================================================
 * 图提取 ImageGrab — gallery.js
 * 画廊页逻辑：读取提取结果 → 网格渲染 → 勾选 → 批量转 PNG 下载（带进度与结果反馈）。
 * ===========================================================================*/

const MIN_SIZE = 100;          // 与 content.js 保持一致：小于此边长视为小图
const CONCURRENCY = 3;         // 并发下载数，兼顾速度与稳定性

/** @type {{url:string,width:number,height:number,selected:boolean,natural:{w:number,h:number},small:boolean,failed:boolean,el?:HTMLElement}[]} */
let items = [];
let running = false;

/* ------------------------------ DOM 引用 ------------------------------ */
const $ = (id) => document.getElementById(id);

const els = {
  sourceLabel: $('sourceLabel'),
  sourceLink: $('sourceLink'),
  toolbar: $('toolbar'),
  grid: $('grid'),
  empty: $('empty'),
  emptyTitle: $('emptyTitle'),
  emptyText: $('emptyText'),
  countLabel: $('countLabel'),
  btnSelectAll: $('btnSelectAll'),
  btnInvert: $('btnInvert'),
  btnClear: $('btnClear'),
  btnDownload: $('btnDownload'),
  chkSkipSmall: $('chkSkipSmall'),
  btnReload: $('btnReload'),
  btnGrant: $('btnGrant'),
  progress: $('progress'),
  progressText: $('progressText'),
  progressPct: $('progressPct'),
  progressBar: $('progressBar'),
  toast: $('toast')
};

/* ------------------------------ 工具函数 ------------------------------ */

const pad3 = (n) => String(n).padStart(3, '0');

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

/** Promise 化 sendMessage */
function send(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

let toastTimer = null;
function toast(html, ms = 3600) {
  els.toast.innerHTML = html; // 调用方仅传入受控字符串，不含用户数据
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('is-show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-show');
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }, ms);
}

/* ------------------------------ 数据加载 ------------------------------ */

async function loadData() {
  let data = null;
  try {
    const resp = await send({ type: 'IMAGEGRAB_GET_LAST' });
    if (resp && resp.ok) data = resp.data;
  } catch (e) { /* 忽略，走空状态 */ }

  // 兜底：直接读 session storage（画廊页属于受信上下文，可访问）
  if (!data) {
    try {
      const r = await chrome.storage.session.get('imagegrab_last');
      data = r && r.imagegrab_last;
    } catch (e) { /* 忽略 */ }
  }
  return data;
}

/* ------------------------------ 渲染 ------------------------------ */

function renderSource(data) {
  if (!data) return;
  const platformName = { taobao: '淘宝 / 天猫', jd: '京东', pdd: '拼多多' }[data.platform] || '电商页面';
  const when = data.at ? new Date(data.at).toLocaleString('zh-CN', { hour12: false }) : '';
  const title = (data.title || '未命名页面').slice(0, 60);
  els.sourceLabel.textContent = `${platformName} · ${title} · 共 ${data.images.length} 张 · ${when}`;

  if (data.sourceUrl) {
    els.sourceLink.href = data.sourceUrl;
    els.sourceLink.hidden = false;
  }
}

/** 构建单张卡片 */
function buildCard(item, index) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.setAttribute('role', 'checkbox');
  card.setAttribute('aria-checked', 'false');
  card.dataset.i = String(index);

  const thumb = document.createElement('span');
  thumb.className = 'card__thumb is-loading';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = item.url;

  const check = document.createElement('span');
  check.className = 'card__check';
  check.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const idx = document.createElement('span');
  idx.className = 'card__idx';
  idx.textContent = pad3(index + 1);

  thumb.append(img, check, idx);

  const meta = document.createElement('span');
  meta.className = 'card__meta';
  const dim = document.createElement('span');
  dim.className = 'card__dim';
  dim.textContent = item.width && item.height ? `${item.width}×${item.height}` : '尺寸未知';
  const host = document.createElement('span');
  host.className = 'card__host';
  host.textContent = hostOf(item.url);
  meta.append(dim, host);

  card.append(thumb, meta);

  // 图片加载完成后：记录真实尺寸、判定小图
  img.addEventListener('load', () => {
    thumb.classList.remove('is-loading');
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (w && h) {
      item.natural = { w, h };
      if (w * h >= (item.width * item.height)) {
        item.width = w;
        item.height = h;
      }
      dim.textContent = `${w}×${h}`;
      if (w < MIN_SIZE || h < MIN_SIZE) markSmall(card, item, index);
    }
  });

  img.addEventListener('error', () => {
    thumb.classList.remove('is-loading');
    item.failed = true;
    addBadge(card, '加载失败', 'err');
    img.alt = '图片加载失败';
  });

  // 点击卡片切换选中
  card.addEventListener('click', () => toggleItem(index));
  card.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleItem(index);
    }
  });

  item.el = card;
  return card;
}

function addBadge(card, text, kind) {
  if (card.querySelector('.card__badge')) return;
  const b = document.createElement('span');
  b.className = 'card__badge card__badge--' + (kind || 'warn');
  b.textContent = text;
  card.querySelector('.card__thumb').appendChild(b);
}

function markSmall(card, item, index) {
  item.small = true;
  addBadge(card, '过小', 'warn');
  // 勾选了「忽略小于 100×100」时，自动取消选择
  if (els.chkSkipSmall.checked && item.selected) {
    item.selected = false;
    card.setAttribute('aria-checked', 'false');
  }
  updateCount();
}

function renderGrid(data) {
  els.grid.textContent = '';
  items = data.images.map((it, i) => ({
    url: it.url,
    width: it.width || 0,
    height: it.height || 0,
    selected: true,          // 默认全选，小图会在加载后被自动取消
    natural: { w: 0, h: 0 },
    small: false,
    failed: false
  }));

  const frag = document.createDocumentFragment();
  items.forEach((item, i) => frag.appendChild(buildCard(item, i)));
  els.grid.appendChild(frag);
  updateCount();
}

/* ------------------------------ 选择逻辑 ------------------------------ */

function toggleItem(index) {
  const item = items[index];
  if (!item || item.failed) return;
  item.selected = !item.selected;
  item.el.setAttribute('aria-checked', item.selected ? 'true' : 'false');
  updateCount();
}

function updateCount() {
  const total = items.filter((it) => !it.failed).length;
  const selected = items.filter((it) => it.selected && !it.failed).length;
  els.countLabel.textContent = `已选 ${selected} / ${total}`;
  els.btnDownload.disabled = selected === 0 || running;
}

function selectAll(value) {
  items.forEach((it) => {
    if (it.failed) return;
    it.selected = value;
    it.el.setAttribute('aria-checked', value ? 'true' : 'false');
  });
  updateCount();
}

function invertSelection() {
  items.forEach((it) => {
    if (it.failed) return;
    it.selected = !it.selected;
    it.el.setAttribute('aria-checked', it.selected ? 'true' : 'false');
  });
  updateCount();
}

/* ------------------------------ 下载 ------------------------------ */

async function downloadSelected() {
  if (running) return;
  const queue = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.selected && !it.failed);

  if (!queue.length) return;

  running = true;
  updateCount();
  els.progress.hidden = false;
  setProgress(0, queue.length, '准备下载…');

  const results = { ok: 0, fail: 0, failedItems: [] };
  let done = 0;
  let cursor = 0;

  // 并发 worker
  const worker = async () => {
    while (cursor < queue.length) {
      const idx = cursor++;
      const { it, i } = queue[idx];
      try {
        const resp = await send({
          type: 'IMAGEGRAB_DOWNLOAD',
          url: it.url,
          index: i + 1,
          filename: `商品图_${pad3(i + 1)}.png`
        });
        if (resp && resp.ok) {
          results.ok++;
        } else {
          throw new Error((resp && resp.error) || '未知错误');
        }
      } catch (err) {
        // 失败再重试一次
        try {
          const retry = await send({
            type: 'IMAGEGRAB_DOWNLOAD',
            url: it.url,
            index: i + 1,
            filename: `商品图_${pad3(i + 1)}.png`
          });
          if (retry && retry.ok) results.ok++;
          else throw new Error((retry && retry.error) || '重试失败');
        } catch (err2) {
          results.fail++;
          results.failedItems.push(it);
          it.failed = true;
          addBadge(it.el, 'PNG 失败', 'err');
          if (it.selected) {
            it.selected = false;
            it.el.setAttribute('aria-checked', 'false');
          }
        }
      } finally {
        done++;
        setProgress(done, queue.length, `正在下载 ${done} / ${queue.length}…`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)
  );

  running = false;
  updateCount();

  setProgress(queue.length, queue.length, '下载完成');
  setTimeout(() => { els.progress.hidden = true; }, 1400);

  if (results.fail === 0) {
    toast(`已下载 <b>${results.ok}</b> 张图片，保存到「下载/图提取」文件夹（PNG 格式）。`);
  } else {
    toast(
      `成功 <b>${results.ok}</b> 张，失败 <b>${results.fail}</b> 张。` +
      `失败图片已标记「PNG 失败」，可点卡片上的「下载原图」按原格式保存，` +
      `或在工具栏点击「授予全部站点访问权限」后重试。`,
      6000
    );
  }
}

function setProgress(done, total, text) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressText.textContent = text;
  els.progressPct.textContent = pct + '%';
  els.progressBar.style.width = pct + '%';
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  els.btnSelectAll.addEventListener('click', () => selectAll(true));
  els.btnInvert.addEventListener('click', invertSelection);
  els.btnClear.addEventListener('click', () => selectAll(false));

  els.chkSkipSmall.addEventListener('change', () => {
    if (!els.chkSkipSmall.checked) return;
    items.forEach((it) => {
      if (it.small && it.selected && !it.failed) {
        it.selected = false;
        it.el.setAttribute('aria-checked', 'false');
      }
    });
    updateCount();
  });

  els.btnDownload.addEventListener('click', downloadSelected);
  els.btnReload.addEventListener('click', () => location.reload());

  // 跨域兜底：申请全部站点访问权限
  els.btnGrant.addEventListener('click', async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
      toast(granted
        ? '已获得全部站点访问权限，现在可以重新提取并下载更多跨域图片。'
        : '未获得授权，跨域图片可能转换失败。');
    } catch (e) {
      toast('当前环境不支持动态申请权限。');
    }
  });
}

/* ------------------------------ 启动 ------------------------------ */

async function init() {
  bindEvents();
  const data = await loadData();

  if (!data || !Array.isArray(data.images) || data.images.length === 0) {
    els.empty.hidden = false;
    els.toolbar.hidden = true;
    if (data && (!data.images || data.images.length === 0)) {
      els.emptyTitle.textContent = '上次没有提取到图片';
      els.emptyText.textContent = '页面里符合条件的图片为空。请回到商品详情页重新点击「获取图片」。';
    }
    return;
  }

  els.empty.hidden = true;
  els.toolbar.hidden = false;
  renderSource(data);
  renderGrid(data);
}

init();
