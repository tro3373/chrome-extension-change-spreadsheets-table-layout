// Sheets Table Layout Formatter — MV3 service worker.
//
// Click the toolbar icon while the active cell sits inside a contiguous table.
// The extension drives Google Sheets via chrome.debugger keyboard events plus
// a few DOM hits for the color pickers, applying this fixed layout:
//
//   1. Select the contiguous table (Ctrl+A).
//   2. Read the resulting range from the Name Box and derive header / data /
//      column-strip sub-ranges.
//   3. With the whole table selected:
//        - All borders (Alt+Shift+7)
//        - Create a filter (menu search: "Create a filter")
//   4. With the header row selected (URL #range rewrite):
//        - Background gray (DOM click)
//        - Text color white (DOM click)
//        - Horizontal center (Ctrl+Shift+E)
//        - Rotate up (menu search: "Rotate up")
//   5. With the table columns selected:
//        - Resize column → Fit to data
//   6. With the data area selected:
//        - Wrap (menu search: "Wrap")

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const KEY_MAP = {
  Enter:      { code: 'Enter',      windowsVirtualKeyCode: 13,  key: 'Enter',     text: '\r' },
  Escape:     { code: 'Escape',     windowsVirtualKeyCode: 27,  key: 'Escape' },
  Tab:        { code: 'Tab',        windowsVirtualKeyCode: 9,   key: 'Tab',       text: '\t' },
  ArrowUp:    { code: 'ArrowUp',    windowsVirtualKeyCode: 38,  key: 'ArrowUp' },
  ArrowDown:  { code: 'ArrowDown',  windowsVirtualKeyCode: 40,  key: 'ArrowDown' },
  ArrowLeft:  { code: 'ArrowLeft',  windowsVirtualKeyCode: 37,  key: 'ArrowLeft' },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39,  key: 'ArrowRight' },
  Home:       { code: 'Home',       windowsVirtualKeyCode: 36,  key: 'Home' },
  End:        { code: 'End',        windowsVirtualKeyCode: 35,  key: 'End' },
  Backspace:  { code: 'Backspace',  windowsVirtualKeyCode: 8,   key: 'Backspace' },
  Space:      { code: 'Space',      windowsVirtualKeyCode: 32,  key: ' ',         text: ' ' },
  Slash:      { code: 'Slash',      windowsVirtualKeyCode: 191, key: '/',         text: '/' },
  F10:        { code: 'F10',        windowsVirtualKeyCode: 121, key: 'F10' },
  ContextMenu:{ code: 'ContextMenu', windowsVirtualKeyCode: 93, key: 'ContextMenu' },
};

