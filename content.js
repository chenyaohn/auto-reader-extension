/* 自动阅读助手 · 内容脚本
 * 功能：自动向下滑动页面、滑动速度可调、悬浮控制条、快捷键、到底自动下一章。
 */
(() => {
  'use strict';
  if (window.__AUTO_READER_READY__) return;
  window.__AUTO_READER_READY__ = true;

  const SPEED_MIN = 2;   // 像素 / 秒
  const SPEED_MAX = 120;

  /* 正文识别参数：只决定悬浮条是否显示，不改变滚动行为 */
  const ARTICLE_MIN_TEXT = 400;
  const ARTICLE_MIN_SCORE = 750;
  const ARTICLE_LABEL_POSITIVE = /article|content|chapter|read|entry|main|post|text|novel|story|book/i;
  const ARTICLE_LABEL_NEGATIVE = /comment|nav|menu|sidebar|footer|share|related|recommend|advert|banner|copyright|toolbar|reward|gift|rank|list/i;
  const ARTICLE_SELECTOR = [
    'article', 'main', '[role="main"]', '[itemprop="articleBody"]',
    '#content', '#article', '#chapter-content', '#chapterContent', '#j_chapterBox',
    '.content', '.article', '.article-content', '.content-text', '.post', '.entry',
    '.chapter', '.chapter-content', '.read-content', '.j_readContent',
    '.novel-content', '.book-content', '.text-content', '.main-text'
  ].join(',');

  const DEFAULTS = {
    speed: 12,          // 滑动速度，像素 / 秒
    smooth: true,       // 逐帧平滑滑动
    autoNext: false,    // 到底部后自动进入下一章
    nextDelay: 3,       // 自动下一章等待秒数
    hoverPause: true,   // 鼠标停在悬浮条上时暂停
    manualPause: true,  // 手动滚动时短暂暂停
    resumeOnLoad: true, // 换章 / 刷新后自动继续阅读
    panelHidden: false, // 隐藏悬浮控制条
    panelPos: null      // 悬浮条位置 { top, right }
  };

  const SESSION_DEFAULTS = { running: false };

  const state = { ...DEFAULTS, ...SESSION_DEFAULTS };

  let scrollEl = null;        // null 表示滚动窗口本身
  let rafId = null;
  let lastTs = 0;
  let acc = 0;                // 平滑滑动的小数余量
  let lastDiscrete = 0;       // 非平滑模式的节流时间
  let hoveringPanel = false;
  let manualPauseUntil = 0;
  let lastToggleTs = 0;
  let pickTick = 0;
  let countdownTimer = null;
  let nextLink = null;
  let nextAttempts = 0; // 连续自动翻章的尝试次数，用于识别「点了但没换页」
  let density = 0.9;    // 估算的文字密度：字 / 像素
  let lastDensityTs = 0;
  let articleDetected = false;
  let detectTimer = null;
  let detectAttempts = 0;
  let lastDetectTs = 0;
  let lastHref = location.href;

  /* ------------------------------------------------------------------ 存储 */

  function areaGet(area, defaults) {
    return new Promise((resolve) => {
      try {
        area.get(defaults, (res) => resolve({ ...defaults, ...res }));
      } catch (e) {
        resolve({ ...defaults });
      }
    });
  }

  function areaSet(area, patch) {
    try {
      area.set(patch);
    } catch (e) {
      /* 忽略：部分环境（如无痕）可能不可用 */
    }
  }

  async function loadState() {
    const sync = await areaGet(chrome.storage.sync, DEFAULTS);
    const session = await areaGet(chrome.storage.session, SESSION_DEFAULTS);
    Object.assign(state, sync, session);
  }

  function savePrefs(patch) {
    Object.assign(state, patch);
    areaSet(chrome.storage.sync, patch);
  }

  function saveSession(patch) {
    Object.assign(state, patch);
    areaSet(chrome.storage.session, patch);
  }

  /* -------------------------------------------------------------- 滚动目标 */

  function pickScroller() {
    const de = document.scrollingElement || document.documentElement;
    if (de.scrollHeight - window.innerHeight > 40) {
      scrollEl = null;
      return;
    }
    const nodes = document.querySelectorAll('div, main, section, article, body');
    const candidates = [];
    for (const el of nodes) {
      const style = getComputedStyle(el);
      const oy = style.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const range = el.scrollHeight - el.clientHeight;
      if (range < 80) continue;
      if (el.clientHeight < window.innerHeight * 0.35) continue;
      candidates.push({ el, range });
    }
    candidates.sort((a, b) => b.range - a.range);
    scrollEl = candidates.length ? candidates[0].el : null;
  }

  function readScroll() {
    if (scrollEl && scrollEl.isConnected) return scrollEl.scrollTop;
    return window.scrollY || (document.scrollingElement || document.documentElement).scrollTop || 0;
  }

  function maxScroll() {
    if (scrollEl && scrollEl.isConnected) {
      return Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    }
    const de = document.scrollingElement || document.documentElement;
    return Math.max(0, de.scrollHeight - window.innerHeight);
  }

  function writeScroll(value) {
    const v = Math.max(0, value);
    if (scrollEl && scrollEl.isConnected) {
      scrollEl.scrollTop = v;
    } else {
      window.scrollTo({ top: v, behavior: 'auto' });
    }
  }

  function atBottom() {
    return readScroll() >= maxScroll() - 2;
  }

  /* 估算「字 / 像素」，用于把 px/s 换算成更直观的「字 / 分钟」 */
  function measureDensity() {
    try {
      const max = maxScroll();
      if (max < 200) return;
      const text = (document.body.innerText || '').replace(/\s+/g, '');
      if (text.length < 80) return;
      density = Math.min(3, Math.max(0.1, text.length / max));
    } catch (e) {
      /* 保持上一次的估算值 */
    }
  }

  /* ------------------------------------------------------------ 正文识别 */

  function plainText(el) {
    try {
      return (el.innerText || el.textContent || '').replace(/\s+/g, '');
    } catch (e) {
      return (el.textContent || '').replace(/\s+/g, '');
    }
  }

  function punctuationCount(text) {
    return (text.match(/[，。！？；：、…—,.!?;:]/g) || []).length;
  }

  /* 给一个候选块打分：正文长度 + 段落 + 标点密度 − 链接密度 */
  function scoreArticleBlock(el) {
    if (!el || el.id === 'auto-reader-host') return 0;
    const text = plainText(el);
    if (text.length < ARTICLE_MIN_TEXT) return 0;

    let linkChars = 0;
    for (const a of el.querySelectorAll('a')) {
      linkChars += (a.textContent || '').replace(/\s+/g, '').length;
    }
    const linkDensity = Math.min(1, linkChars / text.length);
    if (linkDensity > 0.35) return 0;

    const punctDensity = punctuationCount(text) / text.length;
    if (punctDensity < 0.02) return 0;

    const paragraphs = el.querySelectorAll('p').length;
    const label = `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`;
    let score = text.length + paragraphs * 25 + punctDensity * 2000 - linkDensity * 2500;
    if (ARTICLE_LABEL_POSITIVE.test(label)) score += 400;
    if (ARTICLE_LABEL_NEGATIVE.test(label)) score -= 600;
    return score;
  }

  /* 页面级信号：og:type=article 或 JSON-LD 里的 Article */
  function articleMetaBonus() {
    try {
      const og = document.querySelector('meta[property="og:type"]');
      if (og && /article|book|novel|story/i.test(og.getAttribute('content') || '')) return 300;
      const head = document.head ? document.head.innerHTML : '';
      if (/["']@type["']\s*:\s*["'](?:Article|NewsArticle|BlogPosting|Book|Chapter)["']/.test(head)) return 300;
    } catch (e) {
      /* 忽略 */
    }
    return 0;
  }

  /* 兜底：没有语义标签的站点，按整页文字质量判断 */
  function fallbackLooksLikeArticle() {
    const body = document.body;
    if (!body) return false;
    const text = plainText(body);
    if (text.length < 1500) return false;
    let linkChars = 0;
    for (const a of body.querySelectorAll('a')) {
      linkChars += (a.textContent || '').replace(/\s+/g, '').length;
    }
    const linkDensity = linkChars / text.length;
    return linkDensity <= 0.2
      && punctuationCount(text) / text.length >= 0.02
      && body.querySelectorAll('p').length >= 6;
  }

  function detectArticle() {
    try {
      let best = 0;
      for (const el of document.querySelectorAll(ARTICLE_SELECTOR)) {
        const score = scoreArticleBlock(el);
        if (score > best) best = score;
      }
      if (best + articleMetaBonus() >= ARTICLE_MIN_SCORE) return true;
      return fallbackLooksLikeArticle();
    } catch (e) {
      return false;
    }
  }

  function refreshArticleDetection() {
    lastDetectTs = Date.now();
    const detected = detectArticle();
    if (detected === articleDetected) return;
    articleDetected = detected;
    render();
  }

  function scheduleArticleDetection(delay = 900) {
    if (detectTimer || detectAttempts >= 8) return;
    detectTimer = setTimeout(() => {
      detectTimer = null;
      if (articleDetected) return;
      detectAttempts += 1;
      refreshArticleDetection();
    }, delay);
  }

  function resetArticleDetection() {
    articleDetected = false;
    detectAttempts = 0;
    if (detectTimer) clearTimeout(detectTimer);
    detectTimer = null;
    render();
    scheduleArticleDetection(700);
  }

  /* 页面内容懒加载 / 站内无刷新跳转时重新识别 */
  function watchArticleDetection() {
    try {
      const mo = new MutationObserver(() => {
        if (!articleDetected && detectAttempts < 8) scheduleArticleDetection(900);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      /* 忽略 */
    }
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      resetArticleDetection();
    }, 1200);
  }

  /* -------------------------------------------------------------------- UI */

  const host = document.createElement('div');
  host.id = 'auto-reader-host';
  /* 先隐藏，等正文识别完成后再由 render() 决定是否显示，避免闪烁 */
  host.style.cssText = 'all:initial;display:none;position:fixed;z-index:2147483647;right:14px;top:50%;margin-top:-74px;';
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
      .wrap { position: relative; pointer-events: none; }
      .pill, .sheet, .toast { pointer-events: auto; }
      .pill {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        padding: 7px 6px; border-radius: 16px;
        background: rgba(24, 24, 30, 0.86);
        box-shadow: 0 8px 26px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08) inset;
        backdrop-filter: blur(10px);
        color: #f4f4f8; font-size: 13px; line-height: 1.2;
        transition: opacity .25s ease, box-shadow .2s ease;
        opacity: .55;
      }
      .wrap:hover .pill, .wrap.active .pill, .wrap.dragging .pill { opacity: 1; }
      .btn {
        width: 32px; height: 32px; border: 0; border-radius: 10px;
        background: rgba(255,255,255,.08); color: #f4f4f8;
        font-size: 15px; cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background .15s ease, transform .08s ease;
        padding: 0;
      }
      .btn:hover { background: rgba(255,255,255,.2); }
      .btn:active { transform: scale(.94); }
      .btn.play { background: #3b82f6; font-size: 14px; }
      .btn.play:hover { background: #2f74e6; }
      .btn.play.on { background: #ef4444; }
      .btn.play.on:hover { background: #dc3b3b; }
      .btn.play.on::after {
        content: ""; position: absolute; width: 32px; height: 32px; border-radius: 10px;
        box-shadow: 0 0 0 0 rgba(239,68,68,.55); animation: pulse 1.8s infinite;
      }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(239,68,68,.45); }
        70% { box-shadow: 0 0 0 9px rgba(239,68,68,0); }
        100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
      }
      .speedBox {
        display: flex; flex-direction: column; align-items: center; gap: 0;
        cursor: pointer; user-select: none; padding: 3px 2px; border-radius: 8px;
      }
      .speedBox:hover { background: rgba(255,255,255,.12); }
      .speedNum { font-size: 13px; font-weight: 600; letter-spacing: .2px; }
      .speedUnit { font-size: 9px; opacity: .6; }
      .sheet {
        position: absolute; right: calc(100% + 10px); top: 0;
        width: 258px; padding: 12px 13px 11px; border-radius: 16px;
        background: rgba(24, 24, 30, 0.94);
        box-shadow: 0 14px 40px rgba(0,0,0,.34), 0 0 0 1px rgba(255,255,255,.08) inset;
        backdrop-filter: blur(12px); color: #f4f4f8; font-size: 12.5px;
      }
      .sheet.hidden, .toast.hidden, .wrap.hidden { display: none; }
      .sheetHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      .sheetHead b { font-size: 13.5px; font-weight: 600; }
      .sheetHead .close { width: 24px; height: 24px; font-size: 12px; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 7px 0; }
      .row span.label { opacity: .9; }
      input[type="range"] {
        -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 4px;
        background: linear-gradient(90deg, #3b82f6 var(--pct, 20%), rgba(255,255,255,.16) var(--pct, 20%));
        outline: none; margin: 6px 0 2px;
      }
      input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 15px; height: 15px; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); cursor: pointer;
      }
      .speedTop { display: flex; align-items: baseline; justify-content: space-between; }
      .speedTop .big { font-size: 19px; font-weight: 650; }
      .speedTop .big small { font-size: 10px; font-weight: 400; opacity: .6; margin-left: 3px; }
      .presets { display: flex; gap: 5px; margin: 8px 0 4px; }
      .presets button {
        flex: 1; padding: 5px 0; border: 0; border-radius: 8px; cursor: pointer;
        background: rgba(255,255,255,.09); color: #f4f4f8; font-size: 11.5px;
      }
      .presets button:hover { background: rgba(255,255,255,.2); }
      .cpm { margin: 3px 0 0; font-size: 11.5px; opacity: .68; }
      .meta { display: flex; justify-content: space-between; opacity: .72; font-size: 11.5px; margin: 8px 0 2px; }
      .bar { height: 4px; border-radius: 4px; background: rgba(255,255,255,.14); overflow: hidden; margin-bottom: 4px; }
      .bar i { display: block; height: 100%; width: 0%; background: #3b82f6; border-radius: 4px; }
      .divider { height: 1px; background: rgba(255,255,255,.1); margin: 10px 0 6px; }
      .switch { position: relative; width: 34px; height: 19px; flex: 0 0 auto; }
      .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
      .switch i {
        position: absolute; inset: 0; border-radius: 19px; background: rgba(255,255,255,.2);
        transition: background .18s ease; pointer-events: none;
      }
      .switch i::after {
        content: ""; position: absolute; top: 2.5px; left: 2.5px; width: 14px; height: 14px;
        border-radius: 50%; background: #fff; transition: transform .18s ease;
      }
      .switch input:checked + i { background: #3b82f6; }
      .switch input:checked + i::after { transform: translateX(15px); }
      .foot { display: flex; gap: 6px; margin-top: 10px; }
      .foot button {
        flex: 1; padding: 7px 0; border: 0; border-radius: 9px; cursor: pointer;
        background: rgba(255,255,255,.1); color: #f4f4f8; font-size: 12px;
      }
      .foot button:hover { background: rgba(255,255,255,.2); }
      .hint { margin-top: 9px; font-size: 11px; opacity: .55; line-height: 1.5; }
      .toast {
        position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; border-radius: 12px;
        background: rgba(24,24,30,.94); color: #f4f4f8; font-size: 13px;
        box-shadow: 0 10px 30px rgba(0,0,0,.32);
      }
      .toast button {
        border: 0; border-radius: 8px; padding: 4px 10px; cursor: pointer;
        background: rgba(255,255,255,.14); color: #fff; font-size: 12px;
      }
      .toast button:hover { background: rgba(255,255,255,.26); }
      .hidden { display: none !important; }
    </style>
    <div class="wrap">
      <div class="pill">
        <button class="btn play" data-act="toggle" title="开始 / 暂停（Alt+S）">▶</button>
        <div class="speedBox" data-act="sheet" title="点击调整滑动速度">
          <span class="speedNum">60</span>
          <span class="speedUnit">px/s</span>
        </div>
        <button class="btn" data-act="sheet" title="设置">⚙</button>
      </div>
      <div class="sheet hidden">
        <div class="sheetHead">
          <b>自动阅读</b>
          <button class="btn close" data-act="closeSheet" title="收起">✕</button>
        </div>
        <div class="speedTop">
          <span>滑动速度</span>
          <span class="big"><span class="num">60</span><small>px/s</small></span>
        </div>
        <input type="range" min="2" max="120" step="1" value="12">
        <div class="presets">
          <button data-speed="6">慢 6</button>
          <button data-speed="12">舒适 12</button>
          <button data-speed="24">快 24</button>
          <button data-speed="50">极速 50</button>
        </div>
        <div class="cpm">≈ <span class="cpmNum">650</span> 字 / 分钟</div>
        <div class="meta">
          <span class="progressText">进度 0%</span>
          <span class="etaText">剩余 —</span>
        </div>
        <div class="bar"><i></i></div>
        <div class="divider"></div>
        <label class="row">
          <span class="label">到底自动进入下一章</span>
          <span class="switch"><input type="checkbox" data-key="autoNext"><i></i></span>
        </label>
        <label class="row">
          <span class="label">平滑滑动</span>
          <span class="switch"><input type="checkbox" data-key="smooth"><i></i></span>
        </label>
        <label class="row">
          <span class="label">鼠标移到控制条上暂停</span>
          <span class="switch"><input type="checkbox" data-key="hoverPause"><i></i></span>
        </label>
        <label class="row">
          <span class="label">手动滚动时暂停</span>
          <span class="switch"><input type="checkbox" data-key="manualPause"><i></i></span>
        </label>
        <label class="row">
          <span class="label">换章后自动继续</span>
          <span class="switch"><input type="checkbox" data-key="resumeOnLoad"><i></i></span>
        </label>
        <div class="foot">
          <button data-act="top">回到顶部</button>
          <button data-act="hide">隐藏控制条</button>
        </div>
        <div class="hint">快捷键：Alt+S 开始/暂停 · Alt+↑ 加速 · Alt+↓ 减速 · Alt+T 回顶部<br>拖动蓝色播放键旁的空白可以移动控制条。</div>
      </div>
      <div class="toast hidden"><span class="toastMsg"></span><button data-act="cancelNext">取消</button></div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const wrap = root.querySelector('.wrap');
  const pill = root.querySelector('.pill');
  const sheet = root.querySelector('.sheet');
  const toast = root.querySelector('.toast');
  const toastMsg = root.querySelector('.toastMsg');
  const playBtn = root.querySelector('.btn.play');
  const speedNumPill = root.querySelector('.speedNum');
  const speedNumSheet = root.querySelector('.num');
  const range = root.querySelector('input[type="range"]');
  const progressText = root.querySelector('.progressText');
  const progressBar = root.querySelector('.bar i');
  const etaText = root.querySelector('.etaText');
  const cpmNum = root.querySelector('.cpmNum');
  const toggles = [...root.querySelectorAll('input[data-key]')];

  /* ------------------------------------------------------------- UI 渲染 */

  function render() {
    playBtn.textContent = state.running ? '❚❚' : '▶';
    playBtn.classList.toggle('on', state.running);
    wrap.classList.toggle('active', state.running);
    speedNumPill.textContent = String(state.speed);
    speedNumSheet.textContent = String(state.speed);
    if (Number(range.value) !== state.speed) range.value = String(state.speed);
    const pct = ((state.speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100;
    range.style.setProperty('--pct', pct.toFixed(1) + '%');
    cpmNum.textContent = String(Math.round(state.speed * 60 * density));
    for (const input of toggles) {
      input.checked = !!state[input.dataset.key];
    }
    host.style.display = (state.panelHidden || !articleDetected) ? 'none' : '';
    renderProgress();
  }

  function renderProgress() {
    const max = maxScroll();
    const pos = Math.min(readScroll(), max);
    const pct = max > 0 ? (pos / max) * 100 : 0;
    progressText.textContent = `进度 ${pct.toFixed(0)}%`;
    progressBar.style.width = pct.toFixed(1) + '%';
    if (!state.running || max <= pos) {
      etaText.textContent = max <= pos ? '已到底部' : '剩余 —';
      return;
    }
    const seconds = Math.round((max - pos) / Math.max(1, state.speed));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    etaText.textContent = `剩余 ≈ ${m}:${String(s).padStart(2, '0')}`;
  }

  /* --------------------------------------------------------- 滚动主循环 */

  function pausedNow() {
    if (state.hoverPause && hoveringPanel) return true;
    if (state.manualPause && Date.now() < manualPauseUntil) return true;
    return false;
  }

  function tick(ts) {
    if (!state.running) {
      rafId = null;
      return;
    }
    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.25) dt = 0.25;

    // 每 2 秒重新确认一次滚动容器，兼容懒加载 / 布局变化
    if (++pickTick > 120) {
      pickTick = 0;
      pickScroller();
    }
    if (ts - lastDensityTs > 5000) {
      lastDensityTs = ts;
      measureDensity();
    }

    if (pausedNow()) {
      acc = 0;
    } else if (state.smooth) {
      acc += state.speed * dt;
      const px = Math.floor(acc);
      if (px >= 1) {
        acc -= px;
        writeScroll(readScroll() + px);
      }
    } else if (ts - lastDiscrete > 130) {
      lastDiscrete = ts;
      acc += Math.max(0.25, state.speed * 0.13);
      const px = Math.floor(acc);
      if (px >= 1) {
        acc -= px;
        writeScroll(readScroll() + px);
      }
    }

    renderProgress();
    if (atBottom()) {
      handleBottom();
      if (!state.running || countdownTimer) {
        rafId = null;
        return;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    pickScroller();
    measureDensity();
    lastTs = 0;
    acc = 0;
    pickTick = 0;
    nextAttempts = 0;
    hideToast();
    saveSession({ running: true });
    if (!rafId) rafId = requestAnimationFrame(tick);
    render();
  }

  function pause() {
    saveSession({ running: false });
    cancelCountdown();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    hideToast();
    render();
  }

  function toggle() {
    const now = Date.now();
    if (now - lastToggleTs < 250) return; // 避免快捷键与浏览器命令重复触发
    lastToggleTs = now;
    state.running ? pause() : start();
  }

  function setSpeed(value) {
    const speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(value)));
    savePrefs({ speed });
    render();
  }

  /* 快捷键微调：默认 20% 一步，按住 Shift 是 50% 一步 */
  function speedStep(big) {
    const ratio = big ? 0.5 : 0.2;
    return Math.max(1, Math.round(state.speed * ratio));
  }

  function scrollToTop() {
    writeScroll(0);
    renderProgress();
  }

  /* ------------------------------------------------------------ 下一章 */

  function findNextChapter() {
    const selectors = [
      '#j_chapterNext',
      'a.chapterNext',
      '.chapter-control .next',
      '.readpage .next',
      'a[rel="next"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.href) return el;
    }
    const links = document.querySelectorAll('a[href]');
    for (const a of links) {
      const text = (a.textContent || '').replace(/\s+/g, '');
      if (text === '下一章' || text === '下一页' || text === '下一頁' || text === '下章') {
        return a;
      }
    }
    return null;
  }

  function showToast(message, withCancel) {
    toastMsg.textContent = message;
    toast.querySelector('[data-act="cancelNext"]').classList.toggle('hidden', !withCancel);
    toast.classList.remove('hidden');
  }

  function hideToast() {
    toast.classList.add('hidden');
  }

  function cancelCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function handleBottom() {
    if (countdownTimer) return; // 已经在倒计时中
    if (!state.autoNext) {
      pause();
      showToast('本页已读到底部', false);
      setTimeout(hideToast, 2200);
      return;
    }
    const link = findNextChapter();
    if (!link) {
      pause();
      showToast('已到底部，未找到「下一章」链接', false);
      setTimeout(hideToast, 2600);
      return;
    }
    nextLink = link;
    let left = Math.max(1, Math.round(state.nextDelay));
    showToast(`${left} 秒后进入下一章…`, true);
    countdownTimer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        showToast(`${left} 秒后进入下一章…`, true);
        return;
      }
      cancelCountdown();
      hideToast();
      saveSession({ running: true }); // 新页面加载后继续
      nextLink.click();
      resumeAfterClick();
    }, 1000);
  }

  /* 有些阅读站是站内无刷新换章：点击后内容变了但页面没重载，这里接着滚 */
  function resumeAfterClick() {
    setTimeout(() => {
      if (!state.running) return;
      pickScroller();
      if (atBottom()) {
        nextAttempts += 1;
        if (nextAttempts >= 2) {
          pause();
          showToast('自动翻章没有生效，已停止滚动', false);
          setTimeout(hideToast, 2600);
          return;
        }
      }
      lastTs = 0;
      acc = 0;
      if (!rafId) rafId = requestAnimationFrame(tick);
    }, 1200);
  }

  /* --------------------------------------------------------------- 交互 */

  root.addEventListener('click', (event) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const el = event.target.closest('[data-act], [data-speed]');
    if (!el) return;
    if (el.dataset.speed) {
      setSpeed(Number(el.dataset.speed));
      return;
    }
    switch (el.dataset.act) {
      case 'toggle':
        toggle();
        break;
      case 'sheet':
        sheet.classList.toggle('hidden');
        break;
      case 'closeSheet':
        sheet.classList.add('hidden');
        break;
      case 'top':
        scrollToTop();
        break;
      case 'hide':
        savePrefs({ panelHidden: true });
        render();
        break;
      case 'cancelNext':
        cancelCountdown();
        hideToast();
        state.running = false;
        saveSession({ running: false });
        render();
        break;
      default:
        break;
    }
  });

  range.addEventListener('input', () => {
    setSpeed(Number(range.value));
  });

  for (const input of toggles) {
    input.addEventListener('change', () => {
      savePrefs({ [input.dataset.key]: input.checked });
      render();
    });
  }

  wrap.addEventListener('pointerenter', () => { hoveringPanel = true; });
  wrap.addEventListener('pointerleave', () => { hoveringPanel = false; });

  /* 拖动控制条：移动超过 5px 才算拖动，普通点击不受影响 */
  let drag = null;
  let suppressClick = false;

  pill.addEventListener('pointerdown', (event) => {
    const rect = host.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      top: rect.top,
      right: window.innerWidth - rect.right
    };
  });

  pill.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      wrap.classList.add('dragging');
      try { pill.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
    }
    const rect = host.getBoundingClientRect();
    const top = Math.min(Math.max(4, drag.top + dy), Math.max(4, window.innerHeight - rect.height - 4));
    const right = Math.min(Math.max(4, drag.right - dx), Math.max(4, window.innerWidth - rect.width - 4));
    host.style.top = top + 'px';
    host.style.marginTop = '0px';
    host.style.right = right + 'px';
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const moved = drag.moved;
    drag = null;
    wrap.classList.remove('dragging');
    if (!moved) return;
    suppressClick = true;
    savePrefs({
      panelPos: {
        top: parseFloat(host.style.top) || 0,
        right: parseFloat(host.style.right) || 0
      }
    });
  }

  pill.addEventListener('pointerup', endDrag);
  pill.addEventListener('pointercancel', endDrag);

  /* 手动滚动 / 按键时短暂暂停 */
  function noteManualScroll() {
    if (state.manualPause && state.running) manualPauseUntil = Date.now() + 1300;
  }
  window.addEventListener('wheel', noteManualScroll, { passive: true, capture: true });
  window.addEventListener('touchmove', noteManualScroll, { passive: true, capture: true });
  document.addEventListener('keydown', (event) => {
    if (event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); toggle(); return; }
      if (key === 't') { event.preventDefault(); scrollToTop(); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSpeed(state.speed + speedStep(event.shiftKey)); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); setSpeed(state.speed - speedStep(event.shiftKey)); return; }
    }
    if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(event.key)) {
      noteManualScroll();
    }
  }, true);

  window.addEventListener('resize', () => {
    if (state.panelPos) {
      const rect = host.getBoundingClientRect();
      host.style.top = Math.min(parseFloat(host.style.top) || 0, Math.max(4, window.innerHeight - rect.height - 4)) + 'px';
    }
  });

  /* ------------------------------------------------------------ 消息接口 */

  function snapshot() {
    let remainingSeconds = null;
    const cpm = Math.round(state.speed * 60 * density);
    if (state.running) {
      const max = maxScroll();
      const pos = Math.min(readScroll(), max);
      remainingSeconds = Math.round((max - pos) / Math.max(1, state.speed));
    }
    return { ...state, remainingSeconds, cpm, articleDetected };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'AR_CMD') return;
    const patch = msg.patch || {};
    switch (msg.cmd) {
      case 'get':
        if (!articleDetected && Date.now() - lastDetectTs > 8000) refreshArticleDetection();
        break;
      case 'toggle':
        toggle();
        break;
      case 'start':
        if (!state.running) start();
        break;
      case 'pause':
        if (state.running) pause();
        break;
      case 'speedUp':
        setSpeed(state.speed + (msg.step || 10));
        break;
      case 'speedDown':
        setSpeed(state.speed - (msg.step || 10));
        break;
      case 'scrollTop':
        scrollToTop();
        break;
      case 'set':
        {
          if (patch.speed != null) setSpeed(patch.speed);
          const rest = {};
          for (const [key, value] of Object.entries(patch)) {
            if (key === 'speed' || key === 'panelHidden' || key === 'panelPos') continue;
            if (key in DEFAULTS) rest[key] = value;
          }
          if (Object.keys(rest).length) {
            Object.assign(state, rest);
            savePrefs(rest);
            render();
          }
        }
        break;
      case 'showPanel':
        savePrefs({ panelHidden: false });
        render();
        break;
      case 'togglePanel':
        savePrefs({ panelHidden: !state.panelHidden });
        render();
        break;
      default:
        break;
    }
    sendResponse({ ok: true, state: snapshot() });
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (key in DEFAULTS) {
        state[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched) render();
  });

  /* --------------------------------------------------------------- 启动 */

  (async () => {
    await loadState();
    articleDetected = detectArticle();
    lastDetectTs = Date.now();
    detectAttempts = articleDetected ? 0 : 1;
    if (state.panelPos) {
      host.style.top = state.panelPos.top + 'px';
      host.style.marginTop = '0px';
      host.style.right = state.panelPos.right + 'px';
    }
    render();
    watchArticleDetection();
    scheduleArticleDetection(2000);

    // 内容脚本首次读取 session 可能早于后台设置访问级别，稍后补读一次
    if (!state.running && state.resumeOnLoad) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const session = await areaGet(chrome.storage.session, SESSION_DEFAULTS);
      if (session.running) state.running = true;
    }

    if (state.running && state.resumeOnLoad) {
      start();
    } else if (state.running) {
      state.running = false;
      saveSession({ running: false });
      render();
    }
  })();
})();
