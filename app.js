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
    ['loading', 'pin', 'pending', 'day', 'book', 'search', 'detail', 'unresolved', 'devices'].forEach(function (n) {
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
        // "Change status": shown once each time the app is opened, until resolved.
        if (data.unresolvedCount > 0 && !view.promptedUnresolved && !$('screen-day').hidden) {
          view.promptedUnresolved = true;
          openUnresolved();
        }
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
    var isPast = !!day.past;

    $('day-label').textContent = (isToday ? 'Today · ' : isPast ? 'Past · ' : '') + day.label;
    $('day-picker').min = data.days[0].date;
    $('day-picker').max = data.days[data.days.length - 1].date;
    $('day-picker').value = day.date;
    $('day-prev').disabled = index === 0;
    $('day-next').disabled = index === data.days.length - 1;
    $('day-today').hidden = isToday;
    $('day-walkin').hidden = !(isToday && day.open);
    $('day-extra').hidden = !day.open || isPast;
    $('day-unresolved').hidden = !data.unresolvedCount;
    $('day-unresolved').textContent = '⚠ Needs status (' + data.unresolvedCount + ')';
    // A message belongs to the day it was shown on.
    if (view.shownDate && view.shownDate !== day.date) $('day-msg').textContent = '';
    view.shownDate = day.date;
    // Edit is offered on working days and on days that already have changes.
    $('day-edit').hidden = isPast || !(day.workingDay || day.custom);
    if (editState.date && editState.date !== day.date) closeEdit();

    if (isPast) {
      renderPastDay(day);
      return;
    }
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
    var noShowAt = {};
    (day.noShows || []).forEach(function (n) { if (n.type === 'regular') noShowAt[n.time] = n; });
    var rowInfo = { isToday: isToday, now: now, grace: day.graceMinutes || 0, noShowAt: noShowAt };
    day.rows.forEach(function (row) {
      // A slot that has already started is never offered, even today.
      // The exception: a no-show's slot that is still running can go to a walk-in.
      // Rows with a booking are always shown.
      var empty = row.kind === 'free' || row.kind === 'unavailable';
      var started = isToday && toMinutes(row.time) <= now;
      var walkInGap = row.kind === 'free' && started && noShowAt[row.time] &&
        toMinutes(row.time) + day.slotMinutes > now;
      if (started && empty && !walkInGap) return;
      var li = slotRow(row, rowInfo);
      if (row.kind === 'free') makeBookable(li, day.date, row.time, walkInGap ? 'walk-in' : 'phone');
      list.appendChild(li);
      shown++;
    });

    if (!day.open && shown > 0) {
      list.insertBefore(textEl('li', 'These bookings are on a closed day. They need to be moved.', 'slot-warning'), list.firstChild);
    } else if (day.open && shown === 0) {
      list.appendChild(textEl('li', isToday ? 'No more slots today.' : 'No slots on this day.', 'slot-empty'));
    }
  }

  function slotRow(row, info) {
    info = info || {};
    var li = document.createElement('li');
    li.className = 'slot ' + row.kind;
    li.appendChild(textEl('span', to12h(row.time), 'slot-time'));
    var body = document.createElement('span');
    body.className = 'slot-body';
    if (row.kind === 'free') {
      body.appendChild(textEl('span', 'Free', 'slot-free'));
      var gone = info.noShowAt && info.noShowAt[row.time];
      if (gone) body.appendChild(textEl('span', 'No-show: ' + gone.name, 'noshow-note'));
    } else if (row.kind === 'unavailable') {
      body.appendChild(textEl('span', 'Unavailable', 'slot-muted'));
    } else {
      row.bookings.forEach(function (b) {
        var line = textEl('div', b.name, 'slot-name');
        // Tap a booked name to open the booking.
        line.dataset.id = b.id;
        line.addEventListener('click', function () { openDetail(b.id, 'day'); });
        line.appendChild(textEl('span', b.status === 'arrived' ? 'Arrived' : 'Booked', 'pill ' + b.status));
        var late = info.isToday && b.status === 'booked' && info.now >= toMinutes(b.time) + info.grace;
        if (late) line.appendChild(textEl('span', 'Late', 'pill late'));
        if (row.kind === 'extra') line.appendChild(textEl('span', 'Extra', 'pill extra'));
        if (row.kind === 'offgrid') line.appendChild(textEl('span', 'Off-grid', 'pill offgrid'));
        body.appendChild(line);
        // Today: quick buttons. No-show appears once the grace period has passed.
        if (info.isToday && b.status === 'booked') {
          var actions = document.createElement('div');
          actions.className = 'row-actions';
          actions.appendChild(quickStatus(b, 'arrived', '✓ Arrived', 'arrive'));
          if (late) actions.appendChild(quickStatus(b, 'no-show', 'No-show', 'noshow'));
          body.appendChild(actions);
        }
      });
    }
    li.appendChild(body);
    return li;
  }

  /**
   * An earlier day: view only. Every booking with its status (including
   * No-show and Cancelled); tap a name to open it and correct its status.
   */
  function renderPastDay(day) {
    $('day-hours').textContent = 'Earlier day, view only. Tap a name to correct its status.';
    var list = $('slot-list');
    list.textContent = '';
    var all = [];
    day.rows.forEach(function (row) {
      row.bookings.forEach(function (b) { all.push({ b: b, kind: row.kind }); });
    });
    (day.noShows || []).concat(day.cancelled || []).forEach(function (b) { all.push({ b: b, kind: 'other' }); });
    all.sort(function (x, y) { return x.b.time < y.b.time ? -1 : x.b.time > y.b.time ? 1 : 0; });
    if (!all.length) {
      list.appendChild(textEl('li', 'No bookings on this day.', 'slot-empty'));
      return;
    }
    all.forEach(function (item) {
      var b = item.b;
      var li = document.createElement('li');
      li.className = 'slot past';
      li.appendChild(textEl('span', to12h(b.time), 'slot-time'));
      var body = document.createElement('span');
      body.className = 'slot-body';
      var line = textEl('div', b.name, 'slot-name');
      line.dataset.id = b.id;
      line.addEventListener('click', function () { openDetail(b.id, 'day'); });
      line.appendChild(textEl('span', statusLabel(b.status), 'pill ' + b.status));
      if (b.status === 'booked') line.appendChild(textEl('span', 'Needs status', 'pill late'));
      if (b.type === 'extra') line.appendChild(textEl('span', 'Extra', 'pill extra'));
      body.appendChild(line);
      li.appendChild(body);
      list.appendChild(li);
    });
  }

  /** A small Arrived / No-show button on a day-view row. */
  function quickStatus(b, status, label, style) {
    var button = textEl('button', label, 'btn small ' + style);
    button.type = 'button';
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (status === 'no-show' && !confirm('Mark ' + b.name + ' as No-show?')) return;
      button.disabled = true;
      call('setBookingStatus', state.token, state.deviceId, b.id, status)
        .then(function (r) {
          $('day-msg').textContent = r.ok ? r.message : 'Someone else is booked in that slot now.';
          return loadDay();
        })
        .catch(function (err) { button.disabled = false; handleError(err); });
    });
    return button;
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

  /* ---------- New booking ---------- */

  var booking = { draft: null, saving: false };

  /** A free slot row: tap it (or press Enter) to book it. */
  function makeBookable(li, date, time, channel) {
    channel = channel || 'phone';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', 'Book ' + to12h(time));
    li.appendChild(textEl('span', channel === 'walk-in' ? 'Walk-in ›' : 'Book ›', 'slot-book'));
    li.addEventListener('click', function () { openBooking(date, time, channel); });
    li.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') openBooking(date, time, channel);
    });
  }

  function showBookPart(part) {
    $('book-form').hidden = part !== 'form';
    $('book-confirm').hidden = part !== 'confirm';
    $('book-done').hidden = part !== 'done';
  }

  /**
   * mode: 'regular' (a free slot), 'extra' (urgent, any time) or
   * 'paper' (written on paper while the app was down).
   */
  function openBooking(date, time, channel, mode) {
    mode = mode || 'regular';
    var day = view.data.days.filter(function (d) { return d.date === date; })[0];
    booking.draft = { date: date, time: time, mode: mode };
    booking.conflict = '';
    $('book-title').textContent = mode === 'extra' ? 'Extra booking' : mode === 'paper' ? 'Paper booking'
      : channel === 'walk-in' ? 'Walk-in' : 'New booking';
    $('book-slot').textContent = (day ? day.label : date) + ', ' + to12h(time);
    $('book-slot').hidden = mode === 'paper';
    $('book-when').hidden = mode === 'regular';
    $('book-date-label').hidden = mode !== 'paper';
    $('book-status-box').hidden = mode !== 'paper';
    $('book-mode-note').hidden = mode === 'regular';
    $('book-mode-note').textContent = mode === 'extra'
      ? 'For urgent patients, outside the normal slots. Any time from 6 am to 11 pm.'
      : mode === 'paper' ? 'For bookings written on paper while the app was down (up to 7 days back).' : '';
    if (mode !== 'regular') {
      fillTimes5($('book-time'), time);
      if (mode === 'paper') {
        // A calendar from 7 days back to the end of the booking window.
        $('book-date').min = view.data.days[0].date;
        $('book-date').max = view.data.days[view.data.days.length - 1].date;
        $('book-date').value = view.data.today;
        document.querySelector('input[name="book-status"][value="arrived"]').checked = true;
        updatePaperStatus();
      }
      $('book-future-note').hidden = true;
    }
    $('book-name').value = '';
    $('book-mobile').value = '';
    $('book-cc').value = '91';
    $('book-cc-other').value = '';
    $('book-cc-other').hidden = true;
    $('taken-overlay').hidden = true;
    $('book-comments').value = '';
    $('book-count').textContent = '0 / 200';
    $('book-msg').textContent = '';
    var reasons = $('book-reason');
    reasons.textContent = '';
    reasons.appendChild(new Option('Pick a reason', ''));
    (view.data.reasons || []).forEach(function (r) { reasons.appendChild(new Option(r, r)); });
    document.querySelector('input[name="book-channel"][value="' + channel + '"]').checked = true;
    showBookPart('form');
    show('book');
    window.scrollTo(0, 0);
    $('book-name').focus();
  }

  function backToDay(message) {
    show('day');
    $('day-msg').textContent = message || '';
    loadDay();
  }

  /** Walk-in: today's next free slot (one that hasn't started yet). */
  $('day-walkin').addEventListener('click', function () {
    var today = view.data.days.filter(function (d) { return d.date === view.data.today; })[0];
    var now = nowInIndia().minutes;
    var next = today && today.rows.filter(function (r) {
      return r.kind === 'free' && toMinutes(r.time) > now;
    })[0];
    if (!next) {
      $('day-msg').textContent = 'No free slots left today. Use "+ Extra booking" for an urgent patient, or pick another day.';
      return;
    }
    openBooking(today.date, next.time, 'walk-in');
  });

  $('book-comments').addEventListener('input', function () {
    $('book-count').textContent = $('book-comments').value.length + ' / 200';
  });

  /** Step 1 → 2: the server checks the details and sends back any warnings. */
  $('book-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var mode = booking.draft.mode;
    var draft = {
      mode: mode,
      date: mode === 'paper' ? $('book-date').value : booking.draft.date,
      time: mode === 'regular' ? booking.draft.time : $('book-time').value,
      status: mode !== 'paper' ? undefined
        : $('book-status-box').hidden ? 'booked' : document.querySelector('input[name="book-status"]:checked').value,
      name: $('book-name').value.trim(),
      countryCode: $('book-cc').value === 'other' ? $('book-cc-other').value.replace(/\D/g, '') : $('book-cc').value,
      mobile: $('book-mobile').value.trim(),
      reason: $('book-reason').value,
      comments: $('book-comments').value.trim(),
      channel: document.querySelector('input[name="book-channel"]:checked').value
    };
    if (!draft.name) { $('book-msg').textContent = 'Enter the patient\'s name.'; return; }
    if (!draft.reason) { $('book-msg').textContent = 'Pick a visit reason.'; return; }
    if ($('book-cc').value === 'other' && !draft.countryCode) {
      $('book-msg').textContent = 'Type the country code, for example 49 for Germany.';
      return;
    }
    $('book-msg').textContent = '';
    busy($('book-next'), true);
    call('checkBooking', state.token, state.deviceId, draft)
      .then(function (r) {
        booking.draft = draft;
        showConfirm(r.booking, r.warnings);
      })
      .catch(function (err) { bookingError(err, $('book-msg')); })
      .then(function () { busy($('book-next'), false); });
  });

  function showConfirm(b, warnings) {
    $('confirm-mobile').textContent = b.mobile ? spacedPhone(b.mobile) : 'No number';
    var mw = $('confirm-mobile-warning');
    mw.hidden = !warnings.mobile;
    mw.textContent = warnings.mobile === 'missing'
      ? 'You have not entered the mobile number. Go back and enter it if you can.'
      : (b.mobile.indexOf('+91 ') === 0
        ? 'This doesn\'t look like a 10-digit Indian mobile number. Please check it.'
        : 'This number looks too short or too long. Please check it.');
    var up = $('confirm-upcoming');
    up.hidden = warnings.upcoming.length === 0;
    up.textContent = 'This number already has ' + warnings.upcoming.length + ' upcoming booking' +
      (warnings.upcoming.length === 1 ? '' : 's') + ': ' + warnings.upcoming.map(function (u) {
        return u.dateLabel + ' ' + to12h(u.time);
      }).join(', ') + '. You can still save.';

    booking.conflict = warnings.paperConflict || '';
    var cw = $('confirm-conflict');
    cw.hidden = !booking.conflict;
    cw.textContent = 'The ' + to12h(b.time) + ' slot already has ' + booking.conflict +
      ' in the app. This paper booking will be saved as an extra booking.';

    var dl = $('confirm-details');
    dl.textContent = '';
    var rows = [['Patient', b.name], ['When', b.dateLabel + ', ' + to12h(b.time) + (b.slotType === 'extra' ? ' (extra)' : '')],
     ['Reason', b.reason], ['How', b.channel === 'walk-in' ? 'Walk-in' : 'Phone call'], ['Comments', b.comments || '–']];
    if (b.mode === 'paper') {
      rows.splice(2, 0, ['Status', b.status === 'booked' ? 'Booked (visit not yet happened)' : statusLabel(b.status) + ' (from paper)']);
    }
    rows
      .forEach(function (pair) {
        dl.appendChild(textEl('dt', pair[0]));
        dl.appendChild(textEl('dd', pair[1]));
      });
    $('confirm-save').textContent = warnings.mobile ? 'Save anyway' : 'Save booking';
    $('confirm-msg').textContent = '';
    showBookPart('confirm');
    window.scrollTo(0, 0);
  }

  /** Step 2 → 3: save. The server checks the slot is still free, inside a lock. */
  $('confirm-save').addEventListener('click', function () {
    if (booking.saving) return;
    booking.saving = true;
    busy($('confirm-save'), true);
    var draft = Object.assign({}, booking.draft, { confirmExtra: !!booking.conflict });
    call('createBooking', state.token, state.deviceId, draft)
      .then(function (r) {
        if (!r.ok && r.reason === 'paper_conflict') {
          $('confirm-msg').textContent = 'That slot now has ' + r.name + '. Go back and check the time.';
          return;
        }
        if (!r.ok && r.reason === 'slot_taken') {
          // Shown right here, in red, until they tap "Pick another slot".
          showTaken('Someone else booked ' + $('book-slot').textContent + ' a moment ago.', function () {
            backToDay('');
          });
          return;
        }
        $('done-id').textContent = (booking.draft.mode === 'paper' ? 'Saved: ' : 'Booked: ') + r.id;
        $('done-text').textContent = r.name + ', ' + r.dateLabel + ' at ' + to12h(r.time) +
          (r.slotType === 'extra' ? ' (extra)' : '') + (booking.draft.mode === 'paper' ? ', ' + statusLabel(r.status) : '') + '.';
        showBookPart('done');
      })
      .catch(function (err) { bookingError(err, $('confirm-msg')); })
      .then(function () {
        booking.saving = false;
        busy($('confirm-save'), false);
      });
  });

  /** Booking errors show next to the form. A lost login still goes to the PIN screen. */
  function bookingError(err, el) {
    var message = (err && err.message) || String(err);
    if (message.indexOf('NOT_LOGGED_IN') !== -1) { handleError(err); return; }
    el.textContent = message;
  }

  $('confirm-edit').addEventListener('click', function () { showBookPart('form'); });
  /** The red "Slot already taken" box in the middle of the screen. */
  var takenThen = null;
  function showTaken(detailText, then) {
    $('taken-detail').textContent = detailText;
    takenThen = then;
    $('taken-overlay').hidden = false;
    $('taken-ok').focus();
  }
  $('taken-ok').addEventListener('click', function () {
    $('taken-overlay').hidden = true;
    if (takenThen) takenThen();
  });
  $('book-cc').addEventListener('change', function () {
    $('book-cc-other').hidden = $('book-cc').value !== 'other';
    if (!$('book-cc-other').hidden) $('book-cc-other').focus();
  });

  /** "+91 9876543210" → "+91 98765 43210" (easier to read back). */
  function spacedPhone(phone) {
    var m = String(phone).match(/^(\+\d+) (\d+)$/);
    if (!m) return phone;
    var n = m[2].length === 10 ? m[2].replace(/(\d{5})(\d{5})/, '$1 $2') : m[2].replace(/(\d{3})(?=\d{3})/g, '$1 ');
    return m[1] + ' ' + n;
  }
  $('book-back').addEventListener('click', function () { backToDay(''); });
  $('done-back').addEventListener('click', function () { backToDay(''); });

  /* ---------- Extra and paper bookings ---------- */

  /** Time choices every 5 minutes from 6:00 am to 11:00 pm. */
  function fillTimes5(select, selected) {
    select.textContent = '';
    for (var m = 6 * 60; m <= 23 * 60; m += 5) {
      var hhmm = ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
      select.appendChild(new Option(to12h(hhmm), hhmm));
    }
    select.value = selected;
  }

  /** "2026-11-16" + 1 → "2026-11-17" (calendar dates only, no time zone). */
  function addDaysLocal(date, days) {
    var p = date.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days, 12));
    return d.toISOString().slice(0, 10);
  }

  /** "2026-11-14" → "Sat 14 Nov" */
  function shortDate(date) {
    var p = date.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
      .format(new Date(Date.UTC(p[0], p[1] - 1, p[2], 12))).replace(',', '');
  }

  /** The next 5-minute mark from now (for an urgent extra booking today). */
  function nextFiveMinutes() {
    var m = Math.min(23 * 60, Math.max(6 * 60, Math.ceil(nowInIndia().minutes / 5) * 5));
    return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
  }

  $('day-extra').addEventListener('click', function () {
    var isToday = view.date === view.data.today;
    openBooking(view.date, isToday ? nextFiveMinutes() : '19:00', 'phone', 'extra');
  });
  $('day-paper').addEventListener('click', function () {
    openBooking(view.data.today, '16:00', 'phone', 'paper');
  });
  /**
   * Paper booking: a visit that hasn't happened yet is saved as Booked, so
   * the "status written on the paper" choice is only shown for past visits.
   */
  function updatePaperStatus() {
    if (!booking.draft || booking.draft.mode !== 'paper') return;
    var date = $('book-date').value;
    var future = date > view.data.today ||
      (date === view.data.today && toMinutes($('book-time').value) > nowInIndia().minutes);
    $('book-status-box').hidden = future;
    $('book-future-note').hidden = !future;
  }
  $('book-date').addEventListener('change', updatePaperStatus);
  $('book-time').addEventListener('change', updatePaperStatus);

  $('book-time').addEventListener('change', function () {
    if (booking.draft && booking.draft.mode === 'extra') {
      var day = view.data.days.filter(function (d) { return d.date === booking.draft.date; })[0];
      $('book-slot').textContent = (day ? day.label : booking.draft.date) + ', ' + to12h($('book-time').value);
    }
  });

  /* ---------- "These bookings still need a status" ---------- */

  function openUnresolved() {
    show('unresolved');
    window.scrollTo(0, 0);
    $('unresolved-done').hidden = true;
    $('unresolved-later').textContent = 'Later';
    var ul = $('unresolved-list');
    ul.textContent = '';
    call('getUnresolved', state.token, state.deviceId)
      .then(function (list) {
        if (!list.length) { unresolvedFinished(); return; }
        list.forEach(function (u) {
          var li = document.createElement('li');
          li.appendChild(textEl('div', u.name, 'title'));
          li.appendChild(textEl('div', u.dateLabel + ', ' + to12h(u.time) + ' · ' + u.id, 'muted'));
          var actions = document.createElement('div');
          actions.className = 'affected-actions';
          [['arrived', 'Arrived', 'arrive'], ['no-show', 'No-show', 'noshow'], ['cancelled', 'Cancelled', '']]
            .forEach(function (choice) {
              var button = textEl('button', choice[1], 'btn small ' + choice[2]);
              button.type = 'button';
              button.addEventListener('click', function () {
                Array.prototype.forEach.call(actions.children, function (x) { x.disabled = true; });
                call('setBookingStatus', state.token, state.deviceId, u.id, choice[0])
                  .then(function () {
                    li.remove();
                    if (!ul.children.length) unresolvedFinished();
                  })
                  .catch(function (err) {
                    Array.prototype.forEach.call(actions.children, function (x) { x.disabled = false; });
                    handleError(err);
                  });
              });
              actions.appendChild(button);
            });
          li.appendChild(actions);
          ul.appendChild(li);
        });
      })
      .catch(handleError);
  }

  /** Nothing left: say so, and the button just goes back. */
  function unresolvedFinished() {
    $('unresolved-done').hidden = false;
    $('unresolved-later').textContent = 'Back to day view';
  }

  $('day-unresolved').addEventListener('click', openUnresolved);
  $('unresolved-later').addEventListener('click', function () { backToDay(''); });

  /* ---------- Search ---------- */

  var search = { list: null, loading: false };

  function openSearch() {
    show('search');
    $('search-input').value = '';
    $('search-results').textContent = '';
    $('search-hint').hidden = false;
    loadSearchList().then(function () { $('search-input').focus(); });
  }

  /** The upcoming bookings, loaded once when Search opens; typing filters them instantly. */
  function loadSearchList() {
    search.loading = true;
    return call('searchBookings', state.token, state.deviceId)
      .then(function (r) { search.list = r.bookings; runSearch(); })
      .catch(handleError)
      .then(function () { search.loading = false; });
  }

  function runSearch() {
    var q = $('search-input').value.trim();
    var digits = q.replace(/\D/g, '');
    var isNumber = digits.length >= 3 && digits.length >= q.replace(/[\s+\-()]/g, '').length;
    var ul = $('search-results');
    ul.textContent = '';
    if (!search.list || (!isNumber && q.length < 2)) { $('search-hint').hidden = false; return; }
    $('search-hint').hidden = true;
    var words = q.toLowerCase();
    var found = search.list.filter(function (b) {
      if (isNumber) return String(b.mobile).replace(/\D/g, '').indexOf(digits) !== -1;
      return b.name.toLowerCase().indexOf(words) !== -1;
    });
    if (!found.length) {
      ul.appendChild(textEl('li', 'No bookings found (searches 7 days back onward).', 'muted'));
      return;
    }
    found.slice(0, 50).forEach(function (b) {
      var li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      var title = textEl('div', b.name, 'title');
      title.appendChild(textEl('span', statusLabel(b.status), 'pill ' + b.status));
      li.appendChild(title);
      li.appendChild(textEl('div', b.dateLabel + ', ' + to12h(b.time) + ' · ' + (b.mobile || 'no number') + ' · ' + b.id, 'when'));
      li.addEventListener('click', function () { openDetail(b.id, 'search', b); });
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter') openDetail(b.id, 'search', b); });
      ul.appendChild(li);
    });
  }

  function statusLabel(status) {
    return { booked: 'Booked', arrived: 'Arrived', cancelled: 'Cancelled', 'no-show': 'No-show' }[status] || status;
  }

  $('day-search').addEventListener('click', openSearch);
  $('search-input').addEventListener('input', runSearch);
  $('search-back').addEventListener('click', function () { backToDay(''); });

  /* ---------- Booking details: edit, reschedule, cancel, undo cancel ---------- */

  var detail = { booking: null, from: 'day' };

  /** Opens a booking. `known` is the booking from the search list, if we have it. */
  function openDetail(id, from, known) {
    detail.from = from;
    $('detail-msg').textContent = '';
    $('detail-notify').hidden = true;
    show('detail');
    window.scrollTo(0, 0);
    if (known) { renderDetail(known); return; }
    $('detail-info').textContent = '';
    $('detail-title').textContent = id;
    call('getBooking', state.token, state.deviceId, id).then(renderDetail).catch(handleError);
  }

  function renderDetail(b) {
    detail.booking = b;
    $('detail-title').textContent = b.id;
    var dl = $('detail-info');
    dl.textContent = '';
    var statusDd;
    [['Patient', b.name], ['Mobile', b.mobile ? spacedPhone(b.mobile) : 'Not recorded'],
     ['When', b.dateLabel + ', ' + to12h(b.time) + (b.type === 'extra' ? ' (extra)' : '')],
     ['Status', ''], ['Reason', b.reason], ['Comments', b.comments || '–'],
     ['Booked', (b.channel === 'walk-in' ? 'Walk-in' : 'Phone') + ', ' + b.createdAt + ' by ' + b.createdBy]]
      .forEach(function (pair) {
        dl.appendChild(textEl('dt', pair[0]));
        var dd = textEl('dd', pair[1]);
        if (pair[0] === 'Status') { statusDd = dd; dd.appendChild(textEl('span', statusLabel(b.status), 'pill ' + b.status)); }
        dl.appendChild(dd);
      });

    var past = b.date < view.data.today;
    $('detail-past').hidden = !past;
    $('act-edit').hidden = past;
    $('act-move').hidden = past || !(b.status === 'booked' || b.status === 'no-show');
    $('act-cancel').hidden = past || b.status !== 'booked';
    $('act-restore').hidden = past || b.status !== 'cancelled';
    // Check-in: today's booked patients. Correct status: today and earlier days.
    $('act-arrived').hidden = !(b.status === 'booked' && b.date === view.data.today);
    $('act-status').hidden = b.date > view.data.today;
    $('detail-actions').hidden = false;
    $('edit-form').hidden = true;
    $('move-panel').hidden = true;
    $('status-panel').hidden = true;
  }

  function closePanels() {
    $('edit-form').hidden = true;
    $('move-panel').hidden = true;
    $('status-panel').hidden = true;
    $('detail-actions').hidden = false;
  }

  // ----- Arrived and status corrections -----
  $('act-arrived').addEventListener('click', function () {
    runChange('setBookingStatus', ['arrived'], $('act-arrived'));
  });
  $('act-status').addEventListener('click', function () {
    var b = detail.booking;
    var box = $('status-choices');
    box.textContent = '';
    ['booked', 'arrived', 'no-show', 'cancelled'].forEach(function (st) {
      if (st === b.status) return;
      var button = textEl('button', statusLabel(st), 'btn small' +
        (st === 'arrived' ? ' arrive' : st === 'no-show' ? ' noshow' : ''));
      button.type = 'button';
      button.addEventListener('click', function () {
        if (!confirm('Change ' + b.name + ' from ' + statusLabel(b.status) + ' to ' + statusLabel(st) + '?')) return;
        runChange('setBookingStatus', [st], button);
      });
      box.appendChild(button);
    });
    $('detail-actions').hidden = true;
    $('detail-notify').hidden = true;
    $('status-panel').hidden = false;
  });

  /** Runs a change on the server and shows the result on this screen. */
  function runChange(fn, args, button, onDone) {
    $('detail-msg').textContent = '';
    button.disabled = true;
    return call.apply(null, [fn, state.token, state.deviceId, detail.booking.id].concat(args))
      .then(function (r) {
        search.list = null;   // reload the search list next time
        if (!r.ok && r.reason === 'slot_taken') {
          // Same red box as for a new booking; then pick from the refreshed free slots.
          showTaken('Someone else just booked that time.', function () { loadDay().then(fillMoveSlots); });
          loadDay().then(fillMoveSlots);
          return;
        }
        renderDetail(r.booking);
        $('detail-msg').className = 'msg ok';
        $('detail-msg').textContent = r.message;
        if (onDone) onDone(r);
        loadDay();
      })
      .catch(function (err) {
        $('detail-msg').className = 'msg';   // red for problems
        bookingError(err, $('detail-msg'));
      })
      .then(function () { button.disabled = false; });
  }

  /** WhatsApp and Copy buttons with a ready message for the patient. */
  function showNotify(text) {
    var link = whatsappLink(detail.booking.mobile, text);
    $('notify-wa').hidden = !link;
    if (link) $('notify-wa').href = link;
    $('notify-copy').onclick = function () { copyText(text, $('notify-copy')); };
    $('detail-notify').hidden = false;
  }

  $('detail-back').addEventListener('click', function () {
    if (detail.from === 'search') {
      show('search');
      if (!search.list) loadSearchList(); else runSearch();
    } else {
      backToDay('');
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.detail-close'), function (b) {
    b.addEventListener('click', closePanels);
  });

  // ----- Edit details -----
  function fillCountrySelect(select, code) {
    if (!select.options.length) {
      Array.prototype.forEach.call($('book-cc').options, function (o) { select.appendChild(new Option(o.text, o.value)); });
    }
    var known = Array.prototype.some.call(select.options, function (o) { return o.value === code; });
    select.value = known ? code : 'other';
    return known;
  }

  $('act-edit').addEventListener('click', function () {
    var b = detail.booking;
    var m = String(b.mobile).match(/^\+(\d+) (\d+)$/);
    var code = m ? m[1] : '91';
    var number = m ? m[2] : String(b.mobile).replace(/\D/g, '');
    var known = fillCountrySelect($('edit-cc'), code);
    $('edit-cc-other').hidden = known;
    $('edit-cc-other').value = known ? '' : code;
    $('edit-name').value = b.name;
    $('edit-mobile').value = number;
    var reasons = $('edit-reason');
    reasons.textContent = '';
    var list = (view.data.reasons || []).slice();
    if (list.indexOf(b.reason) === -1) list.unshift(b.reason);
    list.forEach(function (r) { reasons.appendChild(new Option(r, r)); });
    reasons.value = b.reason;
    $('edit-comments').value = b.comments;
    $('edit-msg').textContent = '';
    $('detail-actions').hidden = true;
    $('detail-notify').hidden = true;
    $('edit-form').hidden = false;
    $('edit-name').focus();
  });
  $('edit-cc').addEventListener('change', function () {
    $('edit-cc-other').hidden = $('edit-cc').value !== 'other';
  });
  $('edit-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var details = {
      name: $('edit-name').value.trim(),
      countryCode: $('edit-cc').value === 'other' ? $('edit-cc-other').value.replace(/\D/g, '') : $('edit-cc').value,
      mobile: $('edit-mobile').value.trim(),
      reason: $('edit-reason').value,
      comments: $('edit-comments').value.trim()
    };
    if (!details.name) { $('edit-msg').textContent = 'Enter the patient\'s name.'; return; }
    runChange('editBooking', [details], e.submitter || $('edit-form').querySelector('[type=submit]'), function (r) {
      if (r.mobileWarning) {
        $('detail-msg').textContent = r.message + ' Please check the mobile number: it looks ' +
          (r.mobileWarning === 'missing' ? 'empty.' : 'too short or too long.');
      }
    });
  });

  // ----- Reschedule -----
  $('act-move').addEventListener('click', function () {
    var select = $('move-date');
    select.textContent = '';
    view.data.days.forEach(function (d) {
      if (d.open) select.appendChild(new Option((d.date === view.data.today ? 'Today · ' : '') + d.label, d.date));
    });
    var current = detail.booking.date;
    select.value = Array.prototype.some.call(select.options, function (o) { return o.value === current; })
      ? current : (select.options[0] && select.options[0].value);
    $('move-msg').textContent = '';
    $('detail-actions').hidden = true;
    $('detail-notify').hidden = true;
    $('move-panel').hidden = false;
    fillMoveSlots();
  });
  $('move-date').addEventListener('change', fillMoveSlots);

  /** Free slots on the chosen day (not ones that have started). */
  function fillMoveSlots() {
    if ($('move-panel').hidden) return;
    var date = $('move-date').value;
    var day = view.data.days.filter(function (d) { return d.date === date; })[0];
    var now = nowInIndia().minutes;
    var free = day ? day.rows.filter(function (r) {
      return r.kind === 'free' && !(date === view.data.today && toMinutes(r.time) <= now);
    }) : [];
    var box = $('move-slots');
    box.textContent = '';
    $('move-none').hidden = free.length > 0;
    free.forEach(function (r) {
      var chip = textEl('button', to12h(r.time), 'chip');
      chip.type = 'button';
      chip.addEventListener('click', function () {
        var label = day.label + ' at ' + to12h(r.time);
        if (!confirm('Move ' + detail.booking.name + ' to ' + label + '?')) return;
        runChange('rescheduleBooking', [{ date: date, time: r.time }], chip, function (res) {
          showNotify('Hello ' + res.booking.name + ', your appointment at the clinic has been moved to ' +
            res.booking.dateLabel + ' at ' + to12h(res.booking.time) +
            '. Please reply if this time doesn\'t suit you. Thank you.');
        });
      });
      box.appendChild(chip);
    });
  }

  // ----- Cancel and undo cancel -----
  $('act-cancel').addEventListener('click', function () {
    var b = detail.booking;
    if (!confirm('Cancel ' + b.name + '\'s booking on ' + b.dateLabel + ' at ' + to12h(b.time) + '?')) return;
    runChange('cancelBooking', [], $('act-cancel'), function (r) {
      showNotify('Hello ' + r.booking.name + ', your appointment at the clinic on ' + r.booking.dateLabel +
        ' at ' + to12h(r.booking.time) + ' has been cancelled. Please call or message us if you would like ' +
        'a new time. Thank you.');
    });
  });
  $('act-restore').addEventListener('click', function () {
    runChange('restoreBooking', [], $('act-restore'));
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

  /**
   * wa.me needs the number with its country code, digits only.
   * "+971 501234567" → 971501234567. Older 10-digit numbers are Indian (91).
   */
  function whatsappLink(mobile, text) {
    var s = String(mobile || '').trim();
    var digits = s.replace(/\D/g, '');
    if (s.charAt(0) !== '+' && digits.length === 10) digits = '91' + digits;
    if (!/^\d{8,15}$/.test(digits)) return null;
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