function keyDescriptor(name) {
  if (KEY_MAP[name]) return { ...KEY_MAP[name] };
  if (name.length === 1) {
    const upper = name.toUpperCase();
    if (/[A-Z]/.test(upper)) {
      return {
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        key: name.toLowerCase(),
        text: name.toLowerCase(),
      };
    }
    if (/[0-9]/.test(upper)) {
      return {
        code: `Digit${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        key: name,
        text: name,
      };
    }
    if (name === '/') return { ...KEY_MAP.Slash };
  }
  throw new Error(`Unknown key: ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendCmd(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function pressKey(target, keyName, mods = [], opts = {}) {
  const modifiers = mods.reduce((acc, m) => acc | MODIFIERS[m.toLowerCase()], 0);
  const desc = keyDescriptor(keyName);
  // When a non-shift modifier is engaged we don't insert printable text.
  const wantsText = desc.text != null && (modifiers === 0 || modifiers === MODIFIERS.shift);
  const text = wantsText ? desc.text : undefined;
  await sendCmd(target, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
    nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
    modifiers,
    text,
    unmodifiedText: text,
  });
  await sendCmd(target, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
    nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
    modifiers,
  });
  await sleep(opts.after ?? 90);
}

// Focus the hidden iframe that Sheets uses to receive keyboard input. Without
// this, keys dispatched via CDP can land on the wrong element and shortcuts
// like Alt+/ silently fail.
async function focusSheetsInput(tabId) {
  return execInPage(tabId, () => {
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (!iframe) return false;
    try {
      iframe.focus();
      const doc = iframe.contentDocument;
      if (doc && doc.body) doc.body.focus();
    } catch (_) {
      return false;
    }
    return true;
  });
}

// Move focus to the Sheets input iframe and pause briefly. Replaces the prior
// Escape-based reset that was knocking focus out of the grid entirely.
async function calmDown(target, tabId) {
  await focusSheetsInput(tabId);
  await sleep(120);
}

async function typeText(target, text, opts = {}) {
  await sendCmd(target, 'Input.insertText', { text });
  await sleep(opts.after ?? 120);
}

// Open Sheets menu search (Alt+/) and execute a command by typing its name.
async function runMenuCommand(target, tabId, query, opts = {}) {
  await calmDown(target, tabId);
  await pressKey(target, '/', ['alt'], { after: 500 });
  // Verify the menu search popup actually opened — otherwise typed text would
  // leak into the focused cell editor or formula bar.
  const opened = await execInPage(tabId, () => {
    const candidateAttrs = ['aria-label', 'placeholder'];
    const candidateValues = [
      'Search the menus',
      'メニューを検索',
      'Search the menu',
      'メニュー検索',
    ];
    const all = [];
    const walk = (root) => {
      const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of nodes) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === 'IFRAME') {
          try {
            const idoc = el.contentDocument;
            if (idoc) walk(idoc);
          } catch (_) {}
        }
      }
    };
    walk(document);
    return all.some((el) => {
      if (!el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      for (const a of candidateAttrs) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && candidateValues.some((cv) => v.includes(cv))) return true;
      }
      return false;
    });
  });
  if (!opened) {
    console.warn(`[FormatTable] menu search did not open for "${query}"; skipping.`);
    return false;
  }
  await typeText(target, query, { after: 500 });
  await pressKey(target, 'Enter', [], { after: opts.after ?? 600 });
  return true;
}

async function execInPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  });
  return res?.result;
}

async function readNameBox(tabId) {
  return execInPage(tabId, () => {
    const el = document.getElementById('t-name-box');
    return el ? el.value : null;
  });
}

async function waitForNameBox(tabId, predicate, { timeoutMs = 3000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await readNameBox(tabId);
    if (v && predicate(v)) return v;
    await sleep(intervalMs);
  }
  return readNameBox(tabId);
}

async function setSelectionViaHash(tabId, range) {
  await execInPage(
    tabId,
    (rng) => {
      const hash = window.location.hash.replace(/^#/, '');
      const params = new URLSearchParams(hash);
      params.set('range', rng);
      window.location.hash = '#' + params.toString();
    },
    [range],
  );
}

const A = 'A'.charCodeAt(0);

function colToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - A + 1);
  return n - 1; // 0-based
}

function indexToCol(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(A + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseRange(range) {
  // Accept "A1:E20", "A1", or "A:E"/"1:20" style — we expect the rectangular form
  // produced by Sheets Ctrl+A.
  const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (m) {
    return {
      startCol: m[1],
      startRow: parseInt(m[2], 10),
      endCol: m[3],
      endRow: parseInt(m[4], 10),
    };
  }
  const single = range.match(/^([A-Z]+)(\d+)$/);
  if (single) {
    return {
      startCol: single[1],
      startRow: parseInt(single[2], 10),
      endCol: single[1],
      endRow: parseInt(single[2], 10),
    };
  }
  return null;
}

function deriveRanges(tableRange) {
  const p = parseRange(tableRange);
  if (!p) throw new Error(`Unexpected table range: ${tableRange}`);
  const { startCol, startRow, endCol, endRow } = p;
  return {
    startCol,
    startRow,
    endCol,
    endRow,
    table: `${startCol}${startRow}:${endCol}${endRow}`,
    header: `${startCol}${startRow}:${endCol}${startRow}`,
    data: startRow < endRow ? `${startCol}${startRow + 1}:${endCol}${endRow}` : null,
    columns: `${startCol}:${endCol}`,
  };
}

// Locate a visible element by aria-label / data-tooltip / title and return the
// center coordinates. Sheets sometimes embeds shortcut hints in aria-label
// ("塗りつぶしの色 (Alt+H, H)") so substring matching is essential.
async function findElementCenter(tabId, labels, { exact = true } = {}) {
  return execInPage(
    tabId,
    (lblList, isExact) => {
      const attrs = ['aria-label', 'data-tooltip', 'data-tooltip-text', 'title'];
      const labelOf = (el) => {
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (v) return v;
        }
        return null;
      };
      const matches = (el, lbl) => {
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (!v) continue;
          if (isExact ? v === lbl : v.includes(lbl)) return true;
        }
        return false;
      };
      // Walk every element, piercing shadow roots and same-origin iframes.
      const all = [];
      const walk = (root) => {
        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of nodes) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.tagName === 'IFRAME') {
            try {
              const idoc = el.contentDocument;
              if (idoc) walk(idoc);
            } catch (_) {}
          }
        }
      };
      walk(document);
      for (const lbl of lblList) {
        const visible = all.filter((el) => {
          if (!matches(el, lbl)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (visible.length === 0) continue;
        const r = visible[0].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: labelOf(visible[0]) };
      }
      return null;
    },
    [labels, exact],
  );
}

