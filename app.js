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
    ['loading', 'pin', 'pending', 'day', 'book', 'search', 'detail', 'unresolved', 'settings', 'devices'].forEach(function (n) {
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

  /**
   * The app's own "Are you sure?" box in the middle of the screen (instead of
   * the browser's). Returns a Promise: true for Yes, false for No.
   *   ask({ title, text, yes: 'Yes, cancel', no: 'Keep it', danger: true })
   */
  var askDone = null;
  function ask(o) {
    if (askDone) askDone(false);
    $('ask-title').textContent = o.title;
    $('ask-text').textContent = o.text || '';
    $('ask-text').hidden = !o.text;
    $('ask-yes').textContent = o.yes || 'Yes';
    $('ask-no').textContent = o.no || 'Go back';
    $('ask-yes').className = 'btn primary' + (o.danger ? ' red' : '');
    $('ask-overlay').hidden = false;
    $('ask-no').focus();
    return new Promise(function (resolve) { askDone = resolve; });
  }
  function closeAsk(answer) {
    $('ask-overlay').hidden = true;
    var done = askDone;
    askDone = null;
    if (done) done(answer);
  }
  $('ask-yes').addEventListener('click', function () { closeAsk(true); });
  $('ask-no').addEventListener('click', function () { closeAsk(false); });
  $('ask-overlay').addEventListener('click', function (e) { if (e.target === $('ask-overlay')) closeAsk(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('ask-overlay').hidden) closeAsk(false);
    if (e.key === 'Escape' && !$('cal-sheet').hidden) $('cal-sheet').hidden = true;
  });

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
    $('btn-settings').hidden = session.role !== 'admin';
    setBadge(session.pendingDevices || 0);
    show('day');
    loadDay();
  }

  /** Devices waiting for approval: shown on Settings and on Manage devices. */
  function setBadge(count) {
    ['badge', 'badge-settings'].forEach(function (id) {
      $(id).textContent = count;
      $(id).hidden = !count;
    });
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
          return ask({ title: 'Remove "' + (d.name || d.description) + '"?', text: 'It will be logged out now.',
                       yes: 'Yes, remove', no: 'Keep it', danger: true })
            .then(function (yes) { return yes ? call('removeDevice', state.token, state.deviceId, d.id) : null; });
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
        if (!devices) { b.disabled = false; return; }
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
  $('devices-back').addEventListener('click', function () { openSettings(); });

  $('btn-logout-all').addEventListener('click', function () {
    ask({ title: 'Log out every other device?', text: 'They will need the PIN again.',
          yes: 'Yes, log out', no: 'Go back', danger: true }).then(function (yes) { if (yes) logoutAll(); });
  });
  function logoutAll() {
    var b = $('btn-logout-all');
    b.disabled = true;
    call('logoutAllDevices', state.token, state.deviceId)
      .then(function (r) { $('devices-msg').textContent = 'Logged out ' + r.loggedOut + ' session(s).'; })
      .catch(handleError)
      .then(function () { b.disabled = false; });
  }

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

    // "Today" / "Past" on a small line above the date, so it fits on a phone.
    $('day-label').textContent = '';
    $('day-label').appendChild(textEl('span', isToday ? 'Today' : isPast ? 'Past' : '\u00a0', 'day-kicker'));
    $('day-label').appendChild(textEl('span', day.label, 'day-main'));
    $('clinic-title').textContent = data.clinicName || 'Clinic booking';
    renderWeek();
    renderStats(day, isToday, isPast);
    $('day-today').hidden = isToday;
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
      }).join(', ');
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
    var nowShown = !isToday || !day.open;
    var nowLine = function () {
      var li = document.createElement('li');
      li.className = 'now-line';
      li.setAttribute('aria-label', 'Now');
      li.appendChild(textEl('span', 'NOW ' + nowInIndia().label.replace(/ (am|pm)$/, '')));
      li.appendChild(document.createElement('i'));
      return li;
    };
    day.rows.forEach(function (row) {
      // A slot that has already started is never offered, even today.
      // The exception: a no-show's slot that is still running can go to a walk-in.
      // Rows with a booking are always shown.
      var empty = row.kind === 'free' || row.kind === 'unavailable';
      var started = isToday && toMinutes(row.time) <= now;
      var walkInGap = row.kind === 'free' && started && noShowAt[row.time] &&
        toMinutes(row.time) + day.slotMinutes > now;
      if (started && empty && !walkInGap) return;
      if (!nowShown && toMinutes(row.time) > now) { list.appendChild(nowLine()); nowShown = true; }
      var li = slotRow(row, rowInfo);
      if (row.kind === 'free') makeBookable(li, day.date, row.time, walkInGap ? 'walk-in' : 'phone');
      list.appendChild(li);
      shown++;
    });
    if (!nowShown && shown > 0) list.appendChild(nowLine());

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
        if (b.channel === 'online') line.appendChild(textEl('span', 'Online', 'pill online'));
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
    // One booking in the slot: a › at the end opens it too.
    if (row.bookings && row.bookings.length === 1) {
      var open = textEl('span', '›', 'slot-open');
      open.setAttribute('aria-hidden', 'true');
      open.addEventListener('click', function () { openDetail(row.bookings[0].id, 'day'); });
      li.appendChild(open);
    }
    return li;
  }

  /** Four small counts above the list: slots, booked, arrived, free. */
  function renderStats(day, isToday, isPast) {
    var box = $('day-stats');
    box.textContent = '';
    box.hidden = isPast || !day.open;
    if (box.hidden) return;
    var now = nowInIndia().minutes;
    var counts = { slots: 0, booked: 0, arrived: 0, free: 0 };
    day.rows.forEach(function (r) {
      if (r.kind !== 'extra' && r.kind !== 'unavailable' && r.kind !== 'offgrid') counts.slots++;
      if (r.kind === 'free' && !(isToday && toMinutes(r.time) <= now)) counts.free++;
      (r.bookings || []).forEach(function (b) { counts[b.status === 'arrived' ? 'arrived' : 'booked']++; });
    });
    [['slots', 'slots'], ['booked', 'booked'], ['arrived', 'arrived'], ['free', 'free']].forEach(function (k) {
      var tile = document.createElement('div');
      tile.className = 'stat ' + k[0];
      tile.appendChild(textEl('b', String(counts[k[0]])));
      tile.appendChild(textEl('span', k[1]));
      box.appendChild(tile);
    });
  }

  /* ----- Week strip and calendar ----- */

  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
                'October', 'November', 'December'];

  /** 0 = Monday … 6 = Sunday, for a "2026-11-16" date. */
  function weekdayIndex(date) {
    var p = date.split('-').map(Number);
    return (new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).getUTCDay() + 6) % 7;
  }
  function dayInfo(date) {
    return view.data.days.filter(function (d) { return d.date === date; })[0];
  }
  function hasBookings(d) {
    return !!d && d.rows.some(function (r) { return r.bookings && r.bookings.length; });
  }
  function goToDate(date) {
    if (!dayInfo(date)) return;
    view.date = date;
    renderDay();
  }

  /**
   * Monday to Sunday of this week, all in the same format; a dot marks days
   * with bookings. The 8th block is a dull "+" that opens the calendar; when
   * a date outside this week is open, it shows that date instead.
   */
  function renderWeek() {
    var data = view.data;
    var monday = addDaysLocal(data.today, -weekdayIndex(data.today));
    var nav = $('week');
    nav.textContent = '';
    var inWeek = false;
    for (var i = 0; i < 7; i++) {
      var date = addDaysLocal(monday, i);
      var d = dayInfo(date);
      var on = date === view.date;
      if (on) inWeek = true;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wk' + (on ? ' on' : '') + (date === data.today ? ' today' : '') + (hasBookings(d) ? ' has' : '');
      b.disabled = !d;
      b.setAttribute('aria-label', shortDate(date) + (date === data.today ? ', today' : ''));
      if (on) b.setAttribute('aria-current', 'date');
      b.appendChild(textEl('span', DOW[i], 'wk-dow'));
      b.appendChild(textEl('span', String(Number(date.slice(8))), 'wk-num'));
      b.appendChild(textEl('span', '', 'wk-dot'));
      b.addEventListener('click', goToDate.bind(null, date));
      nav.appendChild(b);
    }
    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'wk plus' + (inWeek ? '' : ' on');
    plus.setAttribute('aria-label', inWeek ? 'Pick another date' : shortDate(view.date) + ', pick another date');
    if (inWeek) {
      plus.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';
    } else {
      plus.appendChild(textEl('span', DOW[weekdayIndex(view.date)], 'wk-dow'));
      plus.appendChild(textEl('span', String(Number(view.date.slice(8))), 'wk-num'));
      plus.appendChild(textEl('span', '', 'wk-dot'));
    }
    plus.addEventListener('click', function () { openCalendar(view.date.slice(0, 7)); });
    nav.appendChild(plus);
  }

  var cal = { month: null };   // "2026-11"

  function openCalendar(month) {
    cal.month = month;
    renderCalendar();
    $('cal-sheet').hidden = false;
  }

  function renderCalendar() {
    var data = view.data;
    var first = data.days[0].date.slice(0, 7);
    var last = data.days[data.days.length - 1].date.slice(0, 7);
    var p = cal.month.split('-').map(Number);
    $('cal-title').textContent = MONTHS[p[1] - 1] + ' ' + p[0];
    $('cal-prev').disabled = cal.month <= first;
    $('cal-next').disabled = cal.month >= last;
    var grid = $('cal-grid');
    grid.textContent = '';
    var start = cal.month + '-01';
    for (var b = 0; b < weekdayIndex(start); b++) grid.appendChild(textEl('span', '', 'cal-blank'));
    var daysInMonth = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    for (var n = 1; n <= daysInMonth; n++) {
      var date = cal.month + '-' + ('0' + n).slice(-2);
      var d = dayInfo(date);
      var button = textEl('button', String(n), 'cal-day' + (date === data.today ? ' today' : '') +
        (d && d.past ? ' past' : '') + (date === view.date ? ' on' : ''));
      button.type = 'button';
      button.disabled = !d;
      button.setAttribute('aria-label', shortDate(date));
      button.addEventListener('click', function (picked) {
        $('cal-sheet').hidden = true;
        goToDate(picked);
      }.bind(null, date));
      grid.appendChild(button);
    }
  }

  function shiftMonth(step) {
    var p = cal.month.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1 + step, 1));
    cal.month = d.toISOString().slice(0, 7);
    renderCalendar();
  }
  $('cal-prev').addEventListener('click', function () { shiftMonth(-1); });
  $('cal-next').addEventListener('click', function () { shiftMonth(1); });
  $('cal-close').addEventListener('click', function () { $('cal-sheet').hidden = true; });
  $('cal-sheet').addEventListener('click', function (e) { if (e.target === $('cal-sheet')) $('cal-sheet').hidden = true; });

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
      if (b.channel === 'online') line.appendChild(textEl('span', 'Online', 'pill online'));
      body.appendChild(line);
      li.appendChild(body);
      var open = textEl('span', '›', 'slot-open');
      open.setAttribute('aria-hidden', 'true');
      open.addEventListener('click', function () { openDetail(b.id, 'day'); });
      li.appendChild(open);
      list.appendChild(li);
    });
  }

  /** A small Arrived / No-show button on a day-view row. */
  function quickStatus(b, status, label, style) {
    var button = textEl('button', label, 'btn small ' + style);
    button.type = 'button';
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (status === 'no-show') {
        ask({ title: 'Mark ' + b.name + ' as No-show?', text: to12h(b.time) + '. Their slot becomes free.',
              yes: 'Yes, no-show', no: 'Go back', danger: true })
          .then(function (yes) { if (yes) send(); });
        return;
      }
      send();
    });
    function send() {
      button.disabled = true;
      call('setBookingStatus', state.token, state.deviceId, b.id, status)
        .then(function (r) {
          $('day-msg').textContent = r.ok ? r.message : 'Someone else is booked in that slot now.';
          return loadDay();
        })
        .catch(function (err) { button.disabled = false; handleError(err); });
    }
    return button;
  }

  $('day-today').addEventListener('click', function () { view.date = view.data.today; renderDay(); });

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
    $('book-title').textContent = mode === 'extra' ? 'Extra booking' : mode === 'paper' ? 'Written booking'
      : channel === 'walk-in' ? 'Walk-in' : 'New booking';
    $('book-slot').textContent = (day ? day.label : date) + ', ' + to12h(time);
    $('book-slot').hidden = mode === 'paper';
    $('book-when').hidden = mode === 'regular';
    $('book-date-label').hidden = mode !== 'paper';
    $('book-status-box').hidden = mode !== 'paper';
    $('book-mode-note').hidden = mode === 'regular';
    $('book-mode-note').textContent = mode === 'extra'
      ? 'For urgent patients, outside the normal slots. Any time from 6 am to 11 pm.'
      : mode === 'paper' ? 'For bookings written in the register while the app was down (up to 7 days back).' : '';
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
    // No visit reasons yet (the admin adds them in Settings): leave the field out.
    var noReasons = !(view.data.reasons || []).length;
    reasons.hidden = noReasons;
    $('book-reason-label').hidden = noReasons;
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
    if (!draft.reason && !$('book-reason').hidden) { $('book-msg').textContent = 'Pick a visit reason.'; return; }
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
     ['Reason', b.reason || '–'], ['How', channelLabel(b.channel)], ['Comments', b.comments || '–']];
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
      if (b.channel === 'online') title.appendChild(textEl('span', 'Online', 'pill online'));
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
  function channelLabel(channel) {
    return { 'walk-in': 'Walk-in', online: 'Online by patient' }[channel] || 'Phone call';
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
    $('detail-name').textContent = '';
    $('detail-when').textContent = '';
    $('detail-pills').textContent = '';
    $('detail-mobile').textContent = '';
    $('detail-wa').hidden = true;
    $('detail-title').textContent = 'Booking ' + id;
    call('getBooking', state.token, state.deviceId, id).then(renderDetail).catch(handleError);
  }

  function renderDetail(b) {
    detail.booking = b;
    $('detail-title').textContent = 'Booking ' + b.id;
    $('detail-name').textContent = b.name;
    $('detail-when').textContent = b.dateLabel + ' · ' + to12h(b.time);
    var pills = $('detail-pills');
    pills.textContent = '';
    pills.appendChild(textEl('span', statusLabel(b.status), 'pill ' + b.status));
    if (b.channel === 'online') pills.appendChild(textEl('span', 'Online', 'pill online'));
    if (b.type === 'extra') pills.appendChild(textEl('span', 'Extra', 'pill extra'));
    $('detail-mobile').textContent = b.mobile ? spacedPhone(b.mobile) : 'Not recorded';
    var chat = whatsappLink(b.mobile);
    $('detail-wa').hidden = !chat;
    if (chat) $('detail-wa').href = chat;
    var dl = $('detail-info');
    dl.textContent = '';
    var at = b.createdAt ? ' · ' + b.createdAt : '';
    var by = b.channel === 'online' ? 'Online by patient' + at
      : channelLabel(b.channel) + at + (b.createdBy ? ' by ' + b.createdBy : '');
    [['Reason', b.reason || '–'], ['Comments', b.comments || '–'], ['Booked', by]]
      .forEach(function (pair) {
        dl.appendChild(textEl('dt', pair[0]));
        dl.appendChild(textEl('dd', pair[1]));
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
        ask({ title: 'Change ' + b.name + ' to ' + statusLabel(st) + '?',
              text: 'It is ' + statusLabel(b.status) + ' now.', yes: 'Yes, change', no: 'Go back' })
          .then(function (yes) { if (yes) runChange('setBookingStatus', [st], button); });
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

  /** "Let the patient know": a WhatsApp button that opens an empty chat with them. */
  function showNotify() {
    var link = whatsappLink(detail.booking.mobile);
    $('notify-wa').hidden = !link;
    if (link) $('notify-wa').href = link;
    $('detail-notify').hidden = !link;
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
    if (b.reason && list.indexOf(b.reason) === -1) list.unshift(b.reason);
    list.forEach(function (r) { reasons.appendChild(new Option(r, r)); });
    reasons.value = b.reason;
    reasons.hidden = !list.length;
    $('edit-reason-label').hidden = !list.length;
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
        ask({ title: 'Move ' + detail.booking.name + '?', text: 'To ' + label + '.', yes: 'Yes, move', no: 'Go back' })
          .then(function (yes) {
            if (!yes) return;
            runChange('rescheduleBooking', [{ date: date, time: r.time }], chip, function (res) {
              showNotify();
            });
          });
      });
      box.appendChild(chip);
    });
  }

  // ----- Cancel and undo cancel -----
  $('act-cancel').addEventListener('click', function () {
    var b = detail.booking;
    ask({ title: 'Cancel ' + b.name + '\'s booking?', text: b.dateLabel + ' at ' + to12h(b.time) + '. The slot becomes free again.',
          yes: 'Yes, cancel', no: 'Keep it', danger: true })
      .then(function (yes) {
        if (!yes) return;
        runChange('cancelBooking', [], $('act-cancel'), function (r) {
          showNotify();
        });
      });
  });
  $('act-restore').addEventListener('click', function () {
    runChange('restoreBooking', [], $('act-restore'));
  });

  /* ---------- Settings (admin only) ---------- */

  var WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var settings = { data: null };

  function openSettings() {
    show('settings');
    window.scrollTo(0, 0);
    $('set-msg').textContent = '';
    $('set-affected').hidden = true;
    loadSettings();
  }

  function loadSettings() {
    return call('getClinicSettings', state.token, state.deviceId).then(renderSettings).catch(handleError);
  }

  function renderSettings(s) {
    settings.data = s;
    var c = s.current;
    $('set-clinic').value = c.clinicName;
    var wa = String(c.clinicWhatsapp || '').match(/^\+(\d+) (\d+)$/);
    var waKnown = fillCountrySelect($('set-wa-cc'), wa ? wa[1] : '91');
    $('set-wa-cc-other').hidden = waKnown;
    $('set-wa-cc-other').value = waKnown ? '' : (wa ? wa[1] : '');
    $('set-wa').value = wa ? wa[2] : '';

    var ticks = $('set-days');
    ticks.textContent = '';
    WEEK.forEach(function (d) {
      var label = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.value = d;
      box.checked = c.workingDays.indexOf(d) !== -1;
      label.appendChild(box);
      label.appendChild(document.createTextNode(d));
      ticks.appendChild(label);
    });
    $('set-days-from').min = s.today;
    $('set-days-from').value = s.today;

    var slot = $('set-slot');
    slot.textContent = '';
    [5, 10, 15, 20, 25, 30, 40, 45, 60].forEach(function (m) { slot.appendChild(new Option(m + ' minutes', m)); });
    slot.value = String(c.slotMinutes);
    $('set-slot-date').min = s.today;
    $('set-slot-date').max = s.lastDate;
    $('set-slot-date').value = s.today;

    $('set-grace').value = c.graceMinutes;
    $('set-window').value = c.bookingWindowDays;
    $('set-limit').value = c.maxUpcomingPerMobile;
    $('set-back').value = c.enteredLateMaxDays;

    var reasons = $('set-reasons');
    reasons.textContent = '';
    $('set-no-reasons').hidden = s.reasons.length > 0;
    s.reasons.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'reason-row';
      li.appendChild(textEl('span', r.reason, r.active ? '' : 'reason-off'));
      var buttons = document.createElement('span');
      buttons.className = 'reason-buttons';
      var toggle = textEl('button', r.active ? 'Switch off' : 'Switch on', 'btn small');
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        toggle.disabled = true;
        call('setReasonActive', state.token, state.deviceId, r.reason, !r.active)
          .then(function (res) { setMessage(res.message, true); loadDay(); return loadSettings(); })
          .catch(function (err) { toggle.disabled = false; settingsError(err); });
      });
      var remove = textEl('button', 'Remove', 'btn small danger-text');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        ask({ title: 'Remove "' + r.reason + '"?', text: 'Bookings that already have it keep it.',
              yes: 'Yes, remove', no: 'Keep it', danger: true }).then(function (yes) { if (yes) removeIt(); });
      });
      function removeIt() {
        remove.disabled = true;
        call('removeReason', state.token, state.deviceId, r.reason)
          .then(function (res) { setMessage(res.message, true); loadDay(); return loadSettings(); })
          .catch(function (err) { remove.disabled = false; settingsError(err); });
      }
      buttons.appendChild(toggle);
      buttons.appendChild(remove);
      li.appendChild(buttons);
      reasons.appendChild(li);
    });

    $('set-scheduled-block').hidden = !s.scheduled.length;
    var sched = $('set-scheduled');
    sched.textContent = '';
    s.scheduled.forEach(function (x) { sched.appendChild(textEl('li', 'From ' + x.dateLabel + ': ' + x.text)); });
  }

  function setMessage(text, good) {
    $('set-msg').className = good ? 'msg ok' : 'msg';
    $('set-msg').textContent = text;
  }

  function settingsError(err) {
    var message = (err && err.message) || String(err);
    if (message.indexOf('NOT_LOGGED_IN') !== -1) { handleError(err); return; }
    setMessage(message, false);
    window.scrollTo(0, 0);
  }

  /** What each Save button sends. */
  function settingChange(key) {
    if (key === 'clinic_name') return { key: key, value: $('set-clinic').value.trim() };
    if (key === 'clinic_whatsapp') {
      return { key: key, value: {
        countryCode: $('set-wa-cc').value === 'other' ? $('set-wa-cc-other').value.replace(/\D/g, '') : $('set-wa-cc').value,
        mobile: $('set-wa').value.trim() } };
    }
    if (key === 'working_days') {
      var days = Array.prototype.filter.call($('set-days').querySelectorAll('input'), function (b) { return b.checked; })
        .map(function (b) { return b.value; });
      return { key: key, value: days, from: $('set-days-from').value };
    }
    if (key === 'slot_minutes') {
      var scope = document.querySelector('input[name="slot-scope"]:checked').value;
      var date = $('set-slot-date').value;
      return { key: key, value: Number($('set-slot').value), scope: scope, from: date, date: date };
    }
    var input = { grace_minutes: 'set-grace', booking_window_days: 'set-window',
                  max_upcoming_per_mobile: 'set-limit', entered_late_max_days: 'set-back' }[key];
    return { key: key, value: Number($(input).value) };
  }

  /** Saves one setting. If bookings are affected, the server asks first. */
  function saveSetting(change, button) {
    button.disabled = true;
    $('set-affected').hidden = true;
    return call('changeClinicSetting', state.token, state.deviceId, change)
      .then(function (r) {
        if (r.needsConfirm) {
          return askAffected(r.affected, 'You can move and message these patients next.').then(function (yes) {
            if (!yes) return null;
            change.confirmed = true;
            return call('changeClinicSetting', state.token, state.deviceId, change);
          });
        }
        return r;
      })
      .then(function (r) {
        if (!r) return;
        setMessage(r.message + (r.info ? ' ' + r.info : ''), true);
        showSettingsAffected(r.affected || [], change.key);
        loadDay();
        return loadSettings();
      })
      .catch(settingsError)
      .then(function () { button.disabled = false; });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.set-save'), function (button) {
    button.addEventListener('click', function () {
      saveSetting(settingChange(button.dataset.key), button);
    });
  });

  /**
   * After a slot-length change: each affected booking with its suggested
   * slot and a Move button, then WhatsApp. After a working-days change:
   * WhatsApp asking the patient for a new time.
   */
  function showSettingsAffected(list, key) {
    var ul = $('set-affected-list');
    ul.textContent = '';
    $('set-affected').hidden = list.length === 0;
    var movable = list.filter(function (a) { return a.suggested; });
    $('set-move-all').hidden = movable.length < 2;
    $('set-affected-note').textContent = key === 'slot_minutes'
      ? 'These bookings no longer fit the new slots. Move each one to the suggested time, then message the patient.'
      : 'These bookings are on days the clinic is now closed. Message each patient to pick a new time.';
    list.forEach(function (a) {
      var li = document.createElement('li');
      li.appendChild(textEl('div', a.name + ' · ' + a.id, 'title'));
      li.appendChild(textEl('div', a.dateLabel + ', ' + to12h(a.time) + ' · ' + (a.mobile ? spacedPhone(a.mobile) : 'no number'), 'muted'));
      var actions = document.createElement('div');
      actions.className = 'affected-actions';
      li.appendChild(actions);
      if (a.suggested) {
        li.insertBefore(textEl('div', 'Suggested: ' + to12h(a.suggested), 'muted'), actions);
        var move = textEl('button', 'Move to ' + to12h(a.suggested), 'btn small primary');
        move.type = 'button';
        move.addEventListener('click', function () { moveAffected(a, move, actions); });
        a.moveButton = move;
        actions.appendChild(move);
      } else {
        if (key === 'slot_minutes') li.insertBefore(textEl('div', 'No free slot left that day. Reschedule by hand.', 'muted'), actions);
        addWhatsapp(actions, a.mobile);
      }
      ul.appendChild(li);
    });
    $('set-move-all').onclick = function () {
      var queue = movable.filter(function (a) { return !a.moved; });
      var next = function () {
        var a = queue.shift();
        if (!a) return;
        moveAffected(a, a.moveButton, a.moveButton.parentNode).then(next);
      };
      next();
    };
  }

  function moveAffected(a, button, actions) {
    button.disabled = true;
    return call('rescheduleBooking', state.token, state.deviceId, a.id, { date: a.date, time: a.suggested })
      .then(function (r) {
        if (!r.ok) {
          button.disabled = false;
          button.textContent = 'Slot taken: reschedule by hand';
          return;
        }
        a.moved = true;
        actions.textContent = '';
        actions.appendChild(textEl('span', 'Moved to ' + to12h(r.booking.time) + ' ✓', 'pill arrived'));
        addWhatsapp(actions, r.booking.mobile);
        loadDay();
      })
      .catch(function (err) { button.disabled = false; settingsError(err); });
  }

  /** A WhatsApp button (empty chat) for one patient. */
  function addWhatsapp(actions, mobile) {
    var link = whatsappLink(mobile);
    if (link) {
      var wa = textEl('a', 'WhatsApp', 'btn small whatsapp');
      wa.href = link;
      wa.target = '_blank';
      wa.rel = 'noopener';
      actions.appendChild(wa);
    }
  }

  /** "These bookings are affected. Save anyway?" in our own box. */
  function askAffected(affected, after) {
    var lines = affected.map(function (a) { return '• ' + a.name + ', ' + a.dateLabel + ' ' + to12h(a.time); }).join('\n');
    return ask({ title: affected.length + (affected.length === 1 ? ' booking is' : ' bookings are') + ' affected. Save anyway?',
                 text: lines + '\n\n' + after, yes: 'Yes, save', no: 'Go back' });
  }

  $('set-wa-cc').addEventListener('change', function () {
    $('set-wa-cc-other').hidden = $('set-wa-cc').value !== 'other';
  });
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-back').addEventListener('click', function () { backToDay(''); });
  $('set-affected-done').addEventListener('click', function () { $('set-affected').hidden = true; });
  /** Adds every filled-in blank field, one after another. */
  $('set-add-reason').addEventListener('click', function () {
    var fields = Array.prototype.slice.call(document.querySelectorAll('.new-reason'));
    var names = fields.map(function (f) { return f.value.trim(); }).filter(Boolean);
    if (!names.length) { setMessage('Type at least one visit reason in the empty fields.', false); return; }
    $('set-add-reason').disabled = true;
    var added = [];
    var next = function () {
      var name = names.shift();
      if (!name) return Promise.resolve();
      return call('addReason', state.token, state.deviceId, name).then(function () { added.push(name); return next(); });
    };
    next()
      .then(function () { setMessage('Added: ' + added.join(', ') + '.', true); })
      .catch(function (err) { if (added.length) loadSettings(); settingsError(err); })
      .then(function () {
        fields.forEach(function (f) { if (added.indexOf(f.value.trim()) !== -1) f.value = ''; });
        $('set-add-reason').disabled = false;
        loadDay();
        return loadSettings();
      });
  });
  $('set-more-reasons').addEventListener('click', function () {
    var input = document.createElement('input');
    input.className = 'text-input new-reason';
    input.maxLength = 40;
    input.placeholder = 'New visit reason';
    $('set-new-reasons').appendChild(input);
    input.focus();
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
          return askAffected(r.affected, 'You can message these patients next.').then(function (yes) {
            if (!yes) return null;
            change.confirmed = true;
            return call('changeDayAvailability', state.token, state.deviceId, change);
          });
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

  /**
   * Opens an empty WhatsApp chat with that number (decided Nov 2026: no
   * pre-typed message; the receptionist types it).
   * wa.me needs the number with its country code, digits only.
   * "+971 501234567" → 971501234567. Older 10-digit numbers are Indian (91).
   */
  function whatsappLink(mobile) {
    var s = String(mobile || '').trim();
    var digits = s.replace(/\D/g, '');
    if (s.charAt(0) !== '+' && digits.length === 10) digits = '91' + digits;
    if (!/^\d{8,15}$/.test(digits)) return null;
    return 'https://wa.me/' + digits;
  }

  function showAffected(list) {
    var ul = $('affected-list');
    ul.textContent = '';
    $('affected').hidden = list.length === 0;
    list.forEach(function (a) {
      var li = document.createElement('li');
      li.appendChild(textEl('div', a.name, 'title'));
      li.appendChild(textEl('div', a.dateLabel + ', ' + to12h(a.time), 'muted'));
      li.appendChild(textEl('div', 'Mobile: ' + (a.mobile || 'not recorded'), 'muted'));
      var actions = document.createElement('div');
      actions.className = 'affected-actions';
      var link = whatsappLink(a.mobile);
      if (link) {
        var wa = textEl('a', 'WhatsApp', 'btn small whatsapp');
        wa.href = link;
        wa.target = '_blank';
        wa.rel = 'noopener';
        actions.appendChild(wa);
      }
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
    ask({ title: 'Undo this "from now on" change?', text: 'Every day from this date goes back to how it was before.',
          yes: 'Yes, undo', no: 'Go back' })
      .then(function (yes) { if (yes) saveChange({ action: 'undoFromNow', scope: 'day' }, $('edit-undo')); });
  });
  $('edit-reset').addEventListener('click', function () {
    ask({ title: 'Reset this day to normal?', text: 'The changes made to this day only are undone, and it goes back to the clinic\'s normal slots.',
          yes: 'Yes, reset', no: 'Go back' })
      .then(function (yes) { if (yes) saveChange({ action: 'reset', scope: 'day' }, $('edit-reset')); });
  });

  // Keep every device up to date: every 60 seconds, and when the app is
  // opened again after being in the background.
  setInterval(function () {
    if (!$('screen-day').hidden && document.visibilityState === 'visible') loadDay();
  }, 60 * 1000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !$('screen-day').hidden) loadDay();
  });

  /* ---------- Always run the newest version ---------- */

  /**
   * GitHub Pages lets phones keep the page for up to 10 minutes. On opening
   * (and when coming back to the app) we ask for version.json, which is
   * never kept, and reload once if a newer version has been published.
   */
  function checkForNewVersion() {
    if (!window.APP_VERSION || window.APP_VERSION.indexOf('APP_VERSION') !== -1) return;  // local preview
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (latest) {
        if (latest && latest.v && latest.v !== window.APP_VERSION) {
          location.replace(location.pathname + '?v=' + latest.v);
        }
      })
      .catch(function () {});
  }
  checkForNewVersion();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkForNewVersion();
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
