/* =============================================================================
 * 图提取 ImageGrab — content.js
 * 作用：在电商商品详情页注入右下角「获取图片」悬浮按钮，点击后扫描页面内所有
 *       商品图片（含懒加载、背景图），去重过滤后发送给后台 Service Worker。
 * 兼容：淘宝 / 天猫、京东、拼多多商家版（拼多多消费者版 yangkeduo.com 亦覆盖）。
 * ===========================================================================*/

(function () {
  'use strict';

  /* ----------------------------- 可调参数 ------------------------------ */
  const BTN_ID = 'imagegrab-fab';          // 悬浮按钮 id，用于重复注入检测
  const MIN_SIZE = 100;                     // 边长小于该值的图片视为图标 / 占位图
  const MAX_SCAN_ELEMENTS = 3000;           // 背景图扫描的元素上限，防止超长页面卡顿
  const DEBUG = true;                       // 暴露调试钩子 window.__IMAGEGRAB_DEBUG__

  /** 各平台常见的懒加载图片属性（不同平台命名不同，逐一兼容） */
  const LAZY_ATTRS = [
    'data-src',          // 通用
    'data-lazy-src',     // 通用
    'data-original',     // 淘宝 / 通用
    'data-lazyload',     // 通用
    'data-lazy-img',     // 京东
    'data-lazyload-src', // 通用
    'data-ks-lazyload',  // 淘宝
    'data-echo',
    'data-url',
    'data-image',
    'data-img',
    'data-imgurl',
    'data-original-src'
  ];

  /** 明显不属于商品图的 URL 关键词（图标 / logo / 占位 / 装饰） */
  const BAD_KEYWORDS = [
    'icon', 'logo', 'avatar', 'sprite', 'spacer', 'placeholder', 'loading',
    'blank', 'transparent', 'pixel', '1x1', 'arrow', 'rating', 'star',
    'watermark', 'badge', 'guide', 'nav_', 'header', 'footer', 'default'
  ];

  /**
   * 关键词过滤用的正则：大小写敏感，且要求关键词两侧不是英文字母。
   *
   * 之所以这样设计：CDN 的文件名常是混合大小写的哈希（如 `TB1StarX_430x430.jpg`），
   * 若对整条 URL 直接做「包含即过滤」，会把哈希里恰好出现的 `star`、`icon`
   * 等字母组合误判成图标，导致真正的商品图被丢掉。
   * 改为大小写敏感 + 字母边界后：
   *   - `shop-logo_430x430.jpg`、`TB1icon_x1.png`、`_1x1.gif` → 会被过滤；
   *   - `TB1StarX_430x430.jpg` → 保留（`Star` 首字母大写，不匹配小写关键词）。
   */
  const BAD_RE = new RegExp('(^|[^A-Za-z])(' + BAD_KEYWORDS.join('|') + ')([^A-Za-z]|$)');

  /** 允许的图片扩展名（商品图几乎都是这几种） */
  const IMG_EXT_RE = /\.(jpe?g|png|webp|bmp|avif)(\?|#|$)/i;

  /* --------------------------- 平台识别 --------------------------- */

  /**
   * 根据主机名判断所属电商平台。
   * @param {string} host
   * @returns {'taobao'|'jd'|'pdd'|'unknown'}
   */
  function detectPlatform(host) {
    if (/(^|\.)taobao\.com$/i.test(host) || /(^|\.)tmall\.com$/i.test(host)) return 'taobao';
    if (/(^|\.)jd\.com$/i.test(host)) return 'jd';
    if (/(^|\.)pinduoduo\.com$/i.test(host) || /(^|\.)yangkeduo\.com$/i.test(host)) return 'pdd';
    return 'unknown';
  }

  /**
   * 判断当前页面是否为「商品详情页」。
   * 说明：manifest 的 matches 已把范围限定在三个平台域名内，这里再做一层
   *       详情页判定，避免在首页 / 列表页 / 搜索页弹出按钮。
   *       若某平台改版导致识别失效，把 DETAIL_ONLY 改为 false 即可「全站显示」。
   * @returns {boolean}
   */
  const DETAIL_ONLY = false; // 默认全站显示，保证任何页面都能取图；按需改 true
  function isDetailPage(platform) {
    if (!DETAIL_ONLY) return true;
    const target = location.pathname + location.search;
    const patterns = {
      taobao: [/item\.htm/i, /\/item\//i, /[?&]id=\d+/i],
      jd: [/\.html$/i, /\/item\//i, /[?&]sku=/i],
      pdd: [/goods\.html/i, /goods_id=/i, /\/goods/i, /\/mall\//i]
    };
    const list = patterns[platform] || [];
    return list.some((re) => re.test(target));
  }

  /* --------------------------- 纯工具函数 --------------------------- */

  /**
   * 相对路径 → 绝对 URL。
   * @param {string} raw
   * @returns {string} 失败返回空串
   */
  function absolutize(raw) {
    if (!raw) return '';
    const s = String(raw).trim().replace(/^['"]|['"]$/g, '');
    if (!s) return '';
    try {
      return new URL(s, location.href).href;
    } catch (e) {
      return '';
    }
  }

  /**
   * 解析 srcset 字符串，取出其中的 URL 列表。
   * 例："a.jpg 1x, b.jpg 2x" → ["a.jpg", "b.jpg"]
   * @param {string} value
   * @returns {string[]}
   */
  function parseSrcset(value) {
    if (!value) return [];
    return String(value)
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  /**
   * 从 CSS background-image 值中提取所有 url(...)。
   * @param {string} bg
   * @returns {string[]}
   */
  function extractCssUrls(bg) {
    const out = [];
    if (!bg || bg === 'none') return out;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let m;
    while ((m = re.exec(bg))) {
      if (m[2]) out.push(m[2]);
    }
    return out;
  }

  /**
   * 从 URL 中猜测图片尺寸，兼容 CDN 常见的命名：
   *   alicdn: xxx_430x430q90.jpg   /  _50x50.jpg
   *   jd:     s450x450_jfs/...     /  n0/...
   *   query:  ?imageView2/2/w/800  /  ?width=800
   * @param {string} url
   * @returns {[number,number]|null}
   */
  function parseSizeFromUrl(url) {
    if (!url) return null;
    const m1 = url.match(/[_\-](\d{1,5})x(\d{1,5})(?:[a-z0-9]{0,8})?\.(?:jpe?g|png|webp|bmp|avif)/i);
    if (m1) return [Number(m1[1]), Number(m1[2])];
    const m2 = url.match(/\/[snm](\d{1,5})x(\d{1,5})_/i);
    if (m2) return [Number(m2[1]), Number(m2[2])];
    const m3 = url.match(/[?&](?:w|width)=(\d{1,5})/i);
    if (m3) {
      const w = Number(m3[1]);
      return [w, w];
    }
    return null;
  }

  /**
   * 启发式判断某个 URL 是否可能为商品图。
   * @param {string} url
   * @returns {boolean}
   */
  function isLikelyProductImage(url) {
    if (!url) return false;
    if (!/^https?:\/\//i.test(url)) return false;   // 排除 data: / blob: 等
    const lower = url.toLowerCase();

    // svg 一般是图标
    if (/\.svg(\?|#|$)/i.test(lower)) return false;

    // 常见图标 / 占位关键词（大小写敏感 + 字母边界，详见 BAD_RE 注释）
    if (BAD_RE.test(url)) return false;

    // 无扩展名的资源也放行（部分 CDN 用路径而非扩展名），但必须像图片路径
    if (IMG_EXT_RE.test(lower)) return true;
    return /(?:img|pic|image|photo|goods|item|sku)/i.test(lower);
  }

  /* --------------------------- 图片采集 --------------------------- */

  /**
   * 采集当前页面中的候选商品图。
   * @returns {{url:string,width:number,height:number}[]}
   */
  function collectImages() {
    /** @type {Map<string, {url:string,width:number,height:number}>} */
    const found = new Map();

    /**
     * 加入一张候选图（统一做绝对化、过滤、去重）。
     * @param {string} rawUrl
     * @param {number} [w]
     * @param {number} [h]
     */
    function add(rawUrl, w, h) {
      const url = absolutize(rawUrl);
      if (!url || !isLikelyProductImage(url)) return;

      let W = Number(w) || 0;
      let H = Number(h) || 0;
      if ((!W || !H)) {
        const guess = parseSizeFromUrl(url);
        if (guess) {
          W = W || guess[0];
          H = H || guess[1];
        }
      }
      // 已知尺寸且过小 → 过滤（图标 / 缩略占位）
      if (W && H && (W < MIN_SIZE || H < MIN_SIZE)) return;

      const key = url.split('#')[0]; // 去掉 hash 后去重
      const prev = found.get(key);
      if (!prev) {
        found.set(key, { url, width: W, height: H });
      } else if (W * H > prev.width * prev.height) {
        // 同一 URL 记录了更大尺寸时更新
        prev.width = W;
        prev.height = H;
      }
    }

    // 1) 所有 <img>：src / srcset / 懒加载属性
    document.querySelectorAll('img').forEach((img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      add(img.currentSrc || img.getAttribute('src'), w, h);
      add(img.getAttribute('data-src'), w, h);
      parseSrcset(img.getAttribute('srcset')).forEach((u) => add(u, w, h));
      parseSrcset(img.getAttribute('data-srcset')).forEach((u) => add(u, w, h));
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) add(v, w, h);
      }
    });

    // 2) <picture><source srcset>
    document.querySelectorAll('source').forEach((s) => {
      parseSrcset(s.getAttribute('srcset')).forEach((u) => add(u));
      parseSrcset(s.getAttribute('data-srcset')).forEach((u) => add(u));
    });

    // 3) 背景图：扫描元素数量设上限，避免超长列表页卡顿
    const nodes = document.querySelectorAll('*');
    const limit = Math.min(nodes.length, MAX_SCAN_ELEMENTS);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      // 先看内联样式（快），命中即提取
      const inline = el.getAttribute && el.getAttribute('style');
      if (inline && inline.includes('url(')) {
        extractCssUrls(inline).forEach((u) => add(u));
      }
      // 再看计算样式（慢，但能拿到 class 里定义的背景图）
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        extractCssUrls(bg).forEach((u) => add(u));
      }
    }

    // 4) 指向图片的 <a href>
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (IMG_EXT_RE.test(href)) add(href);
    });

    // 5) og:image（通常是主图）
    const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (og) add(og.getAttribute('content'));

    // 按面积从大到小排序，让主图排在前面
    return [...found.values()].sort((a, b) => b.width * b.height - a.width * a.height);
  }

  /* --------------------------- 悬浮按钮 --------------------------- */

  /** 创建并插入「获取图片」悬浮按钮 */
  function injectButton(platform) {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', '获取当前页面所有商品图片');
    btn.innerHTML =
      '<span class="ig-spinner" aria-hidden="true"></span>' +
      '<svg class="ig-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      '<circle cx="9" cy="9.3" r="1.7" fill="currentColor"/>' +
      '<path d="M5.4 17.2l3.5-3.6a1.3 1.3 0 0 1 1.9 0l2.1 2.2 1.2-1.2a1.3 1.3 0 0 1 1.9 0l1.9 2" ' +
      'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '</svg>' +
      '<span class="ig-label">获取图片</span>';

    document.body.appendChild(btn);

    let busy = false;
    btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      btn.classList.add('is-loading');
      setLabel(btn, '正在扫描…');

      try {
        const images = collectImages();
        if (!images.length) {
          setLabel(btn, '未找到图片');
          toast('未在当前页面找到符合条件的商品图');
          setTimeout(() => resetBtn(btn), 1800);
          return;
        }
        const resp = await sendToBackground({
          type: 'IMAGEGRAB_EXTRACT',
          platform,
          images,
          title: document.title,
          sourceUrl: location.href
        });
        if (resp && resp.ok) {
          setLabel(btn, `已提取 ${images.length} 张`);
          toast(`已提取 ${images.length} 张图片，正在打开画廊…`);
          setTimeout(() => resetBtn(btn), 1800);
        } else {
          throw new Error((resp && resp.error) || '后台未响应');
        }
      } catch (err) {
        console.warn('[图提取] 提取失败：', err);
        setLabel(btn, '提取失败');
        toast('提取失败，请刷新页面后重试');
        setTimeout(() => resetBtn(btn), 2200);
      } finally {
        busy = false;
        btn.classList.remove('is-loading');
      }
    });

    if (DEBUG) {
      window.__IMAGEGRAB_DEBUG__ = window.__IMAGEGRAB_DEBUG__ || {};
      window.__IMAGEGRAB_DEBUG__.collect = collectImages;
    }
  }

  function setLabel(btn, text) {
    const el = btn.querySelector('.ig-label');
    if (el) el.textContent = text;
  }

  function resetBtn(btn) {
    setLabel(btn, '获取图片');
  }

  /** 页面内轻提示 */
  function toast(text) {
    const old = document.getElementById('imagegrab-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.id = 'imagegrab-toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('is-show'), 10);
    setTimeout(() => {
      t.classList.remove('is-show');
      setTimeout(() => t.remove(), 300);
    }, 2600);
  }

  /** 带 Promise 包装的 sendMessage（兼容回调式 / Promise 式两种实现） */
  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* --------------------------- 启动 --------------------------- */

  function boot() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
    const platform = detectPlatform(location.hostname);
    if (platform === 'unknown') return;
    if (!isDetailPage(platform)) return;
    injectButton(platform);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 单页应用路由切换后页面可能被替换，监听一下确保按钮仍在（淘宝/拼多多有 SPA 行为）
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(boot, 800);
    }
  }, 1500);
})();