// For debugging: list visible labels that match any of the given keywords,
// including those reachable through shadow roots and same-origin iframes.
async function dumpVisibleLabels(tabId, keywords) {
  return execInPage(
    tabId,
    (kw) => {
      const attrs = ['aria-label', 'data-tooltip', 'data-tooltip-text', 'title'];
      const all = [];
      const walk = (root) => {
        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of nodes) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.tagName === 'IFRAME') {
            try {
              const idoc = el.contentDocument;
              if (idoc) walk(idoc);
            } catch (_) {}
          }
        }
      };
      walk(document);
      const out = new Set();
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (!v) continue;
          if (kw.some((k) => v.includes(k))) out.add(`[${a}] ${v}`);
        }
      }
      return Array.from(out).slice(0, 80);
    },
    [keywords],
  );
}

// One-shot debug dump at the start of a run to characterize the Sheets DOM.
async function dumpToolbarOverview(tabId) {
  return execInPage(tabId, () => {
    const attrs = ['aria-label', 'data-tooltip', 'data-tooltip-text', 'title'];
    let totalElements = 0;
    let withAccessibleName = 0;
    const sampleLabels = [];
    const walk = (root) => {
      const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of nodes) {
        totalElements++;
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (!v) continue;
          withAccessibleName++;
          if (sampleLabels.length < 20) sampleLabels.push(`[${a}] ${v.slice(0, 80)}`);
          break;
        }
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === 'IFRAME') {
          try {
            const idoc = el.contentDocument;
            if (idoc) walk(idoc);
          } catch (_) {}
        }
      }
    };
    walk(document);
    return {
      totalElements,
      withAccessibleName,
      hasInputIframe: !!document.querySelector('iframe.docs-texteventtarget-iframe'),
      hasShadowRoots: Array.from(document.querySelectorAll('*')).some((el) => el.shadowRoot),
      sampleLabels,
    };
  });
}

