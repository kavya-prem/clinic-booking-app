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
