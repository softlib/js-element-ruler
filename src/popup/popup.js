/**
 * 元素尺 · 弹出面板
 * 负责读写设置（chrome.storage.sync）并驱动当前页面的内容脚本。
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  minWidth: 100,
  minHeight: 100,
  tags: ['div', 'span', 'p', 'table', 'ul', 'ol', 'article', 'section'],
};

const TAG_POOL = [
  'div', 'span', 'p', 'a', 'img',
  'table', 'ul', 'ol', 'li',
  'article', 'section', 'main', 'aside',
  'header', 'footer', 'nav', 'form',
];

const ui = {
  enabled: document.getElementById('enabled'),
  minWidth: document.getElementById('minWidth'),
  minHeight: document.getElementById('minHeight'),
  tags: document.getElementById('tags'),
  pinCount: document.getElementById('pinCount'),
  clearPins: document.getElementById('clearPins'),
  pageStatus: document.getElementById('pageStatus'),
};

let settings = { ...DEFAULTS };
let tabId = null;
let saveTimer = 0;

init();

async function init() {
  settings = await loadSettings();
  fillForm();
  bindEvents();
  await refreshStatus();
}

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set(settings).catch(() => {});
  }, 120);
}

/* ------------------------------------------------------------------ */
/* 表单渲染                                                            */
/* ------------------------------------------------------------------ */

function fillForm() {
  ui.enabled.checked = settings.enabled;
  ui.minWidth.value = settings.minWidth;
  ui.minHeight.value = settings.minHeight;
  renderTags();
}

function renderTags() {
  const frag = document.createDocumentFragment();

  for (const tag of TAG_POOL) {
    const chip = document.createElement('label');
    chip.className = 'chip';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = tag;
    input.checked = settings.tags.includes(tag);
    input.addEventListener('change', onTagToggle);

    const text = document.createElement('span');
    text.textContent = tag;

    chip.append(input, text);
    frag.append(chip);
  }

  ui.tags.replaceChildren(frag);
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

function bindEvents() {
  ui.enabled.addEventListener('change', () => {
    settings.enabled = ui.enabled.checked;
    save();
    updateStatusText();
  });

  for (const key of ['minWidth', 'minHeight']) {
    const input = key === 'minWidth' ? ui.minWidth : ui.minHeight;

    input.addEventListener('input', () => {
      const value = Number.parseInt(input.value, 10);
      if (!Number.isFinite(value) || value < 0) return;
      settings[key] = Math.min(value, 10000);
      save();
    });

    input.addEventListener('blur', () => {
      input.value = settings[key];
    });
  }

  ui.clearPins.addEventListener('click', async () => {
    if (tabId == null) return;
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'er:clear-pins' });
      setPinCount(0);
    } catch {
      /* 页面不可用，忽略 */
    }
  });
}

function onTagToggle(event) {
  const input = event.target;
  const checked = [...ui.tags.querySelectorAll('input:checked')].map((item) => item.value);

  // 至少保留一个检测元素，避免整个工具失效
  if (!checked.length) {
    input.checked = true;
    return;
  }

  settings.tags = checked;
  save();
}

/* ------------------------------------------------------------------ */
/* 当前页面状态                                                        */
/* ------------------------------------------------------------------ */

async function refreshStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? null;
  } catch {
    tabId = null;
  }

  if (tabId == null) {
    setPinCount(0);
    setStatus('无法获取当前标签页', 'warn');
    ui.clearPins.disabled = true;
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'er:status' });
    setPinCount(res?.pinned ?? 0);
    updateStatusText(res?.enabled);
  } catch {
    setPinCount(0);
    ui.clearPins.disabled = true;
    setStatus('当前页面不可用（浏览器内置页，或安装后未刷新）', 'warn');
  }
}

function updateStatusText(remoteEnabled) {
  if (ui.clearPins.disabled) return;
  const on = remoteEnabled ?? settings.enabled;
  setStatus(on ? '已在当前页面生效，移动鼠标试试' : '已在当前页面关闭');
}

function setPinCount(count) {
  ui.pinCount.textContent = String(count);
}

function setStatus(text, tone = '') {
  ui.pageStatus.textContent = text;
  if (tone) ui.pageStatus.dataset.tone = tone;
  else delete ui.pageStatus.dataset.tone;
}