// Real CDP mouse click. Sheets toolbar buttons listen on mousedown, so
// element.click() alone is not enough — we issue press/release at the element
// center.
async function mouseClickAt(target, x, y) {
  await sendCmd(target, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
  });
  await sendCmd(target, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await sendCmd(target, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

async function clickFirstLabel(target, tabId, labels, opts = {}) {
  const exact = opts.exact ?? true;
  let hit = await findElementCenter(tabId, labels, { exact });
  if (!hit && exact && opts.allowSubstring !== false) {
    hit = await findElementCenter(tabId, labels, { exact: false });
  }
  if (!hit) return null;
  await mouseClickAt(target, hit.x, hit.y);
  return hit.label;
}

const PICKER_LABELS = {
  fill: ['Fill color', '塗りつぶしの色', '背景色', 'セルの塗りつぶしの色', 'セルの背景色'],
  text: ['Text color', 'テキストの色', '文字色', '文字の色'],
};

const PICKER_KEYWORDS = {
  fill: ['塗りつぶし', '背景', 'Fill', 'fill'],
  text: ['テキストの色', '文字色', '文字の色', 'Text color'],
};

const SWATCH_LABELS = {
  gray: [
    // Japanese UI — confirmed labels.
    '暗いグレー 4',
    '暗いグレー 3',
    'グレー',
    // English fallbacks.
    'dark gray 4',
    'Dark gray 4',
  ],
  white: ['白', 'white', 'White'],
};

async function applyPickerColor(target, tabId, pickerLabels, swatchLabels, debugKeywords) {
  const opened = await clickFirstLabel(target, tabId, pickerLabels);
  if (!opened) {
    console.warn(`[FormatTable] picker button not found: ${pickerLabels.join(' | ')}`);
    if (debugKeywords) {
      const dump = await dumpVisibleLabels(tabId, debugKeywords);
      console.warn('[FormatTable] visible candidate labels:', dump);
    }
    return;
  }
  console.log(`[FormatTable] opened picker via "${opened}"`);
  await sleep(500);
  const swatchHit = await clickFirstLabel(target, tabId, swatchLabels);
  if (!swatchHit) {
    console.warn(`[FormatTable] swatch not found: ${swatchLabels.join(' | ')}; closing picker.`);
    const dump = await dumpVisibleLabels(tabId, ['グレー', '灰', 'gray', 'grey', '白', 'white', '#']);
    console.warn('[FormatTable] visible swatch-ish labels:', dump);
    await calmDown(target, tabId);
    return;
  }
  console.log(`[FormatTable] picked swatch "${swatchHit}"`);
  await sleep(350);
}

async function applyHeaderColors(target, tabId) {
  await applyPickerColor(target, tabId, PICKER_LABELS.fill, SWATCH_LABELS.gray, PICKER_KEYWORDS.fill);
  await applyPickerColor(target, tabId, PICKER_LABELS.text, SWATCH_LABELS.white, PICKER_KEYWORDS.text);
}

// Try each query against the menu search; succeed as soon as one fires.
async function runMenuCommandAny(target, tabId, queries, opts = {}) {
  for (const q of queries) {
    if (await runMenuCommand(target, tabId, q, opts)) return true;
  }
  return false;
}

// Find the "Resize column/row" item that Sheets shows in a context menu.
async function findContextMenuResizeItem(tabId, kind) {
  const resizeKeywords =
    kind === 'column'
      ? ['のサイズを変更', 'Resize column']
      : ['のサイズを変更', 'Resize row'];
  return execInPage(
    tabId,
    (kws) => {
      const all = [];
      const walk = (root) => {
        const ns = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of ns) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width > 500 || r.height > 60) continue;
        const txt = (el.textContent || '').trim();
        const al = (el.getAttribute && el.getAttribute('aria-label')) || '';
        for (const kw of kws) {
          if (txt.includes(kw) || al.includes(kw)) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: txt || al };
          }
        }
      }
      return null;
    },
    [resizeKeywords],
  );
}

// Auto-fit a column or row dimension. Sheets only exposes "Resize column/row"
// in the right-click context menu (not the main menus), and the grid headers
// are canvas-rendered so we can't locate them via DOM. Instead we send
// Shift+F10 (and Context-Menu key as fallback), which Sheets routes to the
// current selection's context menu, then click "…のサイズを変更" → choose
// "データに合わせる" → OK.
async function autoFitSelected(target, tabId, kind) {
  await calmDown(target, tabId);
  const tryOpen = async (keyName, mods) => {
    await pressKey(target, keyName, mods, { after: 800 });
    return findContextMenuResizeItem(tabId, kind);
  };
  let item = await tryOpen('F10', ['shift']);
  if (!item) item = await tryOpen('ContextMenu', []);
  if (!item) {
    console.warn(`[FormatTable] could not open context menu with resize item for ${kind}.`);
    const dump = await dumpVisibleLabels(tabId, ['サイズ', 'Resize', '行', '列', 'のサイズ']);
    console.warn(`[FormatTable] visible labels after context-menu attempt (${kind}):`, dump);
    await pressKey(target, 'Escape', [], { after: 200 });
    return;
  }
  console.log(`[FormatTable] context menu → "${item.label}"`);
  await mouseClickAt(target, item.x, item.y);
  await sleep(700);

  const radioLabel = await waitForLabel(tabId, ['データに合わせる', 'Fit to data'], {
    timeoutMs: 3000,
  });
  if (!radioLabel) {
    console.warn(`[FormatTable] resize ${kind} dialog did not show "Fit to data" radio.`);
    await pressKey(target, 'Escape', [], { after: 300 });
    return;
  }
  await clickFirstLabel(target, tabId, [radioLabel]);
  await sleep(250);
  const ok = await clickFirstLabel(target, tabId, ['OK', 'Ok']);
  if (!ok) await pressKey(target, 'Enter', [], { after: 600 });
  await sleep(500);
}

