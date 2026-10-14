/* =============================================================================
 * 图提取 ImageGrab — 官网脚本（docs/js/main.js）
 * 功能：导航吸顶与滚动高亮、移动端汉堡菜单、滚动淡入动画、
 *       以及首屏「插件演示」的交互（提取 → 勾选 → 下载）。
 * ===========================================================================*/

(function () {
  'use strict';

  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------ 导航 ------------------------------ */

  const nav = $('#nav');
  const navLinks = $('#navLinks');
  const burger = $('#navBurger');
  const sectionLinks = $$('.nav__links a[href^="#"]:not(.btn)');
  const sections = sectionLinks
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);

  /** 滚动时：吸顶背景 + 当前区块高亮 */
  function onScroll() {
    const y = window.scrollY || window.pageYOffset;

    // 吸顶样式
    if (y > 8) nav.classList.add('is-scrolled');
    else nav.classList.remove('is-scrolled');

    // 当前区块高亮：取「已经滚过顶部」的最后一个区块
    let activeId = null;
    const probe = y + 140;
    sections.forEach((sec) => {
      if (sec.offsetTop <= probe) activeId = sec.id;
    });
    sectionLinks.forEach((a) => {
      a.classList.toggle('is-active', a.getAttribute('href') === '#' + activeId);
    });
  }

  let scrollTick = false;
  window.addEventListener('scroll', () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      onScroll();
      scrollTick = false;
    });
  }, { passive: true });
  onScroll();

  /* 移动端汉堡菜单 */
  function closeMenu() {
    navLinks.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', '打开菜单');
  }
  burger.addEventListener('click', () => {
    const open = navLinks.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  });
  navLinks.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!navLinks.classList.contains('is-open')) return;
    if (e.target.closest('#navLinks') || e.target.closest('#navBurger')) return;
    closeMenu();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 767) closeMenu();
  });

  /* ------------------------------ 滚动淡入 ------------------------------ */

  const revealEls = $$('.reveal');

  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry, i) => {
          if (!entry.isIntersecting) return;
          // 同批元素做一点错峰，避免整块同时冒出
          entry.target.style.transitionDelay = Math.min(i * 70, 210) + 'ms';
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
    );
    revealEls.forEach((el) => io.observe(el));
  }

  /* 首屏入场序列 */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.body.classList.add('is-ready'));
  });

  /* ------------------------------ 首屏演示 ------------------------------ */

  const demo = $('#demo');
  if (demo) initDemo();

  function initDemo() {
    const fab = $('#demoFab');
    const gallery = $('#demoGallery');
    const grid = $('#demoGrid');
    const countEl = $('#demoCount');
    const downloadBtn = $('#demoDownload');
    const progressBar = $('#demoProg');
    const backBtn = $('#demoBack');
    const hint = $('#demoHint');

    const TILE_COUNT = 8;
    const HUE_START = 214;   // 蓝紫区间，模拟不同商品图
    const HUE_STEP = 11;

    /**
     * 生成演示用的图片方块。
     * 每块是一个可勾选的按钮，点击切换选中状态。
     */
    function buildTiles() {
      grid.textContent = '';
      for (let i = 0; i < TILE_COUNT; i++) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'demo__tile';
        tile.setAttribute('role', 'checkbox');
        tile.setAttribute('aria-checked', 'true');
        tile.setAttribute('aria-label', '商品图 ' + (i + 1));
        // 用 CSS 变量控制色相，制造「不同图片」的观感
        tile.style.setProperty('--h', String(HUE_START + i * HUE_STEP));
        // 逐个错峰出现
        tile.style.transitionDelay = 90 + i * 45 + 'ms';

        const tick = document.createElement('span');
        tick.className = 'demo__tick';
        tick.textContent = '✓';
        tick.setAttribute('aria-hidden', 'true');
        tile.appendChild(tick);

        tile.addEventListener('click', () => {
          const now = tile.getAttribute('aria-checked') === 'true';
          tile.setAttribute('aria-checked', String(!now));
          updateCount();
          resetDownloadState();
        });

        grid.appendChild(tile);
      }
    }

    function selectedCount() {
      return $$('.demo__tile[aria-checked="true"]', grid).length;
    }

    function updateCount() {
      countEl.textContent = '已选 ' + selectedCount() + ' / ' + TILE_COUNT;
    }

    function resetDownloadState() {
      downloadBtn.disabled = selectedCount() === 0;
      downloadBtn.textContent = '下载选中为 PNG';
      progressBar.style.width = '0%';
      gallery.classList.remove('is-done');
    }

    /* 点击「获取图片」：画廊从底部滑入 */
    fab.addEventListener('click', () => {
      buildTiles();
      updateCount();
      resetDownloadState();
      gallery.classList.add('is-open');
      gallery.setAttribute('aria-hidden', 'false');
      hint.textContent = '试着点掉几张不想要的图，再点「下载选中为 PNG」';
    });

    /* 模拟下载：进度条走满后给出「已保存」反馈 */
    downloadBtn.addEventListener('click', () => {
      const total = selectedCount();
      if (!total) return;
      downloadBtn.disabled = true;
      downloadBtn.textContent = '正在转换…';

      let p = 0;
      const timer = setInterval(() => {
        p += 12 + Math.random() * 10;
        progressBar.style.width = Math.min(p, 100) + '%';
        if (p >= 100) {
          clearInterval(timer);
          downloadBtn.textContent = '已保存 ' + total + ' 张 PNG';
          gallery.classList.add('is-done');
          hint.textContent = '实际使用中，图片会保存到浏览器下载目录的「图提取」文件夹。';
        }
      }, 110);
    });

    /* 重新演示：复位到商品页 */
    backBtn.addEventListener('click', () => {
      gallery.classList.remove('is-open');
      gallery.classList.remove('is-done');
      gallery.setAttribute('aria-hidden', 'true');
      progressBar.style.width = '0%';
      hint.textContent = '点一下右下角的按钮，看看插件是怎么工作的';
    });
  }
})();
