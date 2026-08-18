/* Call Notes — popup logic. Renders from CNStore, re-renders on change. */
(function () {
  'use strict';

  var S = window.CNStore;
  var state = null;
  var expandedKey = null;
  var query = '';
  var addColor = S.PALETTE[4];
  var openPaletteFor = null;
  var refocusQuick = null;
  var statusTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function openTab(url) {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: url });
    } else {
      window.open(url, '_blank');
    }
  }

  function catById(id) {
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].id === id) return state.categories[i];
    }
    return null;
  }

  function shortDate(ts) {
    var full = S.stamp(ts);
    return full.split(' · ')[0] || '';
  }

  function flash(msg) {
    var s = $('status');
    s.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      s.textContent = 'STORED LOCALLY';
    }, 1800);
  }

  function armed(btn, label, fn) {
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (btn.dataset.armed) {
        fn();
      } else {
        btn.dataset.armed = '1';
        btn.dataset.prev = btn.textContent;
        btn.textContent = label;
        setTimeout(function () {
          if (btn.dataset.armed) {
            delete btn.dataset.armed;
            btn.textContent = btn.dataset.prev;
          }
        }, 2400);
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Notes view
   * ---------------------------------------------------------------- */

  function matching() {
    var q = query.trim().toLowerCase();
    var rows = Object.keys(state.events).map(function (k) {
      return { key: k, ev: state.events[k] };
    });
    rows.sort(function (a, b) {
      return (b.ev.updatedAt || 0) - (a.ev.updatedAt || 0);
    });
    if (!q) return rows;
    return rows.filter(function (r) {
      var cat = catById(r.ev.catId);
      if ((r.ev.title || '').toLowerCase().indexOf(q) !== -1) return true;
      if (cat && cat.name.toLowerCase().indexOf(q) !== -1) return true;
      return (r.ev.log || []).some(function (e) {
        return e.text.toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  function renderList() {
    var list = $('list');
    var empty = $('empty');
    list.textContent = '';

    var total = Object.keys(state.events).length;
    var rows = matching();

    if (total === 0) {
      empty.hidden = false;
      $('empty-text').textContent =
        'Click any event in Google Calendar to tag the call and start its running log. It all shows up here.';
      $('open-gcal').hidden = false;
      return;
    }
    if (rows.length === 0) {
      empty.hidden = false;
      $('empty-text').textContent = 'No calls or notes match “' + query.trim() + '”.';
      $('open-gcal').hidden = true;
      return;
    }
    empty.hidden = true;

    rows.forEach(function (r) {
      list.appendChild(buildRow(r.key, r.ev));
    });

    if (refocusQuick && refocusQuick === expandedKey) {
      var q = list.querySelector('.pp-open .pp-quick');
      if (q) q.focus();
    }
    refocusQuick = null;

    var open = list.querySelector('.pp-open');
    if (open) {
      requestAnimationFrame(function () {
        open.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  function buildRow(key, ev) {
    var cat = catById(ev.catId);
    var li = el('li', 'pp-row');
    li.style.setProperty('--c', cat ? cat.color : 'transparent');

    var top = el('div', 'pp-row-top');
    top.appendChild(el('span', 'pp-row-title', ev.title || '(untitled event)'));
    top.appendChild(el('span', 'pp-row-when', shortDate(ev.updatedAt)));
    li.appendChild(top);

    var sub = el('div', 'pp-row-sub');
    if (cat) {
      var tag = el('span', 'pp-tag', cat.name);
      tag.style.setProperty('--c', cat.color);
      tag.style.setProperty('--ink', S.inkFor(cat.color));
      sub.appendChild(tag);
    }
    var last = ev.log && ev.log.length ? ev.log[ev.log.length - 1] : null;
    sub.appendChild(
      el(
        'span',
        'pp-row-preview',
        last
          ? last.text.replace(/\s+/g, ' ')
          : 'Tagged — no notes yet'
      )
    );
    li.appendChild(sub);

    if (expandedKey === key) {
      li.classList.add('pp-open');
      li.appendChild(buildDetail(key, ev));
    }

    li.addEventListener('click', function (evd) {
      if (evd.target.closest('.pp-detail')) return;
      expandedKey = expandedKey === key ? null : key;
      renderList();
    });

    return li;
  }

  function buildDetail(key, ev) {
    var d = el('div', 'pp-detail');

    var chips = el('div', 'pp-chips');
    state.categories.forEach(function (c) {
      var b = el('button', 'pp-chip', c.name);
      b.type = 'button';
      b.style.setProperty('--c', c.color);
      b.style.setProperty('--ink', S.inkFor(c.color));
      var on = ev.catId === c.id;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () {
        S.setCategory(key, on ? null : c.id, { title: ev.title, eid: ev.eid });
      });
      chips.appendChild(b);
    });
    d.appendChild(chips);

    if (ev.log && ev.log.length) {
      var log = el('ul', 'pp-log');
      ev.log.forEach(function (entry) {
        var li = el('li', 'pp-entry');
        li.appendChild(el('span', 'pp-entry-stamp', S.stamp(entry.at)));
        li.appendChild(el('div', 'pp-entry-text', entry.text));
        var del = el('button', 'pp-entry-del', '✕');
        del.type = 'button';
        del.setAttribute('aria-label', 'Delete note');
        armed(del, 'sure?', function () {
          S.deleteEntry(key, entry.id);
        });
        li.appendChild(del);
        log.appendChild(li);
      });
      d.appendChild(log);
      requestAnimationFrame(function () {
        log.scrollTop = log.scrollHeight;
      });
    }

    var quick = el('textarea', 'pp-quick');
    quick.rows = 1;
    quick.placeholder = 'Add a note…';
    quick.setAttribute('aria-label', 'Add a note');
    quick.addEventListener('keydown', function (evd) {
      if (evd.key === 'Enter' && !evd.shiftKey) {
        evd.preventDefault();
        var text = quick.value.trim();
        if (!text) return;
        refocusQuick = key;
        S.addEntry(key, text, { title: ev.title, eid: ev.eid });
      }
    });
    d.appendChild(quick);

    var actions = el('div', 'pp-row-actions');
    if (ev.eid) {
      var open = el('button', 'pp-btn', 'Open in Calendar');
      open.type = 'button';
      open.addEventListener('click', function () {
        openTab(
          'https://calendar.google.com/calendar/event?eid=' +
            encodeURIComponent(ev.eid)
        );
      });
      actions.appendChild(open);
    }
    var forget = el('button', 'pp-btn pp-btn--danger', 'Forget this call');
    forget.type = 'button';
    armed(forget, 'Delete tag + notes?', function () {
      expandedKey = null;
      S.forgetEvent(key);
    });
    actions.appendChild(forget);
    d.appendChild(actions);

    return d;
  }

  /* ---------------------------------------------------------------- *
   * Categories view
   * ---------------------------------------------------------------- */

  function usesOf(catId) {
    return Object.keys(state.events).filter(function (k) {
      return state.events[k].catId === catId;
    }).length;
  }

  function buildPalette(current, onPick) {
    var pal = el('div', 'pp-palette pp-show');
    S.PALETTE.forEach(function (color) {
      var sw = el('button', 'pp-swatch');
      sw.type = 'button';
      sw.style.setProperty('--c', color);
      sw.setAttribute('role', 'radio');
      sw.setAttribute('aria-checked', color === current ? 'true' : 'false');
      sw.setAttribute('aria-label', 'Color ' + color);
      sw.addEventListener('click', function (evd) {
        evd.preventDefault();
        onPick(color);
      });
      pal.appendChild(sw);
    });
    return pal;
  }

  function renderCats() {
    var wrap = $('cats');
    wrap.textContent = '';
    state.categories.forEach(function (c) {
      var li = el('li');

      var row = el('div', 'pp-cat');
      var sw = el('button', 'pp-swatch');
      sw.type = 'button';
      sw.style.setProperty('--c', c.color);
      sw.setAttribute('aria-label', 'Change color for ' + c.name);
      sw.addEventListener('click', function () {
        openPaletteFor = openPaletteFor === c.id ? null : c.id;
        renderCats();
      });
      row.appendChild(sw);

      var name = el('input', 'pp-cat-name');
      name.value = c.name;
      name.maxLength = 40;
      name.setAttribute('aria-label', 'Category name');
      name.addEventListener('change', function () {
        if (name.value.trim() && name.value.trim() !== c.name) {
          S.renameCategory(c.id, name.value);
        } else {
          name.value = c.name;
        }
      });
      row.appendChild(name);

      var uses = usesOf(c.id);
      row.appendChild(
        el('span', 'pp-cat-uses', uses ? uses + (uses === 1 ? ' CALL' : ' CALLS') : '')
      );

      var del = el('button', 'pp-cat-del', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete category ' + c.name);
      armed(del, 'sure?', function () {
        S.deleteCategory(c.id);
      });
      row.appendChild(del);
      li.appendChild(row);

      if (openPaletteFor === c.id) {
        li.appendChild(
          buildPalette(c.color, function (color) {
            openPaletteFor = null;
            S.recolorCategory(c.id, color);
          })
        );
      }
      wrap.appendChild(li);
    });
  }

  function renderAddPalette() {
    var host = $('add-palette');
    host.textContent = '';
    var pal = buildPalette(addColor, function (color) {
      addColor = color;
      renderAddPalette();
    });
    while (pal.firstChild) host.appendChild(pal.firstChild);
    $('add-swatch').style.setProperty('--c', addColor);
  }

  /* ---------------------------------------------------------------- *
   * Header / shell
   * ---------------------------------------------------------------- */

  function renderCount() {
    var calls = Object.keys(state.events).length;
    var notes = Object.keys(state.events).reduce(function (sum, k) {
      return sum + (state.events[k].log || []).length;
    }, 0);
    $('count').textContent = calls
      ? calls + (calls === 1 ? ' CALL' : ' CALLS') + ' · ' + notes + (notes === 1 ? ' NOTE' : ' NOTES')
      : '';
  }

  function render() {
    renderCount();
    renderList();
    renderCats();
  }

  function selectTab(notes) {
    $('tab-notes').setAttribute('aria-selected', notes ? 'true' : 'false');
    $('tab-cats').setAttribute('aria-selected', notes ? 'false' : 'true');
    $('view-notes').hidden = !notes;
    $('view-cats').hidden = notes;
  }

  $('tab-notes').addEventListener('click', function () {
    selectTab(true);
  });
  $('tab-cats').addEventListener('click', function () {
    selectTab(false);
  });

  $('search').addEventListener('input', function () {
    query = $('search').value;
    renderList();
  });

  $('open-gcal').addEventListener('click', function () {
    openTab('https://calendar.google.com/');
  });

  $('export').addEventListener('click', function () {
    S.exportJson().then(function (json) {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'call-notes-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);
      flash('EXPORTED');
    });
  });

  $('import').addEventListener('click', function () {
    $('import-file').click();
  });

  $('import-file').addEventListener('change', function () {
    var file = $('import-file').files[0];
    if (!file) return;
    file.text().then(function (text) {
      return S.importJson(text).then(
        function () {
          flash('IMPORTED');
        },
        function () {
          flash('NOT A VALID EXPORT');
        }
      );
    });
    $('import-file').value = '';
  });

  $('add-cat').addEventListener('submit', function (evd) {
    evd.preventDefault();
    var name = $('add-name').value.trim();
    if (!name) return;
    S.addCategory(name, addColor).then(function () {
      $('add-name').value = '';
    });
  });

  S.load().then(function (st) {
    state = st;
    renderAddPalette();
    render();
  });

  S.onChange(function (st) {
    state = st;
    render();
  });
})();