async function waitForLabel(tabId, labels, { timeoutMs = 3000, intervalMs = 150 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = await findElementCenter(tabId, labels, { exact: true });
    if (hit) return hit.label;
    await sleep(intervalMs);
  }
  return null;
}

async function run(tabId) {
  const target = { tabId };
  console.log('[FormatTable] attaching debugger…');
  await chrome.debugger.attach(target, '1.3');
  try {
    // // 1. Select the contiguous table around the active cell.
    // await pressKey(target, 'a', ['ctrl'], { after: 350 });

    // 2. Read the resulting range.
    const selection = await waitForNameBox(tabId, (v) => /^[A-Z]+\d+:[A-Z]+\d+$/.test(v));
    if (!selection || !/^[A-Z]+\d+:[A-Z]+\d+$/.test(selection)) {
      throw new Error(
        `Could not detect a rectangular table after Ctrl+A. Name Box reads "${selection}". ` +
          'Place the active cell inside a contiguous data block and retry.',
      );
    }
    const ranges = deriveRanges(selection);
    console.log('[FormatTable] table range:', ranges);

    const overview = await dumpToolbarOverview(tabId);
    console.log('[FormatTable] DOM overview:', overview);
    const colorLabels = await dumpVisibleLabels(tabId, ['色', 'color', 'Color', '塗', '背景', 'Fill', 'fill', 'Text']);
    console.log('[FormatTable] color-ish labels:', colorLabels);

    // 3. Whole-table phase — keep the user's Ctrl+A selection.
    await calmDown(target, tabId);
    //   3a. All borders.
    await pressKey(target, '7', ['alt', 'shift'], { after: 500 });
    //   3b. Create a filter.
    await runMenuCommandAny(
      target,
      tabId,
      ['フィルタを作成', 'Create a filter'],
      { after: 800 },
    );

    // 4. Column-strip phase — auto-fit column widths via Shift+F10 context
    //    menu (Sheets exposes "Resize column" only there).
    await setSelectionViaHash(tabId, ranges.columns);
    await sleep(600);
    await autoFitSelected(target, tabId, 'column');

    // 5. Data phase — wrap + left + top align (header gets neither wrap nor
    //    these alignments).
    if (ranges.data) {
      await setSelectionViaHash(tabId, ranges.data);
      await sleep(600);
      await calmDown(target, tabId);
      //   5a. Wrap text.
      await runMenuCommandAny(
        target,
        tabId,
        ['折り返し', 'Wrap'],
        { after: 700 },
      );
      //   5b. Horizontal left.
      await pressKey(target, 'l', ['ctrl', 'shift'], { after: 400 });
      //   5c. Vertical top.
      await runMenuCommandAny(
        target,
        tabId,
        ['上揃え', '上端揃え', 'Top'],
        { after: 700 },
      );
    }

    // 6. Header phase.
    await setSelectionViaHash(tabId, ranges.header);
    await sleep(600);
    await calmDown(target, tabId);
    //   6a/b. Background / text colors.
    await applyHeaderColors(target, tabId);
    //   6c. Horizontal center.
    await calmDown(target, tabId);
    await pressKey(target, 'e', ['ctrl', 'shift'], { after: 400 });
    //   6d. Rotate up.
    await runMenuCommandAny(
      target,
      tabId,
      ['上向きに回転', 'Rotate up'],
      { after: 700 },
    );
    //   6e. Auto-fit header row height so the rotated text isn't squished.
    await autoFitSelected(target, tabId, 'row');

    console.log('[FormatTable] done.');
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (e) {
      // Already detached or tab closed.
    }
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.includes('docs.google.com/spreadsheets')) {
    console.warn('[FormatTable] Not a Google Sheets tab.');
    return;
  }
  try {
    await run(tab.id);
  } catch (err) {
    console.error('[FormatTable] failed:', err);
    // Surface a notification through chrome.action's badge.
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d93025' });
      setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 4000);
    } catch (_) {}
  }
});
