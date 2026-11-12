/**
 * 元素尺 · Element Ruler — 内容脚本
 * ---------------------------------------------------------------------------
 * 核心能力（由原「悬停检测右键钉住红框」单页 demo 提炼）：
 *   1. 悬停元素 → 实时测量宽高；宽高同时超过阈值时显示红色外框
 *   2. 右键 → 钉住 / 解除钉住；钉住后左上角持续显示实时尺寸
 *   3. 支持钉住多个元素：单个 × 解除 / 弹出面板一键全部清除
 *
 * 实现要点：
 *   · 外框、尺寸标签、提示气泡全部渲染在 Shadow DOM 覆盖层里，
 *     不向页面元素加 class、不改页面样式，页面布局不会被干扰
 *   · 命中检测用 elementFromPoint，与画出来的框严格一致（不会被父子嵌套带偏）
 *   · 只有在「鼠标移动 / 滚动 / 缩放 / 被钉元素尺寸变化」时重绘，不做常驻轮询
 */
(() => {
  'use strict';

  // 防止扩展重载后被重复注入
  if (window.__elementRulerLoaded) return;
  window.__elementRulerLoaded = true;

  const HOST_ID = 'element-ruler-overlay';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    minWidth: 100,
    minHeight: 100,
    tags: ['div', 'span', 'p', 'table', 'ul', 'ol', 'article', 'section'],
  });

  /* ======================================================================= */
  /* 状态                                                                    */
  /* ======================================================================= */

  let settings = { ...DEFAULT_SETTINGS };

  /** Element -> { el, box, label, dimsEl, dims } */
  const pins = new Map();

  let host = null;
  let layer = null;
  let hoverBox = null;
  let hoverLabel = null;
  let hoverTagEl = null;
  let hoverDimsEl = null;
  let toastEl = null;
  let toastTimer = 0;

  let hoverEl = null;      // 当前悬停命中的可测元素
  let cursor = null;       // { x, y } 上一次指针位置
  let hitTestDirty = false;
  let rafId = 0;
  let resizeObserver = null;

  /* ======================================================================= */
  /* 覆盖层样式（Shadow DOM 内，天然与页面隔离）                              */
  /* ======================================================================= */

  const STYLE = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; }
    :host([data-off]) .layer { display: none; }

    .box {
      position: fixed;
      pointer-events: none;
      box-sizing: border-box;
      outline-offset: 1px;
    }
    .box--hover { outline: 2px solid #ef4444; }
    .box--pin {
      outline: 2px solid #ef4444;
      box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.12);
    }

    .label {
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 19px;
      padding: 0 7px;
      border-radius: 4px;
      background: rgba(17, 24, 39, 0.9);
      color: #e2e8f0;
      font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.2px;
      white-space: nowrap;
      pointer-events: none;
      transform: translateY(-100%);
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.28);
    }
    .label--inside { transform: none; }
    .label--pin { pointer-events: none; }

    .tag { color: #93a4bb; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .dims { color: #fbbf24; font-weight: 700; }
    .dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: #ef4444; flex: none;
    }

    .close {
      pointer-events: auto;
      cursor: pointer;
      flex: none;
      width: 13px; height: 13px;
      margin-left: 1px;
      padding: 0;
      border: 0;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.16);
      color: #fff;
      font: 700 10px/13px system-ui, sans-serif;
      text-align: center;
      transition: background 0.12s ease;
    }
    .close:hover { background: #ef4444; }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 26px;
      max-width: 70vw;
      padding: 7px 15px;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.92);
      color: #f8fafc;
      font: 500 12px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 8px 26px rgba(15, 23, 42, 0.3);
      transform: translate(-50%, 8px);
      opacity: 0;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .toast[data-tone="pin"] { box-shadow: 0 8px 26px rgba(239, 68, 68, 0.35); }
  `;

  /* ======================================================================= */
  /* 启动                                                                    */
  /* ======================================================================= */

  boot();

  async function boot() {
    settings = normalizeSettings(await readSettings());
    mountOverlay();
    resizeObserver = new ResizeObserver(requestRender);
    bindEvents();
    applySettings();

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  /* ======================================================================= */
  /* 设置                                                                    */
  /* ======================================================================= */

  async function readSettings() {
    try {
      return await chrome.storage.sync.get(DEFAULT_SETTINGS);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function normalizeSettings(raw = {}) {
    const num = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
    };

    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((tag) => typeof tag === 'string' && tag.trim())
          .map((tag) => tag.trim().toLowerCase())
      : DEFAULT_SETTINGS.tags;

    return {
      enabled: raw.enabled !== false,
      minWidth: num(raw.minWidth, DEFAULT_SETTINGS.minWidth),
      minHeight: num(raw.minHeight, DEFAULT_SETTINGS.minHeight),
      tags: tags.length ? [...new Set(tags)] : [...DEFAULT_SETTINGS.tags],
    };
  }

  function applySettings() {
    if (!host) return;
    host.toggleAttribute('data-off', !settings.enabled);
    hitTestDirty = true;
    requestRender();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    const next = { ...settings };
    for (const [key, { newValue }] of Object.entries(changes)) next[key] = newValue;
    settings = normalizeSettings(next);
    applySettings();
  }

  function onMessage(message, _sender, sendResponse) {
    switch (message && message.type) {
      case 'er:status':
        sendResponse({ enabled: settings.enabled, pinned: pins.size });
        break;
      case 'er:clear-pins':
        clearAllPins();
        sendResponse({ enabled: settings.enabled, pinned: pins.size });
        break;
      default:
        break;
    }
  }

  /* ======================================================================= */
  /* 覆盖层搭建                                                              */
  /* ======================================================================= */

  function mountOverlay() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');

    // 用 !important 内联，防止页面通配样式把覆盖层挤偏
    const hostStyle = {
      all: 'initial',
      position: 'fixed',
      top: '0px',
      left: '0px',
      width: '0px',
      height: '0px',
      margin: '0px',
      padding: '0px',
      border: '0px',
      display: 'block',
      'pointer-events': 'none',
      'z-index': '2147483647',
      contain: 'layout style',
    };
    for (const [prop, value] of Object.entries(hostStyle)) {
      host.style.setProperty(prop, value, 'important');
    }

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    layer = document.createElement('div');
    layer.className = 'layer';

    hoverBox = document.createElement('div');
    hoverBox.className = 'box box--hover';
    hoverBox.hidden = true;

    hoverLabel = document.createElement('div');
    hoverLabel.className = 'label';
    hoverTagEl = document.createElement('span');
    hoverTagEl.className = 'tag';
    hoverDimsEl = document.createElement('span');
    hoverDimsEl.className = 'dims';
    hoverLabel.append(hoverTagEl, hoverDimsEl);
    hoverLabel.hidden = true;

    toastEl = document.createElement('div');
    toastEl.className = 'toast';

    layer.append(hoverBox, hoverLabel, toastEl);
    shadow.append(style, layer);
    (document.documentElement || document.body).appendChild(host);
  }

  /* ======================================================================= */
  /* 事件                                                                    */
  /* ======================================================================= */

  function bindEvents() {
    window.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    window.addEventListener('contextmenu', onContextMenu, { capture: true });
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
    document.addEventListener('mouseout', onMouseOut, { capture: true, passive: true });

    // 覆盖层内的交互（关闭按钮）不冒泡到页面
    layer.addEventListener('mousedown', stopEvent);
    layer.addEventListener('mouseup', stopEvent);
    layer.addEventListener('click', stopEvent);
    layer.addEventListener('contextmenu', (event) => {
      stopEvent(event);
      event.preventDefault();
    });
  }

  function stopEvent(event) {
    event.stopPropagation();
  }

  function onMouseMove(event) {
    if (!settings.enabled) return;
    if (isOwnNode(event)) return;

    cursor = { x: event.clientX, y: event.clientY };
    hitTestDirty = true;
    requestRender();
  }

  function onMouseOut(event) {
    if (event.relatedTarget) return; // 只是移动到别的元素上，交给命中检测
    cursor = null;
    hoverEl = null;
    hideHover();
  }

  function onViewportChange() {
    hitTestDirty = true;
    requestRender();
  }

  function onContextMenu(event) {
    if (!settings.enabled) return;
    if (isOwnNode(event)) return;

    // 用坐标命中，保证「右键的元素」就是「红框框住的元素」
    const el = resolveTarget(event.clientX, event.clientY);
    if (!el) return; // 非检测元素：保留浏览器原生右键菜单

    event.preventDefault();
    event.stopPropagation();

    if (pins.has(el)) {
      unpin(el);
      hitTestDirty = true;
      requestRender();
      return;
    }

    const rect = el.getBoundingClientRect();
    if (!isSizeValid(rect)) {
      showToast(`${describe(el)} ${formatSize(rect)} 未超过阈值，无法钉住`, 'off');
      return;
    }

    pin(el);
  }

  function isOwnNode(event) {
    return !!host && event.composedPath && event.composedPath().includes(host);
  }

  /* ======================================================================= */
  /* 渲染                                                                    */
  /* ======================================================================= */

  function requestRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  function render() {
    if (!host) return;
    if (!settings.enabled) {
      hideHover();
      return;
    }

    if (hitTestDirty) {
      hitTestDirty = false;
      hoverEl = cursor ? resolveTarget(cursor.x, cursor.y) : null;
    }

    renderHover();
    renderPins();
  }

  function renderHover() {
    const el = hoverEl;
    // 已钉住的元素由钉住框负责，不再重复画临时框
    if (!el || !el.isConnected || pins.has(el)) {
      hideHover();
      return;
    }

    const rect = el.getBoundingClientRect();
    if (!isSizeValid(rect) || !isInViewport(rect)) {
      hideHover();
      return;
    }

    placeBox(hoverBox, rect);
    hoverBox.hidden = false;

    hoverTagEl.textContent = describe(el);
    hoverDimsEl.textContent = formatSize(rect);
    placeLabel(hoverLabel, rect);
    hoverLabel.hidden = false;
  }

  function hideHover() {
    if (hoverBox) hoverBox.hidden = true;
    if (hoverLabel) hoverLabel.hidden = true;
  }

  function renderPins() {
    if (!pins.size) return;

    for (const rec of [...pins.values()]) {
      if (!rec.el.isConnected) {
        unpin(rec.el, { silent: true });
        continue;
      }

      const rect = rec.el.getBoundingClientRect();
      placeBox(rec.box, rect);
      placeLabel(rec.label, rect);

      const dims = formatSize(rect);
      if (dims !== rec.dims) {
        rec.dims = dims;
        rec.dimsEl.textContent = dims;
      }
    }
  }

  function placeBox(box, rect) {
    box.style.left = `${Math.round(rect.left)}px`;
    box.style.top = `${Math.round(rect.top)}px`;
    box.style.width = `${Math.round(rect.width)}px`;
    box.style.height = `${Math.round(rect.height)}px`;
  }

  function placeLabel(label, rect) {
    const above = rect.top >= 22;
    label.classList.toggle('label--inside', !above);
    label.style.top = `${Math.round(above ? rect.top - 6 : rect.top + 2)}px`;
    label.style.left = `${Math.round(Math.max(2, rect.left))}px`;
  }

  /* ======================================================================= */
  /* 钉住 / 解除                                                             */
  /* ======================================================================= */

  function pin(el) {
    if (pins.has(el)) return;

    const box = document.createElement('div');
    box.className = 'box box--pin';

    const label = document.createElement('div');
    label.className = 'label label--pin';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.textContent = describe(el);

    const dimsEl = document.createElement('span');
    dimsEl.className = 'dims';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.title = '解除钉住';
    close.textContent = '×';
    close.addEventListener('click', () => unpin(el));

    label.append(dot, tagEl, dimsEl, close);
    layer.append(box, label);

    const rect = el.getBoundingClientRect();
    const dims = formatSize(rect);
    dimsEl.textContent = dims;
    placeBox(box, rect);
    placeLabel(label, rect);

    pins.set(el, { el, box, label, dimsEl, dims });
    resizeObserver?.observe(el);

    if (hoverEl === el) {
      hoverEl = null;
      hideHover();
    }
    showToast(`已钉住 ${describe(el)} · ${dims}`, 'pin');
  }

  function unpin(el, { silent = false } = {}) {
    const rec = pins.get(el);
    if (!rec) return;

    pins.delete(el);
    resizeObserver?.unobserve(el);
    rec.box.remove();
    rec.label.remove();

    if (!silent) showToast(`已解除钉住 ${describe(el)}`, 'off');
  }

  function clearAllPins() {
    if (!pins.size) {
      showToast('当前没有钉住的红框', 'off');
      return;
    }
    const total = pins.size;
    for (const el of [...pins.keys()]) unpin(el, { silent: true });
    showToast(`已清除 ${total} 个钉住的红框`, 'off');
  }

  /* ======================================================================= */
  /* 命中检测与测量                                                          */
  /* ======================================================================= */

  function resolveTarget(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    if (hit === host || host.contains(hit)) return null;

    let node = hit;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (isMeasurable(node)) return node;
      if (node === document.body || node === document.documentElement) break;
      node = node.parentElement;
    }
    return null;
  }

  function isMeasurable(el) {
    if (!el || !el.tagName) return false;
    if (el === host || el === document.body || el === document.documentElement) return false;
    return settings.tags.includes(el.tagName.toLowerCase());
  }

  function isSizeValid(rect) {
    return rect.width > settings.minWidth && rect.height > settings.minHeight;
  }

  function isInViewport(rect) {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function formatSize(rect) {
    return `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    return el.id ? `${tag}#${el.id.slice(0, 16)}` : tag;
  }

  /* ======================================================================= */
  /* 轻提示                                                                  */
  /* ======================================================================= */

  function showToast(text, tone = 'info') {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.dataset.tone = tone;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }
})();
