/* signin.js - name and email gate with email confirmation for the Abacus Labs calculators.
   Load it with <script src="signin.js"></script> before your main script.
   Flow: visitor enters name and email -> we email a link -> opening the link signs them in.
   Once signed in, their token is added to every request your page makes to /api/... */
(function () {
  var LS = 'abacus-gate';
  var API = '/api/gate';
  var CONFIRM = '/api/gate';
  var PRIVACY_URL = ''; // add e.g. '/privacy.html' once that page exists

  var plainFetch = window.fetch.bind(window);

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(LS) || 'null');
      return s && s.token && s.exp > Date.now() ? s : null;
    } catch (e) {
      return null;
    }
  }
  function store(s) {
    try {
      if (s) localStorage.setItem(LS, JSON.stringify(s));
      else localStorage.removeItem(LS);
    } catch (e) {}
  }

  var G = load();

  // Other scripts can read who is signed in, e.g. AbacusGate.user.uid or AbacusGate.dataUse
  window.AbacusGate = {
    get user() { return G; },
    get dataUse() { return !!(G && G.dataUse); }
  };

  // Add the token to same-site /api calls, and react to sign-in or limit errors.
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : input && input.url;
      var ours = url && (url.indexOf('/api/gate') === 0);
      if (G && url && url.indexOf('/api/') === 0 && !ours) {
        init = Object.assign({}, init);
        init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + G.token });
      }
    } catch (e) {}
    return plainFetch(input, init).then(function (r) {
      if (r.status === 401) {
        G = null;
        store(null);
        renderForm('Your sign-in has expired. Enter your details to get a new link.');
      } else if (r.status === 429) {
        toast('Daily limit reached for live data. Type the figure in yourself, or try again tomorrow.');
      }
      return r;
    });
  };

  var css =
    '#ag-back{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(14,22,20,.72);overflow-y:auto}' +
    '#ag-box{width:100%;max-width:420px;background:var(--card,#fff);color:var(--ink,#12241f);border:1px solid var(--line,#d6ddda);border-radius:8px;padding:20px;font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '#ag-box h2{font-size:18px;margin:0 0 6px;font-weight:600}' +
    '#ag-box p{margin:0 0 14px;color:var(--mut,#5d6d68);font-size:14px}' +
    '#ag-box label.f{display:block;margin-bottom:10px;font-size:14px}' +
    '#ag-box input[type=text],#ag-box input[type=email]{display:block;width:100%;margin-top:4px;padding:8px 10px;font:inherit;border:1px solid var(--line,#d6ddda);border-radius:6px;background:var(--card,#fff);color:var(--ink,#12241f)}' +
    '#ag-box .ck{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:start;margin:10px 0;font-size:13.5px}' +
    '#ag-box .ck input{margin-top:3px}' +
    '#ag-box details{margin:2px 0 12px;font-size:13px;color:var(--mut,#5d6d68)}' +
    '#ag-box summary{cursor:pointer}' +
    '#ag-box button{font:inherit;font-weight:500;padding:9px 12px;border-radius:6px;cursor:pointer;border:1px solid var(--line,#d6ddda);background:var(--card,#fff);color:var(--ink,#12241f)}' +
    '#ag-box button.pri{width:100%;border-color:var(--ink,#12241f);background:var(--ink,#12241f);color:var(--bg,#eef1f0)}' +
    '#ag-box button[disabled]{opacity:.6;cursor:default}' +
    '#ag-row{display:flex;gap:8px;flex-wrap:wrap}' +
    '#ag-box :focus-visible{outline:2px solid var(--eq,#0b6e5c);outline-offset:1px}' +
    '#ag-err{margin-top:10px;padding:7px 10px;border-radius:6px;border-left:3px solid var(--bad,#b3261e);background:var(--soft,#f6f8f7);font-size:13.5px}' +
    '#ag-ok{margin-top:10px;padding:7px 10px;border-radius:6px;border-left:3px solid var(--eq,#0b6e5c);background:var(--soft,#f6f8f7);font-size:13.5px}' +
    '#ag-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}' +
    '#ag-toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:1001;max-width:min(92vw,460px);padding:9px 14px;border-radius:6px;background:var(--ink,#12241f);color:var(--bg,#eef1f0);font:14px/1.4 "IBM Plex Sans",system-ui,sans-serif}';

  function addStyle() {
    if (document.getElementById('ag-css')) return;
    var s = document.createElement('style');
    s.id = 'ag-css';
    s.textContent = css;
    document.head.appendChild(s);
  }

  var tt = null;
  function toast(msg) {
    var t = document.getElementById('ag-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ag-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    clearTimeout(tt);
    tt = setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 7000);
  }

  var ERR = {
    invalid: 'Enter your name and a valid email address.',
    consent: 'Tick the first box to continue.',
    too_many: 'Too many sign-ups from this network today. Try again tomorrow.',
    mail_limit: 'Too many emails have been sent to this address today. Use the link already in your inbox, or try tomorrow.',
    mail_fail: 'We could not send the email. Check the address and try again.',
    server: 'Something went wrong on our side. Try again in a minute.',
    network: 'Could not reach the server. Check your connection and try again.'
  };

  // The sign-in box. Created once, then its contents are swapped between screens.
  function box() {
    addStyle();
    var back = document.getElementById('ag-back');
    if (!back) {
      back = document.createElement('div');
      back.id = 'ag-back';
      back.innerHTML = '<div id="ag-box" role="dialog" aria-modal="true" aria-labelledby="ag-h"></div>';
      document.body.appendChild(back);
      document.body.style.overflow = 'hidden';
    }
    return back.querySelector('#ag-box');
  }
  function close() {
    var b = document.getElementById('ag-back');
    if (b && b.parentNode) b.parentNode.removeChild(b);
    document.body.style.overflow = '';
  }

  function post(url, body) {
    return plainFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(
        function (j) { return { ok: r.ok, j: j || {} }; },
        function () { return { ok: false, j: {} }; }
      );
    });
  }

  // Screen 1: the form
  function renderForm(message, prefill) {
    var el = box();
    var privacy = PRIVACY_URL ? ' <a href="' + PRIVACY_URL + '" target="_blank" rel="noopener">Privacy notice</a>.' : '';
    el.innerHTML =
      '<h2 id="ag-h">Enter your details to use the calculator</h2>' +
      '<p>Free to use, with no password. We email you a link to confirm your address, which also helps us stop automated abuse of the live data feeds.</p>' +
      '<form id="ag-form" novalidate>' +
      '<label class="f">Name<input type="text" name="name" autocomplete="name" required></label>' +
      '<label class="f">Email<input type="email" name="email" autocomplete="email" required></label>' +
      '<div id="ag-hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<label class="ck"><input type="checkbox" name="consent" required><span>I agree that Abacus Labs stores my name and email so I can use this tool.</span></label>' +
      '<label class="ck"><input type="checkbox" name="dataUse"><span>Optional: Abacus Labs may keep the figures I enter (company, rates, peer choices, results) to improve the tool and for research. This never includes my name or email.</span></label>' +
      '<details><summary>What we store</summary><p style="margin:6px 0 0">Your name, your email, when you confirmed it, and a count of your daily requests to the live data feeds. Your IP address is stored only as a one-way hash, to limit sign-ups. We do not sell your details. We only email you the confirmation link.' + privacy + ' Do not enter confidential company information.</p></details>' +
      '<button id="ag-go" class="pri" type="submit">Email me a confirmation link</button>' +
      '<div id="ag-err" role="alert" aria-live="assertive" hidden></div>' +
      '</form>';

    var form = el.querySelector('#ag-form');
    var err = el.querySelector('#ag-err');
    var go = el.querySelector('#ag-go');
    if (prefill) {
      form.elements.name.value = prefill.name || '';
      form.elements.email.value = prefill.email || '';
      form.elements.dataUse.checked = !!prefill.dataUse;
    }
    if (message) { err.textContent = message; err.hidden = false; }
    form.elements.name.focus();

    function fail(code) {
      err.textContent = ERR[code] || ERR.server;
      err.hidden = false;
      go.disabled = false;
      go.textContent = 'Email me a confirmation link';
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {
        name: form.elements.name.value.trim(),
        email: form.elements.email.value.trim(),
        action: 'signup',
        consent: form.elements.consent.checked,
        dataUse: form.elements.dataUse.checked,
        website: form.elements.website.value
      };
      if (data.name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) return fail('invalid');
      if (!data.consent) return fail('consent');
      err.hidden = true;
      go.disabled = true;
      go.textContent = 'Sending...';
      post(API, data)
        .then(function (x) {
          if (!x.ok || !x.j.sent) return fail(x.j.error);
          renderSent(data);
        })
        .catch(function () { fail('network'); });
    });
  }

  // Screen 2: check your email
  function renderSent(data) {
    var el = box();
    el.innerHTML =
      '<h2 id="ag-h">Check your email</h2>' +
      '<p>We sent a confirmation link to <b id="ag-em"></b>. Open it on this device to start using the calculator. The link works for 30 minutes. If it does not arrive, check your spam folder.</p>' +
      '<div id="ag-row"><button id="ag-resend" type="button">Send the link again</button><button id="ag-change" type="button">Use a different email</button></div>' +
      '<div id="ag-ok" role="status" aria-live="polite" hidden></div>' +
      '<div id="ag-err" role="alert" aria-live="assertive" hidden></div>';
    el.querySelector('#ag-em').textContent = data.email;
    var ok = el.querySelector('#ag-ok');
    var err = el.querySelector('#ag-err');
    var again = el.querySelector('#ag-resend');
    el.querySelector('#ag-change').addEventListener('click', function () { renderForm(null, data); });
    again.addEventListener('click', function () {
      ok.hidden = true;
      err.hidden = true;
      again.disabled = true;
      post(API, data)
        .then(function (x) {
          if (x.ok && x.j.sent) { ok.textContent = 'Sent again. Use the newest email.'; ok.hidden = false; }
          else { err.textContent = ERR[x.j.error] || ERR.server; err.hidden = false; }
        })
        .catch(function () { err.textContent = ERR.network; err.hidden = false; })
        .then(function () { again.disabled = false; });
    });
  }

  // Screen 3: shown while the emailed link is being checked
  function renderWorking(text) {
    var el = box();
    el.innerHTML = '<h2 id="ag-h"></h2><p>One moment.</p>';
    el.querySelector('#ag-h').textContent = text;
  }

  // If the page was opened from the emailed link (?verify=...), sign the visitor in.
  function confirmFromUrl() {
    var u;
    try { u = new URL(window.location.href); } catch (e) { return false; }
    var t = u.searchParams.get('verify');
    if (!t) return false;
    u.searchParams.delete('verify');
    try { history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) {}
    renderWorking('Confirming your email...');
    post(CONFIRM, { action: 'confirm', t: t })
      .then(function (x) {
        if (!x.ok || !x.j.token) {
          return renderForm('This link has expired or is not valid. Enter your details to get a new one.');
        }
        G = { token: x.j.token, uid: x.j.uid, exp: x.j.exp, dataUse: !!x.j.dataUse };
        store(G);
        close();
        toast('Email confirmed. You are signed in.');
      })
      .catch(function () { renderForm(ERR.network); });
    return true;
  }

  // If the link is opened in another tab of this browser, close the box here too.
  window.addEventListener('storage', function (e) {
    if (e.key !== LS) return;
    var s = load();
    if (s) { G = s; close(); }
  });

  function start() {
    if (confirmFromUrl()) return;
    if (!G) renderForm();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
