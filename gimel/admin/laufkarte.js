// Smarter Laufschein: Marke/Auftrag hervorheben, Schritte & Teile abhaken,
// Live-Server-Synchronisation (mit lokalem Fallback), Stoppuhr (Ist vs. Soll),
// Chargenauswahl, Markenfilter, Tastaturnavigation (j/k) & Team-Notizen.
(function() {
  function initInteractivity() {
    var root = document.documentElement;
    var body = document.body;
    var woNo = (body && body.dataset && body.dataset.wo) || '';
    var stateUrl = (body && body.dataset && body.dataset.stateUrl) || '';
    var noteUrl = (body && body.dataset && body.dataset.noteUrl) || '';
    var storeKey = woNo ? ('gimel-lk-v2:' + woNo) : '';

    function authHeaders() {
      var h = { 'Content-Type': 'application/json' };
      try {
        var tok = window.localStorage.getItem('gimel-token');
        if (tok) h['Authorization'] = 'Bearer ' + tok;
      } catch (_e) {}
      return h;
    }

    // --------------------------------------------------------- Highlight / Pin
    var pinnedTag = null;
    var pinnedOrder = null;

    function applyHighlight(tag, orderNo) {
      var activeTag = tag || pinnedTag;
      var activeOrder = orderNo || pinnedOrder;
      document.querySelectorAll('.draw').forEach(function(container) {
        if (activeTag || activeOrder) container.classList.add('has-highlight');
        else container.classList.remove('has-highlight');
      });
      document.querySelectorAll('.plate-part').forEach(function(el) {
        var match = (activeTag && el.dataset.tag === activeTag) ||
                    (activeOrder && el.dataset.order === activeOrder);
        el.classList.toggle('highlighted', Boolean(match));
      });
      document.querySelectorAll('.marken-row').forEach(function(el) {
        var match = (activeTag && el.dataset.markeTag === activeTag) ||
                    (activeOrder && el.dataset.orderNo === activeOrder);
        el.classList.toggle('highlighted', Boolean(match));
        if (pinnedTag && el.dataset.markeTag === pinnedTag) el.classList.add('selected');
        else el.classList.remove('selected');
      });
      document.querySelectorAll('.ocard').forEach(function(el) {
        var onoEl = el.querySelector('.ono');
        var elOrder = onoEl ? onoEl.innerText.trim() : '';
        var match = activeOrder && elOrder.indexOf(activeOrder) === 0;
        el.classList.toggle('highlighted', Boolean(match));
      });
    }

    // --------------------------------------------------- Checklisten & Speicher
    function loadLocal() {
      if (!storeKey) return { checked: {}, elapsed_sec: 0, selected_lot: '' };
      try {
        var raw = window.localStorage.getItem(storeKey);
        var parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
          return {
            checked: parsed.checked || {},
            elapsed_sec: Number(parsed.elapsed_sec || 0),
            selected_lot: String(parsed.selected_lot || '')
          };
        }
      } catch (_e) {}
      return { checked: {}, elapsed_sec: 0, selected_lot: '' };
    }

    var localInit = loadLocal();
    var checked = localInit.checked;
    var elapsedSec = localInit.elapsed_sec;
    var selectedLot = localInit.selected_lot;
    var timerHandle = null;
    var syncDebounce = null;

    var syncEl = document.querySelector('[data-lk-sync-state]');
    var lotSelect = document.querySelector('[data-lk-lot]');
    var timerEl = document.querySelector('[data-lk-timer]');
    var timerBtn = document.querySelector('[data-lk-timer-toggle]');

    function fmtTimer(sec) {
      var s = Math.max(0, Math.floor(sec));
      var m = Math.floor(s / 60);
      var r = s % 60;
      return (m < 10 ? '0' + m : String(m)) + ':' + (r < 10 ? '0' + r : String(r));
    }

    function renderTimer() {
      if (timerEl) timerEl.textContent = fmtTimer(elapsedSec);
      if (timerBtn) timerBtn.textContent = timerHandle ? '⏸ Pause' : '▶ Start';
    }

    function saveState() {
      if (storeKey) {
        try {
          window.localStorage.setItem(storeKey, JSON.stringify({
            checked: checked,
            elapsed_sec: elapsedSec,
            selected_lot: selectedLot
          }));
        } catch (_e) {}
      }
      if (!stateUrl) return;
      if (syncDebounce) clearTimeout(syncDebounce);
      syncDebounce = setTimeout(function() {
        fetch(stateUrl, {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({
            checked: checked,
            elapsed_sec: elapsedSec,
            selected_lot: selectedLot
          })
        }).then(function(r) {
          if (syncEl) syncEl.textContent = r.ok ? '✓ Synchron' : '';
        }).catch(function() {
          if (syncEl) syncEl.textContent = 'Lokal';
        });
      }, 350);
    }

    function syncChecks() {
      var stepTotal = 0, stepDone = 0;
      var markTotal = 0, markDone = 0;
      var qcTotal = 0, qcDone = 0;

      document.querySelectorAll('[data-check]').forEach(function(el) {
        var key = el.getAttribute('data-check') || '';
        var isDone = Boolean(checked[key]);
        el.classList.toggle('is-checked', isDone);
        if (el.getAttribute('role') === 'checkbox') {
          el.setAttribute('aria-checked', isDone ? 'true' : 'false');
        }
        if (el.tagName === 'BUTTON') {
          el.setAttribute('aria-pressed', isDone ? 'true' : 'false');
          el.textContent = isDone ? '✓' : '☐';
          var row = el.closest('.marken-row');
          if (row) row.classList.toggle('is-checked', isDone);
        } else {
          var box = el.querySelector('.chkbox');
          if (box) box.textContent = isDone ? '✓' : '';
        }
        if (key.indexOf('step:') === 0) { stepTotal++; if (isDone) stepDone++; }
        else if (key.indexOf('marke:') === 0) { markTotal++; if (isDone) markDone++; }
        else if (key.indexOf('qc:') === 0) { qcTotal++; if (isDone) qcDone++; }
      });

      var total = stepTotal + markTotal + qcTotal;
      var done = stepDone + markDone + qcDone;
      var pct = total > 0 ? Math.round((done / total) * 100) : 0;

      var summary = document.querySelector('[data-lk-progress]');
      if (summary) {
        summary.textContent =
          'Ablauf ' + stepDone + '/' + stepTotal +
          (markTotal ? ' · Marken ' + markDone + '/' + markTotal : '') +
          ' · Prüfung ' + qcDone + '/' + qcTotal;
      }
      var fill = document.querySelector('[data-lk-progress-fill]');
      if (fill) fill.style.width = pct + '%';

      var resetBtn = document.querySelector('[data-lk-reset]');
      if (resetBtn) resetBtn.hidden = done === 0;
      if (lotSelect && selectedLot) lotSelect.value = selectedLot;
      renderTimer();
    }

    function toggleCheck(el) {
      var key = el.getAttribute('data-check');
      if (!key) return;
      if (checked[key]) delete checked[key];
      else checked[key] = 1;
      syncChecks();
      saveState();
    }

    // Server-Stand beim Öffnen nachladen
    if (stateUrl) {
      fetch(stateUrl, { headers: authHeaders() })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (!data || typeof data !== 'object') return;
          if (data.checked && Object.keys(data.checked).length > 0) {
            Object.keys(data.checked).forEach(function(k) { checked[k] = 1; });
          }
          if (data.elapsed_sec && data.elapsed_sec > elapsedSec) {
            elapsedSec = Number(data.elapsed_sec);
          }
          if (data.selected_lot) {
            selectedLot = String(data.selected_lot);
          }
          if (syncEl) syncEl.textContent = '✓ Synchron';
          syncChecks();
        })
        .catch(function() {});
    }

    // --------------------------------------------------- Markenfilter & Chargen
    var filterInput = document.querySelector('[data-lk-filter]');
    if (filterInput) {
      filterInput.addEventListener('input', function() {
        var q = (filterInput.value || '').trim().toLowerCase();
        document.querySelectorAll('.marken-row').forEach(function(row) {
          var txt = (row.textContent || '').toLowerCase();
          row.classList.toggle('is-filtered-out', Boolean(q && txt.indexOf(q) === -1));
        });
      });
    }

    if (lotSelect) {
      lotSelect.addEventListener('change', function() {
        selectedLot = lotSelect.value || '';
        saveState();
      });
    }

    // -------------------------------------------------------------- Ereignisse
    document.addEventListener('mouseover', function(e) {
      var part = e.target.closest('.plate-part');
      if (part) return applyHighlight(part.dataset.tag, null);
      var row = e.target.closest('.marken-row');
      if (row) return applyHighlight(row.dataset.markeTag, null);
      var ocard = e.target.closest('.ocard');
      if (ocard) {
        var onoEl = ocard.querySelector('.ono');
        var orderNo = onoEl ? onoEl.innerText.split(' ')[0].trim() : null;
        return applyHighlight(null, orderNo);
      }
    });

    document.addEventListener('mouseout', function(e) {
      if (e.target.closest('.plate-part, .marken-row, .ocard')) {
        applyHighlight(null, null);
      }
    });

    document.addEventListener('click', function(e) {
      var printBtn = e.target.closest('[data-lk-print]');
      if (printBtn) {
        window.print();
        return;
      }
      var reloadBtn = e.target.closest('[data-lk-reload]');
      if (reloadBtn) {
        window.location.reload();
        return;
      }
      var tglBtn = e.target.closest('[data-lk-timer-toggle]');
      if (tglBtn) {
        if (timerHandle) {
          clearInterval(timerHandle);
          timerHandle = null;
          saveState();
        } else {
          timerHandle = setInterval(function() {
            elapsedSec += 1;
            renderTimer();
            if (elapsedSec % 15 === 0) saveState();
          }, 1000);
        }
        renderTimer();
        return;
      }
      var plateBatchBtn = e.target.closest('[data-lk-check-plate]');
      if (plateBatchBtn) {
        var pidx = plateBatchBtn.getAttribute('data-lk-check-plate');
        var prefix = 'marke:' + pidx + ':';
        document.querySelectorAll('[data-check]').forEach(function(el) {
          var k = el.getAttribute('data-check') || '';
          if (k.indexOf(prefix) === 0) checked[k] = 1;
        });
        syncChecks();
        saveState();
        return;
      }
      var noteSendBtn = e.target.closest('[data-lk-note-send]');
      if (noteSendBtn && noteUrl) {
        var inp = document.querySelector('[data-lk-note-input]');
        var st = document.querySelector('[data-lk-note-status]');
        var txt = inp ? (inp.value || '').trim() : '';
        if (!txt) return;
        var payload = noteUrl === '/api/notes'
          ? { channel: 'schicht', priority: 'important', subject: 'Laufkarte ' + woNo, body: txt, entity_type: 'work_order', entity_id: woNo }
          : { sender_name: 'Werkstatt', priority: 'important', body: txt };
        fetch(noteUrl, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(payload)
        }).then(function(r) {
          if (!r.ok) throw new Error('Fehler');
          var list = document.querySelector('[data-lk-note-list]');
          if (list) {
            var li = document.createElement('li');
            li.className = 'lk-note-item';
            var b = document.createElement('b');
            b.textContent = 'Werkstatt: ';
            li.appendChild(b);
            li.appendChild(document.createTextNode(txt));
            list.prepend(li);
          }
          if (inp) inp.value = '';
          if (st) st.textContent = '✓ Gesendet';
        }).catch(function() {
          if (st) st.textContent = 'Senden fehlgeschlagen';
        });
        return;
      }
      var resetBtn = e.target.closest('[data-lk-reset]');
      if (resetBtn) {
        checked = {};
        syncChecks();
        saveState();
        return;
      }
      var chk = e.target.closest('[data-check]');
      if (chk) {
        e.stopPropagation();
        toggleCheck(chk);
        return;
      }
      var part = e.target.closest('.plate-part');
      var row = e.target.closest('.marken-row');
      var tag = part ? part.dataset.tag : (row ? row.dataset.markeTag : null);
      if (tag) {
        pinnedTag = (pinnedTag === tag) ? null : tag;
        pinnedOrder = null;
        applyHighlight(null, null);
        if (pinnedTag) {
          var targetRow = document.querySelector('.marken-row[data-marke-tag="' + pinnedTag + '"]');
          if (targetRow) targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      } else if (!e.target.closest('.ocard, .lk-bar, .smart-box, .smart-notes')) {
        pinnedTag = null;
        pinnedOrder = null;
        applyHighlight(null, null);
      }
    });

    document.addEventListener('keydown', function(e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) {
        return;
      }
      if (e.key === 'Escape') {
        pinnedTag = null;
        pinnedOrder = null;
        applyHighlight(null, null);
        return;
      }
      if (e.key === 'j' || e.key === 'k') {
        var rows = Array.prototype.slice.call(document.querySelectorAll('.marken-row:not(.is-filtered-out)'));
        if (!rows.length) return;
        var curIdx = rows.findIndex(function(r) { return r.dataset.markeTag === pinnedTag; });
        var nextIdx = e.key === 'j' ? (curIdx + 1) % rows.length : (curIdx <= 0 ? rows.length - 1 : curIdx - 1);
        pinnedTag = rows[nextIdx].dataset.markeTag;
        pinnedOrder = null;
        applyHighlight(null, null);
        rows[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if ((e.key === ' ' || e.key === 'Enter') && e.target && e.target.hasAttribute && e.target.hasAttribute('data-check')) {
        if (e.target.tagName !== 'BUTTON') {
          e.preventDefault();
          toggleCheck(e.target);
        }
      }
    });

    if (root) root.dataset.lkReady = '1';
    syncChecks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInteractivity);
  else initInteractivity();
})();
