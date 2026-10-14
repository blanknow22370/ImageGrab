/* =============================================================================
 * 图提取 ImageGrab — background.js（Manifest V3 Service Worker）
 * 职责：
 *   1. 接收 content.js 提取到的图片列表，存入 chrome.storage.session，
 *      并打开画廊页 gallery.html 展示。
 *   2. 处理画廊页的下载请求：在后台 fetch 原图 → createImageBitmap 解码 →
 *      OffscreenCanvas 重绘 → 统一导出 PNG → chrome.downloads.download 保存。
 *   跨域问题在 Service Worker 内处理（依赖 manifest 的 host_permissions）。
 * ===========================================================================*/

const STORAGE_KEY = 'imagegrab_last';
const GALLERY_PATH = 'gallery.html';

/* ------------------------------ 消息路由 ------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'IMAGEGRAB_EXTRACT':
      handleExtract(msg, sender).then(sendResponse).catch(toError(sendResponse));
      return true; // 异步：保持消息通道开启

    case 'IMAGEGRAB_GET_LAST':
      chrome.storage.session
        .get(STORAGE_KEY)
        .then((r) => sendResponse({ ok: true, data: r[STORAGE_KEY] || null }))
        .catch(toError(sendResponse));
      return true;

    case 'IMAGEGRAB_DOWNLOAD':
      downloadAsPng(msg).then(sendResponse).catch(toError(sendResponse));
      return true;

    case 'IMAGEGRAB_DOWNLOAD_RAW':
      downloadRaw(msg).then(sendResponse).catch(toError(sendResponse));
      return true;

    case 'IMAGEGRAB_CLEAR':
      chrome.storage.session
        .remove(STORAGE_KEY)
        .then(() => sendResponse({ ok: true }))
        .catch(toError(sendResponse));
      return true;

    default:
      return; // 不认识的类型不占用消息通道
  }
});

/** 统一的错误回调包装 */
function toError(sendResponse) {
  return (err) => {
    console.warn('[图提取] 后台出错：', err);
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  };
}

/* --------------------------- 提取结果处理 --------------------------- */

/**
 * 保存提取结果并打开画廊页。
 * @param {{images?:Array, title?:string, platform?:string, sourceUrl?:string}} msg
 * @param {{tab?: chrome.tabs.Tab}} sender
 */
async function handleExtract(msg, sender) {
  const images = Array.isArray(msg.images) ? msg.images : [];
  // 内容脚本无法访问 storage.session（受信上下文限制），因此由后台写库
  const payload = {
    images: images.map((it) => ({
      url: it.url,
      width: it.width || 0,
      height: it.height || 0
    })),
    title: msg.title || (sender && sender.tab && sender.tab.title) || '',
    platform: msg.platform || '',
    sourceUrl: msg.sourceUrl || (sender && sender.tab && sender.tab.url) || '',
    at: Date.now()
  };

  await chrome.storage.session.set({ [STORAGE_KEY]: payload });
  await chrome.tabs.create({ url: chrome.runtime.getURL(GALLERY_PATH), active: true });
  return { ok: true, count: payload.images.length };
}

/* ------------------------------ 下载逻辑 ------------------------------ */

/**
 * 将图片抓取并统一转换为 PNG 后下载。
 * @param {{url:string, filename?:string, index?:number}} msg
 */
async function downloadAsPng(msg) {
  const url = msg.url;
  if (!url) throw new Error('缺少图片地址');

  const pngBlob = await fetchAsPngBlob(url);
  const dataUrl = await blobToDataURL(pngBlob);
  const filename = normalizeFilename(msg.filename, msg.index);

  const id = await chrome.downloads.download({
    url: dataUrl,
    filename,
    conflictAction: 'uniquify', // 重名自动加 (1) (2)
    saveAs: false
  });

  return { ok: true, id, filename, bytes: pngBlob.size };
}

/** 兜底：转换失败时按原格式直接下载原图 */
async function downloadRaw(msg) {
  const url = msg.url;
  if (!url) throw new Error('缺少图片地址');
  const ext = guessExt(url);
  const filename = normalizeFilename(
    msg.filename ? msg.filename.replace(/\.png$/i, '.' + ext) : '',
    msg.index,
    ext
  );
  const id = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });
  return { ok: true, id, filename, raw: true };
}

/**
 * 抓取远程图片并转成 PNG Blob。
 * 使用 Service Worker 可用的 OffscreenCanvas + createImageBitmap，
 * 绕开页面 canvas 被跨域图片污染（tainted）的问题。
 * @param {string} url
 * @returns {Promise<Blob>}
 */
async function fetchAsPngBlob(url) {
  let resp;
  try {
    resp = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  } catch (e) {
    throw new Error('网络请求失败（可能缺少该域名的访问权限）');
  }
  if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);

  const srcBlob = await resp.blob();
  if (!srcBlob || !srcBlob.size) throw new Error('图片内容为空');

  let bitmap;
  try {
    bitmap = await createImageBitmap(srcBlob);
  } catch (e) {
    throw new Error('图片解码失败（格式不受支持）');
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === 'function') bitmap.close();

  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Blob → data URL。Service Worker 中无法用 URL.createObjectURL，
 * 故用 FileReader 转成 data URL 供 downloads API 使用。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('图片编码失败'));
    fr.readAsDataURL(blob);
  });
}

/** 生成「商品图_001.png」格式的文件名 */
function normalizeFilename(filename, index, ext) {
  const extension = ext || 'png';
  if (filename) {
    return filename.includes('/') ? filename : `图提取/${filename}`;
  }
  const n = String(Number(index) || 1).padStart(3, '0');
  return `图提取/商品图_${n}.${extension}`;
}

/** 从 URL 猜测扩展名，缺省 jpg */
function guessExt(url) {
  const m = String(url).match(/\.(jpe?g|png|webp|bmp|avif|gif)(?:\?|#|$)/i);
  if (!m) return 'jpg';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

/* --------------------------- 工具栏图标点击 --------------------------- */

// 未配置 popup 时，点击工具栏图标会触发 onClicked：直接打开画廊
chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(GALLERY_PATH), active: true });
});

/* ------------------------------ 安装提示 ------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.info('[图提取] 安装完成。打开淘宝 / 京东 / 拼多多商品详情页，点击右下角「获取图片」即可。');
  }
});
