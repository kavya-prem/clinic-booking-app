/**
 * Browser code. It runs on the receptionist's phone or computer.
 * It never touches the Sheet: it only sends requests to the Google
 * data service (the address is in config.js).
 *
 * The browser remembers two things (in localStorage):
 *   cb_device_id - a random ID for this device, made once
 *   cb_token     - the wristband after a successful login
 * The PIN is never saved.
 */
(function () {
  var KEY_DEVICE = 'cb_device_id';
  var KEY_TOKEN = 'cb_token';
  var state = { deviceId: null, token: null, role: null, pendingPin: null };

  /* ---------- Small helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return true;
    } catch (e) { return false; }
  }

  function newDeviceId() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return 'd-' + Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  /** A friendly name such as "Android phone · Chrome", for the admin's list. */
  function describeDevice() {
    var ua = navigator.userAgent;
    var type = /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) && /Mobile/.test(ua) ? 'Android phone'
      : /Android/.test(ua) ? 'Android tablet'
      : /Macintosh/.test(ua) ? 'Mac'
      : /Windows/.test(ua) ? 'Windows computer'
      : 'Computer';
    var browser = /Edg\//.test(ua) ? 'Edge'
      : /CriOS|Chrome\//.test(ua) ? 'Chrome'
      : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari'
      : 'browser';
    return type + ' · ' + browser;
  }

  /**
   * Sends a request to the Google data service, e.g. call('login', pin, ...).
   * Returns a Promise with the answer. "text/plain" keeps the request simple
   * enough for Google to accept it from another website.
   */
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch(window.CLINIC_CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args })
    })
      .catch(function () {
        throw new Error('Could not reach the server. Check the internet connection and try again.');
      })
      .then(function (response) {
        if (!response.ok) throw new Error('The server did not answer (' + response.status + ').');
        return response.json();
      })
      .then(function (answer) {
        if (!answer.ok) throw new Error(answer.error);
        return answer.result;
      });
  }

  function show(name) {
    ['loading', 'pin', 'pending', 'day', 'devices'].forEach(function (n) {
      $('screen-' + n).hidden = (n !== name);
    });
  }

  function banner(text) {
    $('banner').textContent = text || '';
    $('banner').hidden = !text;
  }

  function busy(button, isBusy) {
    button.disabled = isBusy;
  }

  /** Any server error. If the wristband is no longer valid, go back to the PIN screen. */
  function handleError(err) {
    var message = (err && err.message) || String(err);
    if (message.indexOf('NOT_LOGGED_IN') !== -1) {
      clearToken();
      showPin('Please log in again.');
      return;
    }
    banner('Something went wrong: ' + message);
  }

  function clearToken() {
    state.token = null;
    state.role = null;
    save(KEY_TOKEN, null);
  }

  /* ---------- Screens ---------- */

  function showPin(message) {
    $('pin').value = '';
    $('pin-msg').textContent = message || '';
    show('pin');
    $('pin').focus();
  }

  /** After login: the day view is the main screen. */
  function showHome(session) {
    state.role = session.role;
    $('who').textContent = session.role === 'admin' ? 'Admin' : 'Receptionist';
    $('btn-devices').hidden = session.role !== 'admin';
    setBadge(session.pendingDevices || 0);
    show('day');
    loadDay();
  }

  function setBadge(count) {
    $('badge').textContent = count;
    $('badge').hidden = !count;
  }

  /* ---------- Login ---------- */

  function tryLogin(pin, button, messageEl) {
    busy(button, true);
    messageEl.textContent = '';
    return call('login', pin, state.deviceId, describeDevice())
      .then(function (r) {
        if (r.ok) {
          state.pendingPin = null;
          state.token = r.token;
          save(KEY_TOKEN, r.token);
          showHome(r);
        } else if (r.reason === 'wrong_pin') {
          showPin('Wrong PIN. ' + r.triesLeft + (r.triesLeft === 1 ? ' try' : ' tries') + ' left.');
        } else if (r.reason === 'locked') {
          showPin('Too many wrong tries on this device. Try again at ' + r.until + '.');
        } else if (r.reason === 'pending') {
          state.pendingPin = pin; // kept in memory only, for "Check again"
          if (!$('screen-pending').hidden) messageEl.textContent = 'Not approved yet.';
          show('pending');
        } else {
          state.pendingPin = null;
          showPin('This device is not allowed to use the app. Ask the admin.');
        }
      })
      .catch(handleError)
      .then(function () { busy(button, false); });
  }

  $('pin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = $('pin').value.trim();
    if (!/^\d{4}$/.test(pin)) {
      $('pin-msg').textContent = 'Enter your 4-digit PIN.';
      return;
    }
    tryLogin(pin, $('pin-btn'), $('pin-msg'));
  });

  $('pending-check').addEventListener('click', function () {
    if (!state.pendingPin) { showPin(); return; }
    tryLogin(state.pendingPin, $('pending-check'), $('pending-msg'));
  });

  $('pending-back').addEventListener('click', function () {
    state.pendingPin = null;
    showPin();
  });

  $('btn-logout').addEventListener('click', function () {
    var token = state.token;
    clearToken();
    showPin('You are logged out.');
    call('logout', token, state.deviceId).catch(function () {});
  });

  /* ---------- Devices (admin) ---------- */

  function openDevices() {
    $('devices-msg').textContent = '';
    show('devices');
    loadDevices();
  }

  function loadDevices() {
    return call('listDevices', state.token, state.deviceId).then(renderDevices).catch(handleError);
  }

  function renderDevices(devices) {
    var pending = devices.filter(function (d) { return d.status === 'pending'; });
    var others = devices.filter(function (d) { return d.status !== 'pending'; });
    setBadge(pending.length);

    var pendingList = $('list-pending');
    pendingList.textContent = '';
    $('none-pending').hidden = pending.length > 0;
    pending.forEach(function (d) {
      var li = document.createElement('li');
      li.appendChild(textEl('div', d.description, 'title'));
      li.appendChild(textEl('div', 'Asked: ' + d.firstSeen, 'muted'));
      var input = document.createElement('input');
      input.placeholder = 'Name it, e.g. Reception laptop';
      input.maxLength = 40;
      li.appendChild(input);
      li.appendChild(actionButton('Approve', 'primary', function () {
        return call('approveDevice', state.token, state.deviceId, d.id, input.value);
      }, 'Approved.'));
      li.appendChild(actionButton('Reject', '', function () {
        return call('rejectDevice', state.token, state.deviceId, d.id);
      }, 'Rejected.'));
      pendingList.appendChild(li);
    });

    var list = $('list-devices');
    list.textContent = '';
    others.forEach(function (d) {
      var li = document.createElement('li');
      var title = textEl('div', d.name || d.description, 'title');
      title.appendChild(textEl('span', d.status, 'pill ' + d.status));
      if (d.isThisDevice) title.appendChild(textEl('span', 'this device', 'pill'));
      li.appendChild(title);
      if (d.name) li.appendChild(textEl('div', d.description, 'muted'));
      li.appendChild(textEl('div', 'Last used: ' + (d.lastUsed || '–'), 'muted'));

      if (d.status === 'approved' && !d.isThisDevice) {
        li.appendChild(actionButton('Remove', 'danger-text', function () {
          if (!confirm('Remove "' + (d.name || d.description) + '"? It will be logged out now.')) return null;
          return call('removeDevice', state.token, state.deviceId, d.id);
        }, 'Removed and logged out.'));
      } else if (d.status === 'rejected' || d.status === 'removed') {
        li.appendChild(actionButton('Approve again', '', function () {
          return call('approveDevice', state.token, state.deviceId, d.id, '');
        }, 'Approved.'));
      }
      list.appendChild(li);
    });
  }

  function textEl(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  /** A small button that runs a server action, then redraws the list. */
  function actionButton(label, style, action, doneMessage) {
    var b = document.createElement('button');
    b.className = 'btn small ' + style;
    b.textContent = label;
    b.addEventListener('click', function () {
      var p = action();
      if (!p) return;
      b.disabled = true;
      p.then(function (devices) {
        $('devices-msg').textContent = doneMessage;
        renderDevices(devices);
      }).catch(function (err) {
        b.disabled = false;
        handleError(err);
      });
    });
    return b;
  }

  $('btn-devices').addEventListener('click', openDevices);
  $('devices-back').addEventListener('click', function () { show('day'); loadDay(); });

  $('btn-logout-all').addEventListener('click', function () {
    if (!confirm('Log out every other device? They will need the PIN again.')) return;
    var b = $('btn-logout-all');
    b.disabled = true;
    call('logoutAllDevices', state.token, state.deviceId)
      .then(function (r) { $('devices-msg').textContent = 'Logged out ' + r.loggedOut + ' session(s).'; })
      .catch(handleError)
      .then(function () { b.disabled = false; });
  });

  /* ---------- Day view ---------- */

  // The server sends every day from today to the end of the booking window
  // in one go, so moving between days is instant.
  var view = { data: null, date: null, loading: false };

  /** Asks the server for the latest slots and bookings, then redraws. */
  function loadDay() {
    if (!state.token || view.loading) return Promise.resolve();
    view.loading = true;
    return call('getDayView', state.token, state.deviceId)
      .then(function (data) {
        view.data = data;
        var dates = data.days.map(function (d) { return d.date; });
        if (dates.indexOf(view.date) === -1) view.date = data.today;
        banner('');
        renderDay();
        $('day-updated').textContent = 'Updated ' + nowInIndia().label;
      })
      .catch(handleError)
      .then(function () { view.loading = false; });
  }

  /** The current time in India, whatever the device's own clock zone is. */
  function nowInIndia() {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date()).split(':');
    var minutes = Number(parts[0]) * 60 + Number(parts[1]);
    return { minutes: minutes, label: to12h(parts[0] + ':' + parts[1]) };
  }

  /** "16:15" → "4:15 pm" */
  function to12h(hhmm) {
    var p = String(hhmm).split(':');
    var h = Number(p[0]);
    if (isNaN(h) || p.length < 2) return hhmm;
    return ((h + 11) % 12 + 1) + ':' + p[1] + (h < 12 ? ' am' : ' pm');
  }

  function toMinutes(hhmm) {
    var p = String(hhmm).split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  function renderDay() {
    var data = view.data;
    var index = data.days.map(function (d) { return d.date; }).indexOf(view.date);
    var day = data.days[index];
    var isToday = day.date === data.today;

    $('day-label').textContent = (isToday ? 'Today · ' : '') + day.label;
    $('day-picker').min = data.days[0].date;
    $('day-picker').max = data.days[data.days.length - 1].date;
    $('day-picker').value = day.date;
    $('day-prev').disabled = index === 0;
    $('day-next').disabled = index === data.days.length - 1;
    $('day-today').hidden = isToday;
    // Edit is offered on working days and on days that already have changes.
    $('day-edit').hidden = !(day.workingDay || day.custom);
    if (editState.date && editState.date !== day.date) closeEdit();

    if (day.open) {
      $('day-hours').textContent = 'Open ' + day.hours.split(', ').map(function (r) {
        var p = r.split('-');
        return to12h(p[0]) + ' – ' + to12h(p[1]);
      }).join(', ') + ' · ' + day.slotMinutes + '-min slots';
    } else {
      $('day-hours').textContent = day.closedReason + (day.note ? ': ' + day.note : '');
    }

    var now = nowInIndia().minutes;
    var list = $('slot-list');
    list.textContent = '';
    var shown = 0;
    day.rows.forEach(function (row) {
      // A slot that has already started is never offered, even today.
      // Rows with a booking are always shown.
      var empty = row.kind === 'free' || row.kind === 'unavailable';
      if (isToday && empty && toMinutes(row.time) <= now) return;
      list.appendChild(slotRow(row));
      shown++;
    });

    if (!day.open && shown > 0) {
      list.insertBefore(textEl('li', 'These bookings are on a closed day. They need to be moved.', 'slot-warning'), list.firstChild);
    } else if (day.open && shown === 0) {
      list.appendChild(textEl('li', isToday ? 'No more slots today.' : 'No slots on this day.', 'slot-empty'));
    }
  }

  function slotRow(row) {
    var li = document.createElement('li');
    li.className = 'slot ' + row.kind;
    li.appendChild(textEl('span', to12h(row.time), 'slot-time'));
    var body = document.createElement('span');
    body.className = 'slot-body';
    if (row.kind === 'free') {
      body.appendChild(textEl('span', 'Free', 'slot-free'));
    } else if (row.kind === 'unavailable') {
      body.appendChild(textEl('span', 'Unavailable', 'slot-muted'));
    } else {
      row.bookings.forEach(function (b) {
        var line = textEl('div', b.name, 'slot-name');
        line.appendChild(textEl('span', b.status === 'arrived' ? 'Arrived' : 'Booked', 'pill ' + b.status));
        if (row.kind === 'extra') line.appendChild(textEl('span', 'Extra', 'pill extra'));
        if (row.kind === 'offgrid') line.appendChild(textEl('span', 'Off-grid', 'pill offgrid'));
        body.appendChild(line);
      });
    }
    li.appendChild(body);
    return li;
  }

  function moveDay(step) {
    var dates = view.data.days.map(function (d) { return d.date; });
    var i = dates.indexOf(view.date) + step;
    if (i >= 0 && i < dates.length) {
      view.date = dates[i];
      renderDay();
    }
  }

  $('day-prev').addEventListener('click', function () { moveDay(-1); });
  $('day-next').addEventListener('click', function () { moveDay(1); });
  $('day-today').addEventListener('click', function () { view.date = view.data.today; renderDay(); });
  $('day-picker').addEventListener('change', function () {
    var picked = $('day-picker').value;
    var known = view.data.days.some(function (d) { return d.date === picked; });
    view.date = known ? picked : view.data.today;
    renderDay();
  });

  /* ---------- Edit day ---------- */

  var editState = { date: null, blocked: {} };

  function currentDay() {
    return view.data.days.filter(function (d) { return d.date === view.date; })[0];
  }

  function showEditPart(part) {
    ['edit-menu', 'form-hours', 'form-block', 'form-close'].forEach(function (id) {
      $(id).hidden = id !== part;
    });
  }

  function openEdit() {
    var day = currentDay();
    editState.date = day.date;
    $('day-msg').textContent = '';
    $('edit-hours').hidden = !(day.workingDay || day.custom);
    $('edit-block').hidden = !day.open;
    $('edit-close').hidden = !day.open;
    $('edit-reopen').hidden = !day.closedForLeave;
    $('edit-reset').hidden = !day.custom;
    // A "from now on" change that starts on this day can be undone here.
    var fromNow = day.fromNowChanges || [];
    $('edit-undo').hidden = fromNow.length === 0;
    $('edit-undo').textContent = 'Undo the "from now on" change that starts this day (' + fromNow.join(' and ') + ')';
    showEditPart('edit-menu');
    $('edit-panel').hidden = false;
    $('day-edit').hidden = true;
  }

  function closeEdit() {
    editState.date = null;
    $('edit-panel').hidden = true;
    if (view.data) $('day-edit').hidden = !(currentDay().workingDay || currentDay().custom);
  }

  /** Time choices every 15 minutes from 6:00 am to 11:00 pm. */
  function fillTimeSelect(select, selected) {
    select.textContent = '';
    for (var m = 6 * 60; m <= 23 * 60; m += 15) {
      var hhmm = ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
      var option = document.createElement('option');
      option.value = hhmm;
      option.textContent = to12h(hhmm);
      if (hhmm === selected) option.selected = true;
      select.appendChild(option);
    }
  }

  function openHours() {
    var day = currentDay();
    var first = (day.hours || '16:00-19:00').split(', ')[0].split('-');
    fillTimeSelect($('hours-start'), first[0]);
    fillTimeSelect($('hours-end'), first[1]);
    showEditPart('form-hours');
  }

  function openBlock() {
    var day = currentDay();
    editState.blocked = {};
    day.rows.forEach(function (r) { if (r.blocked) editState.blocked[r.time] = true; });
    var chips = $('block-chips');
    chips.textContent = '';
    day.slotTimes.forEach(function (time) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (editState.blocked[time] ? ' blocked' : '');
      chip.textContent = to12h(time);
      chip.setAttribute('aria-pressed', editState.blocked[time] ? 'true' : 'false');
      chip.addEventListener('click', function () {
        editState.blocked[time] = !editState.blocked[time];
        chip.classList.toggle('blocked', editState.blocked[time]);
        chip.setAttribute('aria-pressed', editState.blocked[time] ? 'true' : 'false');
      });
      chips.appendChild(chip);
    });
    showEditPart('form-block');
  }

  function checkedValue(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : 'day';
  }

  /**
   * Sends a change. If it would take a slot from a booked patient, the
   * server asks first; we show the list and send it again once confirmed.
   */
  function saveChange(change, button) {
    change.date = editState.date;
    button.disabled = true;
    return call('changeDayAvailability', state.token, state.deviceId, change)
      .then(function (r) {
        if (r.needsConfirm) {
          var lines = r.affected.map(function (a) {
            return '• ' + a.name + ', ' + a.dateLabel + ' ' + to12h(a.time);
          }).join('\n');
          var question = r.affected.length + (r.affected.length === 1 ? ' booking is' : ' bookings are') +
            ' affected:\n' + lines + '\n\nSave anyway? You can message these patients next.';
          if (!confirm(question)) return null;
          change.confirmed = true;
          return call('changeDayAvailability', state.token, state.deviceId, change);
        }
        return r;
      })
      .then(function (r) {
        if (!r) return;
        closeEdit();
        $('day-msg').textContent = r.message;
        showAffected(r.affected || []);
        return loadDay();
      })
      .catch(handleError)
      .then(function () { button.disabled = false; });
  }

  /* ---------- Patients to contact (WhatsApp) ---------- */

  function whatsappMessage(a) {
    // Draft wording: to be confirmed with the clinic (Open questions in the spec).
    return 'Hello ' + a.name + ', this is a message from the clinic. Your appointment on ' +
      a.dateLabel + ' at ' + to12h(a.time) + ' needs to be changed because the doctor is not ' +
      'available at that time. Please reply to this message or call us to choose a new time. Thank you.';
  }

  /** wa.me needs the number with the country code (91 for India) and digits only. */
  function whatsappLink(mobile, text) {
    var digits = String(mobile || '').replace(/\D/g, '');
    if (digits.length === 10) digits = '91' + digits;
    if (!/^91\d{10}$/.test(digits)) return null;
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text);
  }

  function copyText(text, button) {
    var done = function () {
      button.textContent = 'Copied ✓';
      setTimeout(function () { button.textContent = 'Copy message'; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { prompt('Copy this message:', text); });
    } else {
      prompt('Copy this message:', text);
    }
  }

  function showAffected(list) {
    var ul = $('affected-list');
    ul.textContent = '';
    $('affected').hidden = list.length === 0;
    list.forEach(function (a) {
      var text = whatsappMessage(a);
      var li = document.createElement('li');
      li.appendChild(textEl('div', a.name, 'title'));
      li.appendChild(textEl('div', a.dateLabel + ', ' + to12h(a.time), 'muted'));
      li.appendChild(textEl('div', 'Mobile: ' + (a.mobile || 'not recorded'), 'muted'));
      var actions = document.createElement('div');
      actions.className = 'affected-actions';
      var link = whatsappLink(a.mobile, text);
      if (link) {
        var wa = textEl('a', 'WhatsApp', 'btn small whatsapp');
        wa.href = link;
        wa.target = '_blank';
        wa.rel = 'noopener';
        actions.appendChild(wa);
      }
      var copy = textEl('button', 'Copy message', 'btn small');
      copy.type = 'button';
      copy.addEventListener('click', function () { copyText(text, copy); });
      actions.appendChild(copy);
      li.appendChild(actions);
      ul.appendChild(li);
    });
  }

  $('day-edit').addEventListener('click', openEdit);
  $('edit-hours').addEventListener('click', openHours);
  $('edit-block').addEventListener('click', openBlock);
  $('edit-close').addEventListener('click', function () { $('close-note').value = ''; showEditPart('form-close'); });
  Array.prototype.forEach.call(document.querySelectorAll('.edit-back'), function (b) {
    b.addEventListener('click', function () { showEditPart('edit-menu'); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.edit-cancel'), function (b) {
    b.addEventListener('click', closeEdit);
  });
  $('affected-done').addEventListener('click', function () { $('affected').hidden = true; });

  $('form-hours').addEventListener('submit', function (e) {
    e.preventDefault();
    saveChange({ action: 'hours', scope: checkedValue('hours-scope'),
                 start: $('hours-start').value, end: $('hours-end').value },
               e.submitter || $('form-hours').querySelector('[type=submit]'));
  });
  $('form-block').addEventListener('submit', function (e) {
    e.preventDefault();
    var blocked = Object.keys(editState.blocked).filter(function (t) { return editState.blocked[t]; });
    saveChange({ action: 'blocked', scope: checkedValue('block-scope'), blocked: blocked },
               e.submitter || $('form-block').querySelector('[type=submit]'));
  });
  $('form-close').addEventListener('submit', function (e) {
    e.preventDefault();
    saveChange({ action: 'close', scope: 'day', note: $('close-note').value },
               e.submitter || $('form-close').querySelector('[type=submit]'));
  });
  $('edit-reopen').addEventListener('click', function () {
    saveChange({ action: 'reopen', scope: 'day' }, $('edit-reopen'));
  });
  $('edit-undo').addEventListener('click', function () {
    if (!confirm('Undo this "from now on" change? Every day from this date goes back to how it was before.')) return;
    saveChange({ action: 'undoFromNow', scope: 'day' }, $('edit-undo'));
  });
  $('edit-reset').addEventListener('click', function () {
    if (!confirm('Undo the changes made to this day only, and go back to the clinic\'s normal slots?')) return;
    saveChange({ action: 'reset', scope: 'day' }, $('edit-reset'));
  });

  // Keep every device up to date: every 60 seconds, and when the app is
  // opened again after being in the background.
  setInterval(function () {
    if (!$('screen-day').hidden && document.visibilityState === 'visible') loadDay();
  }, 60 * 1000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !$('screen-day').hidden) loadDay();
  });

  /* ---------- Start ---------- */

  state.deviceId = load(KEY_DEVICE);
  if (!state.deviceId) {
    state.deviceId = newDeviceId();
    if (!save(KEY_DEVICE, state.deviceId)) {
      banner('This browser is not allowing the app to remember this device. ' +
             'You may need to log in each time. Try another browser.');
    }
  }
  state.token = load(KEY_TOKEN);

  if (!state.token) {
    showPin();
  } else {
    call('getSession', state.token, state.deviceId)
      .then(function (r) {
        if (r.ok) showHome(r);
        else { clearToken(); showPin(); }
      })
      .catch(function (err) { show('pin'); handleError(err); });
  }
})();
