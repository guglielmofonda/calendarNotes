/*
 * Call Notes — content script for calendar.google.com.
 *
 * Two jobs:
 *   1. When an event bubble opens, append a "Call Notes" panel: category
 *      stamps + a running notes log keyed to the event series.
 *   2. Stamp a small category dot on every calendar chip that has a tag
 *      or notes, replacing hand-made "side events".
 *
 * Google Calendar's DOM is obfuscated but a few hooks have been stable for
 * years: `data-eventid` on chips, the `#xDetDlg` detail bubble (which
 * carries the same data-eventid), and the `#rAECCd` title node. Everything
 * here is written against those hooks with fallbacks, and fails quietly.
 */
(function () {
  'use strict';

  if (window.__cnBooted) return;
  window.__cnBooted = true;

  var S = window.CNStore;
  if (!S) return;

  var TAG = '[CallNotes]';
  var VERSION = 'dev';
  try {
    VERSION = chrome.runtime.getManifest().version;
  } catch (e) {}
  // Script generation. When the extension updates, the background worker
  // injects a fresh script into open tabs; the newcomer stamps its
  // generation on <html> and this instance retires when it sees a stamp
  // that isn't its own.
  var GEN = 'g' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var dead = false;
  var state = null;
  var silent = false; // true while we mutate the DOM ourselves
  var flashNext = false; // flash the newest log entry on next rebuild
  var decodeCache = new Map();
  var drafts = {}; // eid -> unsaved composer text, survives panel rebuilds

  function retire() {
    if (dead) return;
    dead = true;
    try {
      mo.disconnect();
    } catch (e) {}
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      badges.forEach(function (stripe) {
        stripe.remove();
      });
      badges.clear();
      document.querySelectorAll('.cn-panel').forEach(function (n) {
        if (n.getAttribute('data-cn-gen') === GEN) n.remove();
      });
    } catch (e) {}
  }

  /* Persist failed — say so in the open panel instead of losing input. */
  function markStale(panel) {
    if (!panel || !panel.isConnected || panel.querySelector('.cn-stale')) return;
    withSilence(function () {
      var msg = S.contextGone()
        ? 'Call Notes was updated — refresh this tab (⌘R) to keep saving.'
        : 'Couldn’t save. Refresh this tab (⌘R) and try again.';
      var n = document.createElement('p');
      n.className = 'cn-stale';
      n.setAttribute('role', 'alert');
      n.textContent = msg;
      panel.insertBefore(n, panel.firstChild);
    });
  }

  function keyOf(eid) {
    if (!decodeCache.has(eid)) {
      var d = S.decodeEid(eid);
      decodeCache.set(eid, d ? d.key : eid);
    }
    return decodeCache.get(eid);
  }

  function catById(id) {
    if (!state || !id) return null;
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].id === id) return state.categories[i];
    }
    return null;
  }

  function withSilence(fn) {
    silent = true;
    try {
      fn();
    } finally {
      // Observer callbacks for our own writes arrive as microtasks, which
      // run before this macrotask clears the flag.
      setTimeout(function () {
        silent = false;
      }, 0);
    }
  }

  function isDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor;
      var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '');
      if (!m) return false;
      var lum =
        (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      return lum < 0.5;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Event bubble detection
   * ------------------------------------------------------------------ */

  function findDialogs() {
    var cands = [];
    var seen = new Set();
    var nodes = document.querySelectorAll('#xDetDlg, div[role="dialog"]');
    nodes.forEach(function (d) {
      if (seen.has(d)) return;
      seen.add(d);
      var eid = d.getAttribute('data-eventid');
      var direct = !!eid || d.id === 'xDetDlg';
      if (!eid) {
        // Some builds hang the eventid on an inner wrapper instead of the
        // dialog root. Chips (role=button) inside overflow popups don't
        // count — those dialogs are lists, not a single event's bubble.
        var inner = d.querySelector(
          '[data-eventid]:not([role="button"]):not(.cn-stripe)'
        );
        if (inner && !inner.closest('.cn-panel')) {
          eid = inner.getAttribute('data-eventid');
        }
      }
      if (eid) cands.push({ root: d, eid: eid, direct: direct });
    });
    // Calendar wraps the bubble in outer role=dialog containers that also
    // "see" the eventid. Injecting into those paints a second, floating
    // panel — keep only the direct carrier, and only the innermost one.
    var direct = cands.filter(function (c) { return c.direct; });
    cands = cands.filter(function (c) {
      if (c.direct) return true;
      return !direct.some(function (dc) { return dc.eid === c.eid; });
    });
    cands = cands.filter(function (a) {
      return !cands.some(function (b) {
        return b !== a && a.root !== b.root && a.root.contains(b.root);
      });
    });
    return cands;
  }

  function getTitle(dialog) {
    var sels = ['#rAECCd', '[id^="rAECCd"]', '[role="heading"]', 'h1', 'h2', 'h3'];
    for (var i = 0; i < sels.length; i++) {
      var el = dialog.querySelector(sels[i]);
      if (el && !el.closest('.cn-panel')) {
        var t = (el.textContent || '').trim();
        if (t) return t;
      }
    }
    var lines = (dialog.innerText || '').split('\n');
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j].trim();
      if (line) return line;
    }
    return '(untitled event)';
  }

  /* ------------------------------------------------------------------ *
   * Panel construction
   * ------------------------------------------------------------------ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }

  function refreshDialogs() {
    if (!state) return;
    findDialogs().forEach(function (d) {
      try {
        refreshDialog(d);
      } catch (e) {
        warn(e);
      }
    });
  }

  function refreshDialog(d) {
    var stale =
        !d.root.__cnPanel ||
        d.root.__cnFor !== d.eid ||
        !d.root.contains(d.root.__cnPanel) ||
        d.root.__cnStamp !== state;
      if (!stale) return;
      withSilence(function () {
        if (d.root.__cnPanel && d.root.__cnPanel.parentNode) {
          d.root.__cnPanel.parentNode.removeChild(d.root.__cnPanel);
        }
        var title = getTitle(d.root);
        var panel = buildPanel(d.eid, title);
        d.root.appendChild(panel);
        d.root.__cnPanel = panel;
        d.root.__cnFor = d.eid;
        d.root.__cnStamp = state;
        var log = panel.querySelector('.cn-log');
        if (log) log.scrollTop = log.scrollHeight;
        if (S.contextGone()) markStale(panel);
      });
  }

  function buildPanel(eid, title) {
    var key = keyOf(eid);
    var info = state.events[key] || null;
    var meta = { title: title, eid: eid };
    var cat = info ? catById(info.catId) : null;

    var panel = el('section', 'cn-panel' + (isDark() ? ' cn-dark' : ''));
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Call notes');
    panel.setAttribute('data-cn-gen', GEN);
    panel.style.setProperty('--cn-cat', cat ? cat.color : 'transparent');

    // Header
    var head = el('div', 'cn-head');
    head.appendChild(el('span', 'cn-eyebrow', 'CALL NOTES'));
    var n = info && info.log ? info.log.length : 0;
    head.appendChild(
      el('span', 'cn-count', n ? n + (n === 1 ? ' NOTE' : ' NOTES') : '')
    );
    // Version tag: shows which build the tab runs; click for diagnostics.
    var ver = el('button', 'cn-ver', 'v' + VERSION);
    ver.type = 'button';
    ver.title = 'Diagnostics';
    ver.setAttribute('aria-label', 'Show diagnostics');
    ver.addEventListener('click', function () {
      withSilence(function () {
        var open = panel.querySelector('.cn-diag');
        if (open) open.remove();
        else panel.appendChild(buildDiag());
      });
    });
    head.appendChild(ver);
    panel.appendChild(head);

    // Category stamps
    var chips = el('div', 'cn-chips');
    state.categories.forEach(function (c) {
      var b = el('button', 'cn-chip', c.name);
      b.type = 'button';
      b.style.setProperty('--c', c.color);
      b.style.setProperty('--ink', S.inkFor(c.color));
      var on = !!(info && info.catId === c.id);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () {
        var next = on ? null : c.id;
        // Paint immediately; the store round-trip re-renders the truth.
        withSilence(function () {
          var all = chips.querySelectorAll('.cn-chip');
          for (var i = 0; i < all.length; i++) {
            all[i].setAttribute('aria-pressed', 'false');
          }
          if (next) b.setAttribute('aria-pressed', 'true');
          panel.style.setProperty('--cn-cat', next ? c.color : 'transparent');
        });
        S.setCategory(key, next, meta).catch(function (e) {
          warn(e);
          markStale(panel);
        });
      });
      chips.appendChild(b);
    });
    panel.appendChild(chips);

    // Notes log
    if (n) {
      var log = el('ul', 'cn-log');
      info.log.forEach(function (entry, idx) {
        log.appendChild(buildEntry(key, entry, idx === n - 1));
      });
      panel.appendChild(log);
    } else {
      panel.appendChild(
        el(
          'p',
          'cn-empty',
          'No notes yet — what you write here follows this call every time it comes around.'
        )
      );
    }

    // Composer
    var composer = el('div', 'cn-composer');
    var ta = el('textarea');
    ta.rows = 1;
    ta.placeholder = 'Add a note…';
    ta.setAttribute('aria-label', 'Add a note');
    if (drafts[eid]) {
      // Calendar sometimes reconciles the bubble and our panel rebuilds —
      // half-typed notes carry over.
      ta.value = drafts[eid];
      requestAnimationFrame(function () {
        autosize(ta);
      });
    }
    ta.addEventListener('input', function () {
      autosize(ta);
      if (ta.value.trim()) drafts[eid] = ta.value;
      else delete drafts[eid];
    });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        commit();
      }
      ev.stopPropagation(); // keep Calendar's shortcuts out of the field
    });
    ta.addEventListener('keyup', stop);
    ta.addEventListener('keypress', stop);
    ta.addEventListener('blur', commit);
    function stop(ev) {
      ev.stopPropagation();
    }
    var committing = false;
    function commit() {
      if (committing) return;
      var text = ta.value.trim();
      if (!text) return;
      committing = true;
      ta.value = '';
      autosize(ta);
      flashNext = true;
      S.addEntry(key, text, meta).then(
        function () {
          committing = false;
          delete drafts[eid];
        },
        function (e) {
          committing = false;
          drafts[eid] = text;
          if (ta.isConnected) {
            ta.value = text;
            autosize(ta);
          }
          warn(e);
          markStale(panel);
        }
      );
    }
    composer.appendChild(ta);
    composer.appendChild(
      el('div', 'cn-hint', 'ENTER TO SAVE · SHIFT+ENTER FOR A NEW LINE')
    );
    panel.appendChild(composer);

    return panel;
  }

  function diagReport(full) {
    var lines = [
      'Call Notes v' + VERSION,
      'time ' + new Date().toISOString(),
      'storage reachable: ' + !S.contextGone(),
      'retired: ' + dead,
      'tagged calls: ' + (state ? Object.keys(state.events).length : 'n/a'),
      'badges on screen: ' + badges.size,
      'errors recorded: ' + errlog.length
    ];
    var entries = full ? errlog : errlog.slice(-5);
    entries.forEach(function (e) {
      lines.push('· ' + e.at + ' [' + e.kind + '] ' + e.msg);
      if (full && e.stack) lines.push(e.stack);
    });
    return lines.join('\n');
  }

  function buildDiag() {
    var d = el('div', 'cn-diag');
    d.appendChild(
      el(
        'pre',
        'cn-diag-text',
        diagReport(false) + (errlog.length ? '' : '\n(no errors — all clear)')
      )
    );
    var copy = el('button', 'cn-diag-btn', 'Copy report');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(diagReport(true)).then(
        function () {
          copy.textContent = 'Copied ✓';
          setTimeout(function () {
            copy.textContent = 'Copy report';
          }, 1600);
        },
        function () {
          copy.textContent = 'Copy failed — select the text above';
        }
      );
    });
    d.appendChild(copy);
    return d;
  }

  function buildEntry(key, entry, isLast) {
    var li = el('li', 'cn-entry');
    if (isLast && flashNext) {
      li.classList.add('cn-new');
      flashNext = false;
    }
    li.appendChild(el('span', 'cn-entry-stamp', S.stamp(entry.at)));
    var text = el('div', 'cn-entry-text', entry.text);
    li.appendChild(text);

    var acts = el('div', 'cn-entry-acts');
    var edit = el('button', 'cn-entry-act', '✎');
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Edit note');
    edit.addEventListener('click', function () {
      startEdit(li, key, entry);
    });
    var del = el('button', 'cn-entry-act', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete note');
    del.addEventListener('click', function () {
      if (del.dataset.armed) {
        S.deleteEntry(key, entry.id).catch(function (e) {
          warn(e);
          markStale(li.closest('.cn-panel'));
        });
      } else {
        del.dataset.armed = '1';
        del.textContent = 'sure?';
        del.setAttribute('aria-label', 'Click again to delete');
        setTimeout(function () {
          delete del.dataset.armed;
          del.textContent = '✕';
          del.setAttribute('aria-label', 'Delete note');
        }, 2200);
      }
    });
    acts.appendChild(edit);
    acts.appendChild(del);
    li.appendChild(acts);
    return li;
  }

  function startEdit(li, key, entry) {
    if (li.querySelector('textarea')) return;
    withSilence(function () {
      var text = li.querySelector('.cn-entry-text');
      var acts = li.querySelector('.cn-entry-acts');
      if (text) text.style.display = 'none';
      if (acts) acts.style.display = 'none';
      var ta = el('textarea');
      ta.value = entry.text;
      ta.setAttribute('aria-label', 'Edit note');
      li.appendChild(ta);
      autosize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      var done = false;
      function finish(save) {
        if (done) return;
        done = true;
        if (save && ta.value.trim() && ta.value.trim() !== entry.text) {
          S.editEntry(key, entry.id, ta.value).catch(function (e) {
            warn(e);
            markStale(li.closest('.cn-panel'));
          });
        } else {
          withSilence(function () {
            ta.remove();
            if (text) text.style.display = '';
            if (acts) acts.style.display = '';
          });
        }
      }
      ta.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === 'Escape') {
          finish(false);
        }
        ev.stopPropagation();
      });
      ta.addEventListener('keyup', function (ev) { ev.stopPropagation(); });
      ta.addEventListener('input', function () { autosize(ta); });
      ta.addEventListener('blur', function () { finish(true); });
    });
  }

  /* ------------------------------------------------------------------ *
   * Grid badges
   * ------------------------------------------------------------------ */

  var STRIPE_W = 8;
  var STRIPE_Z = 60;
  var badges = new Map(); // chip element -> stripe element

  /*
   * True when most of the chip is painted over by other elements (a wider
   * chip stacked on top of it). Hit-testing respects real paint order and
   * skips our own pointer-events:none badges.
   */
  function isOccluded(chip) {
    var r = chip.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var pts = [
      [r.left + r.width * 0.5, r.top + r.height * 0.5],
      [r.left + r.width * 0.3, r.top + r.height * 0.3],
      [r.left + r.width * 0.7, r.top + r.height * 0.7]
    ];
    var miss = 0;
    for (var i = 0; i < pts.length; i++) {
      var el = document.elementFromPoint(pts[i][0], pts[i][1]);
      if (!el || !chip.contains(el)) miss++;
    }
    return miss >= 2;
  }

  /*
   * Calendar sometimes lays a later event over only the right edge of a
   * tagged call. A normal 8px stripe then lands entirely inside that later
   * event and reads as belonging to the wrong meeting. Find the event that
   * actually paints there so the marker can move to the tagged call's last
   * visible pixels without ever coloring the covering meeting.
   */
  function findRightEdgeCover(chip, r) {
    if (r.width < 2 || r.height < 2) return null;
    var x = r.right - Math.min(2, r.width / 4);
    var ys = [
      r.top + r.height * 0.25,
      r.top + r.height * 0.5,
      r.top + r.height * 0.75
    ];
    var hits = new Map();
    for (var i = 0; i < ys.length; i++) {
      var hit = document.elementFromPoint(x, ys[i]);
      var cover =
        hit && hit.closest
          ? hit.closest(
              '[data-eventid][role="button"], [data-eventid][data-eventchip]'
            )
          : null;
      if (!cover || cover === chip) continue;
      var cr = cover.getBoundingClientRect();
      var overlapY =
        Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top);
      if (
        cr.left <= r.left + 1 ||
        cr.left >= r.right - 1 ||
        cr.right < r.right - 1 ||
        overlapY / Math.min(r.height, cr.height) < 0.5
      ) {
        continue;
      }
      var found = hits.get(cover);
      if (found) found.count++;
      else hits.set(cover, { el: cover, rect: cr, count: 1 });
    }
    var best = null;
    hits.forEach(function (candidate) {
      if (!best || candidate.count > best.count) best = candidate;
    });
    return best;
  }

  function placeStripe(stripe, host, left, top, width, height) {
    var hostRect = host.getBoundingClientRect();
    stripe.style.left =
      left - hostRect.left - host.clientLeft + host.scrollLeft + 'px';
    stripe.style.top =
      top - hostRect.top - host.clientTop + host.scrollTop + 'px';
    stripe.style.width = width + 'px';
    stripe.style.height = height + 'px';
  }

  function scanChips() {
    if (!state) return;
    var chips = document.querySelectorAll('[data-eventid]');
    withSilence(function () {
      chips.forEach(function (chip) {
        try {
          scanChip(chip);
        } catch (e) {
          warn(e);
        }
      });
      badges.forEach(function (stripe, chip) {
        if (!chip.isConnected) {
          stripe.remove();
          badges.delete(chip);
        }
      });
    });
  }

  function scanChip(chip) {
    var role = chip.getAttribute('role');
    if (role !== 'button' && !chip.hasAttribute('data-eventchip')) return;
    if (chip.closest('#xDetDlg')) return;
    var info = state.events[keyOf(chip.getAttribute('data-eventid'))];
    var cat = info ? catById(info.catId) : null;
    var noted = !!(info && info.log && info.log.length);
    var stripe = badges.get(chip);
    if (!cat && !noted) {
      if (stripe) {
        stripe.remove();
        badges.delete(chip);
      }
      return;
    }
    // Render the stripe as a *sibling* in the chip's positioned
    // container, not a child: overlapping neighbor chips get their own
    // z-index from Calendar and would bury anything inside the chip.
    // Exception: when Calendar raises a chip above the stripe layer
    // (selecting it elevates z-index), host the stripe inside that chip
    // instead — a child paints on top of it, and the raised chip is
    // already above its neighbors.
    var cs = getComputedStyle(chip);
    var chipZ = parseInt(cs.zIndex, 10);
    var host = chip.offsetParent;
    var inChip =
      (!isNaN(chipZ) && chipZ > STRIPE_Z) ||
      !host ||
      host === document.body ||
      host === document.documentElement;
    if (inChip) host = chip;
    if (!stripe || stripe.parentNode !== host) {
      if (stripe) stripe.remove();
      stripe = document.createElement('span');
      stripe.className = 'cn-stripe';
      host.appendChild(stripe);
      badges.set(chip, stripe);
    }
    // Never borrow a neighboring event's rectangle: doing so makes that
    // meeting look tagged. If the right edge is covered, move the stripe to
    // the last visible slice *inside this chip*. If the whole chip is hidden,
    // keep only a narrow hatched rail at this chip's own left edge.
    var selfRect = null;
    var edgeCover = null;
    var clipped = false;
    var hidden = false;
    if (!inChip) {
      selfRect = chip.getBoundingClientRect();
      edgeCover = findRightEdgeCover(chip, selfRect);
      clipped = !!edgeCover;
      hidden = !clipped && isOccluded(chip);
    }
    stripe.classList.toggle('cn-stripe--in', inChip);
    stripe.classList.toggle('cn-stripe--clipped', clipped);
    stripe.classList.toggle('cn-stripe--hidden', hidden);
    stripe.style.borderTopRightRadius =
      !clipped && !hidden ? cs.borderTopRightRadius : '';
    stripe.style.borderBottomRightRadius =
      !clipped && !hidden ? cs.borderBottomRightRadius : '';
    stripe.style.borderTopLeftRadius = hidden ? cs.borderTopLeftRadius : '';
    stripe.style.borderBottomLeftRadius = hidden
      ? cs.borderBottomLeftRadius
      : '';
    if (inChip) {
      if (cs.position === 'static') chip.style.position = 'relative';
      stripe.style.left = '';
      stripe.style.top = '';
      stripe.style.height = '';
      stripe.style.width = STRIPE_W + 'px';
    } else if (clipped) {
      var visibleRight = Math.min(edgeCover.rect.left, selfRect.right);
      var clippedWidth = Math.min(
        STRIPE_W,
        Math.max(1, visibleRight - selfRect.left)
      );
      placeStripe(
        stripe,
        host,
        visibleRight - clippedWidth,
        selfRect.top,
        clippedWidth,
        selfRect.height
      );
    } else if (hidden) {
      placeStripe(
        stripe,
        host,
        selfRect.left,
        selfRect.top,
        Math.min(STRIPE_W, selfRect.width),
        selfRect.height
      );
    } else {
      stripe.style.left = chip.offsetLeft + chip.offsetWidth - STRIPE_W + 'px';
      stripe.style.top = chip.offsetTop + 'px';
      stripe.style.height = chip.offsetHeight + 'px';
      stripe.style.width = STRIPE_W + 'px';
    }
    stripe.classList.toggle('cn-stripe--noted', noted);
    stripe.style.setProperty('--c', cat ? cat.color : '#a79b8e');
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  /* Ring buffer of everything that went wrong, feeding the in-panel
     diagnostics (click the version tag) — so bug reports don't require
     spelunking through DevTools. */
  var errlog = [];
  function record(kind, e) {
    try {
      errlog.push({
        at: new Date().toISOString().slice(11, 19),
        kind: kind,
        msg: String((e && e.message) || e).slice(0, 300),
        stack: ((e && e.stack) || '').split('\n').slice(1, 4).join('\n')
      });
      if (errlog.length > 20) errlog.shift();
    } catch (_) {}
  }

  window.addEventListener('unhandledrejection', function (ev) {
    record('unhandled', ev.reason);
  });

  var warned = {};
  function warn(e) {
    try {
      record('warn', e);
      // The same failure can recur every scan cycle — log each distinct
      // message at most once a minute so the console stays readable.
      var k = String((e && e.message) || e);
      var now = Date.now();
      if (warned[k] && now - warned[k] < 60000) return;
      warned[k] = now;
      console.warn(TAG, e);
    } catch (_) {}
  }

  var timer = null;
  function schedule() {
    if (dead || timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (dead) return;
      try {
        refreshDialogs();
        scanChips();
      } catch (e) {
        warn(e);
      }
    }, 120);
  }

  var mo = new MutationObserver(function (muts) {
    if (dead || silent || !state) return;
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'attributes' && m.attributeName === 'data-cn-gen') {
        // A newer script generation announced itself — stand down.
        if (
          document.documentElement.getAttribute('data-cn-gen') !== GEN
        ) {
          retire();
          return;
        }
        continue;
      }
      var t = m.target;
      if (t && t.nodeType === 1) {
        if (t.classList && t.classList.contains('cn-stripe')) continue;
        if (t.closest && t.closest('.cn-panel')) continue;
      }
      schedule();
      return;
    }
  });

  S.load()
    .then(function (st) {
      state = st;
      // Take over from any previous script generation (extension was
      // updated while this tab stayed open): clear its leftover UI, then
      // announce ourselves before observing so our own stamp is ignored.
      document
        .querySelectorAll('.cn-panel, .cn-stripe, .cn-stale')
        .forEach(function (n) {
          n.remove();
        });
      document.documentElement.setAttribute('data-cn-gen', GEN);
      // Attributes matter too: selecting a chip raises its z-index via
      // class/style changes with no childList mutation, and the stripe has
      // to re-host in response.
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'class',
          'style',
          'data-eventid',
          'aria-expanded',
          'data-cn-gen'
        ]
      });
      // Stripe positions are computed from chip layout, which shifts on
      // window resizes without any childList mutation.
      window.addEventListener('resize', schedule, { passive: true });
      schedule();
      console.info(TAG, 'v' + VERSION + ' active');
      // Diagnostic hook: in DevTools, switch the console context from "top"
      // to the Call Notes extension and run __cnInfo().
      window.__cnInfo = function () {
        return {
          version: VERSION,
          retired: dead,
          contextGone: S.contextGone(),
          taggedCalls: state ? Object.keys(state.events).length : null,
          badgesOnScreen: badges.size,
          openPanels: document.querySelectorAll('.cn-panel').length
        };
      };
    })
    .catch(warn);

  S.onChange(function (st) {
    if (dead) return;
    state = st;
    schedule();
  });
})();
