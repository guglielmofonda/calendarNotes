/*
 * CNStore — shared persistence layer for Call Notes.
 * Loaded as a plain script by both the content script and the popup.
 *
 * State shape (single storage key "cn_state"):
 *   {
 *     v: 1,
 *     categories: [{ id, name, color }],
 *     events: {
 *       [seriesKey]: {
 *         title,      // last seen event title
 *         eid,        // last seen raw data-eventid (for deep links)
 *         catId,      // category id or null
 *         log:        [{ id, text, at }]   // chronological, oldest first
 *         updatedAt,
 *       }
 *     }
 *   }
 *
 * When chrome.storage is unavailable (dev mock pages), falls back to
 * localStorage with the same async API.
 */
(function () {
  'use strict';

  var KEY = 'cn_state';

  var DEFAULT_CATEGORIES = [
    { id: 'cos', name: "Co's", color: '#D50000' },
    { id: 'intern', name: 'Intern', color: '#E67C73' },
    { id: 'sfp', name: 'SFP', color: '#33B679' },
    { id: 'odf', name: 'ODF', color: '#039BE5' },
    { id: 'external', name: 'External', color: '#F6BF26' },
    { id: 'personal', name: 'Personal', color: '#8E24AA' }
  ];

  // The Google Calendar event palette, offered when creating categories.
  var PALETTE = [
    '#D50000', '#E67C73', '#F4511E', '#F6BF26', '#33B679', '#0B8043',
    '#039BE5', '#3F51B5', '#7986CB', '#8E24AA', '#616161', '#A79B8E'
  ];

  var hasChrome =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  /* ------------------------------------------------------------------ *
   * Raw backend: chrome.storage.local, or localStorage in dev pages.
   * ------------------------------------------------------------------ */
  var backend = hasChrome
    ? {
        get: function () {
          return new Promise(function (resolve, reject) {
            try {
              chrome.storage.local.get(KEY, function (o) {
                var err = chrome.runtime && chrome.runtime.lastError;
                if (err) reject(new Error(err.message || 'storage.get failed'));
                else resolve((o && o[KEY]) || null);
              });
            } catch (e) {
              // A reloaded/updated extension invalidates this context and
              // chrome.* throws synchronously — surface it, don't swallow.
              reject(e);
            }
          });
        },
        set: function (state) {
          return new Promise(function (resolve, reject) {
            try {
              var o = {};
              o[KEY] = state;
              chrome.storage.local.set(o, function () {
                var err = chrome.runtime && chrome.runtime.lastError;
                if (err) reject(new Error(err.message || 'storage.set failed'));
                else resolve();
              });
            } catch (e) {
              reject(e);
            }
          });
        },
        watch: function (cb) {
          try {
            chrome.storage.onChanged.addListener(function (changes, area) {
              if (area === 'local' && changes[KEY]) cb();
            });
          } catch (e) {}
        }
      }
    : {
        get: function () {
          try {
            var raw = localStorage.getItem(KEY);
            return Promise.resolve(raw ? JSON.parse(raw) : null);
          } catch (e) {
            return Promise.resolve(null);
          }
        },
        set: function (state) {
          try {
            localStorage.setItem(KEY, JSON.stringify(state));
          } catch (e) {}
          // Notify listeners in the same document (mock pages) and others.
          try {
            window.dispatchEvent(new CustomEvent('cn-storage'));
          } catch (e) {}
          return Promise.resolve();
        },
        watch: function (cb) {
          window.addEventListener('cn-storage', cb);
          window.addEventListener('storage', function (e) {
            if (!e || e.key === KEY) cb();
          });
        }
      };

  function normalize(state) {
    if (!state || typeof state !== 'object') state = {};
    if (!Array.isArray(state.categories) || state.categories.length === 0) {
      state.categories = DEFAULT_CATEGORIES.map(function (c) {
        return { id: c.id, name: c.name, color: c.color };
      });
    }
    if (!state.events || typeof state.events !== 'object') state.events = {};
    state.v = 1;
    return state;
  }

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  function uid() {
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    );
  }

  /*
   * Google Calendar encodes `data-eventid` as base64url of
   * "<eventId> <calendarId>". Recurring instances carry an instance
   * suffix on the eventId ("_20260805T160000Z" or "_20260805"), which we
   * strip so notes follow the series — that is the "memory" behaviour.
   * Anything that fails to decode is keyed by its raw attribute value.
   */
  function decodeEid(eid) {
    if (!eid) return null;
    try {
      var b64 = eid.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var decoded = atob(b64);
      var sp = decoded.indexOf(' ');
      var raw = sp === -1 ? decoded : decoded.slice(0, sp);
      var cal = sp === -1 ? '' : decoded.slice(sp + 1);
      var series = raw.replace(/_R?\d{8}(T\d{6}Z?)?$/, '');
      if (!series) series = raw;
      return { raw: raw, cal: cal, series: series, key: series || eid };
    } catch (e) {
      return { raw: eid, cal: '', series: eid, key: eid };
    }
  }

  /* Readable text color to print on top of a category color. */
  function inkFor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#FFFFFF';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1B1D22' : '#FFFFFF';
  }

  var MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  /* "AUG 5 · 2:14 PM" (adds the year when it isn't the current one). */
  function stamp(ts) {
    var d = new Date(ts);
    if (isNaN(d)) return '';
    var now = new Date();
    var h = d.getHours();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    var min = String(d.getMinutes());
    if (min.length < 2) min = '0' + min;
    var s = MONTHS[d.getMonth()] + ' ' + d.getDate();
    if (d.getFullYear() !== now.getFullYear()) s += ' ' + d.getFullYear();
    return s + ' · ' + h + ':' + min + ' ' + ap;
  }

  /* ------------------------------------------------------------------ *
   * State access — read-modify-write against fresh storage each time.
   * ------------------------------------------------------------------ */

  function load() {
    return backend.get().then(normalize);
  }

  /*
   * All mutations are serialized through one chain: concurrent
   * read-modify-writes (e.g. a blur-save racing a category click) would
   * otherwise clobber each other's changes — last write wins, tag lost.
   */
  var chain = Promise.resolve();
  function update(fn) {
    var run = chain.then(function () {
      return backend.get().then(function (state) {
        state = normalize(state);
        var out = fn(state) || state;
        out.v = 1;
        return backend.set(out).then(function () {
          return out;
        });
      });
    });
    chain = run.catch(function () {}); // a failed write must not jam the queue
    return run;
  }

  function eventEntry(state, key) {
    var ev = state.events[key];
    if (!ev) {
      ev = { title: '', eid: '', catId: null, log: [], updatedAt: Date.now() };
      state.events[key] = ev;
    }
    if (!Array.isArray(ev.log)) ev.log = [];
    return ev;
  }

  function touch(state, key, meta) {
    var ev = eventEntry(state, key);
    if (meta) {
      if (meta.title) ev.title = String(meta.title).slice(0, 300);
      if (meta.eid) ev.eid = String(meta.eid);
    }
    ev.updatedAt = Date.now();
    return ev;
  }

  function prune(state, key) {
    var ev = state.events[key];
    if (ev && !ev.catId && (!ev.log || ev.log.length === 0)) {
      delete state.events[key];
    }
  }

  /* True when the extension was reloaded/updated underneath this page —
     the old content script keeps running but chrome.* is dead. */
  function contextGone() {
    if (!hasChrome) return false;
    try {
      return !(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return true;
    }
  }

  var api = {
    PALETTE: PALETTE,
    load: load,
    update: update,
    uid: uid,
    decodeEid: decodeEid,
    inkFor: inkFor,
    stamp: stamp,
    contextGone: contextGone,

    onChange: function (cb) {
      backend.watch(function () {
        // Never let a dead storage context turn into an unhandled rejection.
        load().then(cb, function (e) {
          try {
            console.warn('[CallNotes] store reload failed', e);
          } catch (_) {}
        });
      });
    },

    addEntry: function (key, text, meta) {
      text = String(text || '').trim();
      if (!text) return load();
      return update(function (state) {
        var ev = touch(state, key, meta);
        ev.log.push({ id: uid(), text: text.slice(0, 5000), at: Date.now() });
      });
    },

    editEntry: function (key, entryId, text) {
      text = String(text || '').trim();
      return update(function (state) {
        var ev = state.events[key];
        if (!ev) return;
        for (var i = 0; i < ev.log.length; i++) {
          if (ev.log[i].id === entryId) {
            if (text) ev.log[i].text = text.slice(0, 5000);
            else ev.log.splice(i, 1);
            break;
          }
        }
        ev.updatedAt = Date.now();
        prune(state, key);
      });
    },

    deleteEntry: function (key, entryId) {
      return api.editEntry(key, entryId, '');
    },

    setCategory: function (key, catId, meta) {
      return update(function (state) {
        var ev = touch(state, key, meta);
        ev.catId = catId || null;
        prune(state, key);
      });
    },

    forgetEvent: function (key) {
      return update(function (state) {
        delete state.events[key];
      });
    },

    addCategory: function (name, color) {
      name = String(name || '').trim().slice(0, 40);
      if (!name) return load();
      return update(function (state) {
        state.categories.push({ id: uid(), name: name, color: color || PALETTE[0] });
      });
    },

    renameCategory: function (id, name) {
      name = String(name || '').trim().slice(0, 40);
      if (!name) return load();
      return update(function (state) {
        state.categories.forEach(function (c) {
          if (c.id === id) c.name = name;
        });
      });
    },

    recolorCategory: function (id, color) {
      return update(function (state) {
        state.categories.forEach(function (c) {
          if (c.id === id) c.color = color;
        });
      });
    },

    deleteCategory: function (id) {
      return update(function (state) {
        state.categories = state.categories.filter(function (c) {
          return c.id !== id;
        });
        Object.keys(state.events).forEach(function (k) {
          if (state.events[k].catId === id) state.events[k].catId = null;
          prune(state, k);
        });
      });
    },

    exportJson: function () {
      return load().then(function (state) {
        return JSON.stringify(state, null, 2);
      });
    },

    /* Merge-import: log entries dedupe by id, newer metadata wins. */
    importJson: function (json) {
      var incoming;
      try {
        incoming = normalize(JSON.parse(json));
      } catch (e) {
        return Promise.reject(new Error('Not a valid Call Notes export file.'));
      }
      return update(function (state) {
        incoming.categories.forEach(function (ic) {
          var mine = state.categories.filter(function (c) { return c.id === ic.id; })[0];
          if (mine) {
            mine.name = ic.name;
            mine.color = ic.color;
          } else {
            state.categories.push(ic);
          }
        });
        Object.keys(incoming.events).forEach(function (k) {
          var ie = incoming.events[k];
          var mine = state.events[k];
          if (!mine) {
            state.events[k] = ie;
            return;
          }
          var seen = {};
          mine.log.forEach(function (e) { seen[e.id] = true; });
          (ie.log || []).forEach(function (e) {
            if (e && e.id && !seen[e.id]) mine.log.push(e);
          });
          mine.log.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
          if ((ie.updatedAt || 0) > (mine.updatedAt || 0)) {
            mine.catId = ie.catId;
            mine.title = ie.title || mine.title;
            mine.eid = ie.eid || mine.eid;
            mine.updatedAt = ie.updatedAt;
          }
        });
      });
    }
  };

  if (typeof window !== 'undefined') window.CNStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
