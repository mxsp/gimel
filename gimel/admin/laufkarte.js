// Digitale Laufkarte: Marke/Auftrag hervorheben, Schritte & Teile abhaken
// (lokal je Gerät gespeichert), Fortschritt anzeigen und Drucken.
// Eingebunden als externes Skript (CSP-konform) oder direkt im Offline-Download.
(function() {
  function initInteractivity() {
    var root = document.documentElement;
    var woNo = (document.body && document.body.dataset && document.body.dataset.wo) || '';
    var storeKey = woNo ? ('gimel-lk-v1:' + woNo) : '';

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
    function loadChecked() {
      if (!storeKey) return {};
      try {
        var raw = window.localStorage.getItem(storeKey);
        var parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (_e) {
        return {};
      }
    }

    function saveChecked(map) {
      if (!storeKey) return;
      try { window.localStorage.setItem(storeKey, JSON.stringify(map)); } catch (_e) {}
    }

    var checked = loadChecked();

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
    }

    function toggleCheck(el) {
      var key = el.getAttribute('data-check');
      if (!key) return;
      if (checked[key]) delete checked[key];
      else checked[key] = 1;
      saveChecked(checked);
      syncChecks();
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
      var resetBtn = e.target.closest('[data-lk-reset]');
      if (resetBtn) {
        checked = {};
        saveChecked(checked);
        syncChecks();
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
      } else if (!e.target.closest('.ocard, .lk-bar')) {
        pinnedTag = null;
        pinnedOrder = null;
        applyHighlight(null, null);
      }
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        pinnedTag = null;
        pinnedOrder = null;
        applyHighlight(null, null);
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
