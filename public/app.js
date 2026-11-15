'use strict';
/* Social Feed — single-page frontend (vanilla JS, no build step).
   Talks to the Express API in ../server.js. Session token lives in
   localStorage; on load the app validates it and goes straight in. */

const app = document.getElementById('app');

const state = {
  token: localStorage.getItem('sf_token') || null,
  user: null,
  tab: 'home',
  // Feed pagination
  feedPosts: [],
  feedCursor: null,
  feedDone: false,
  // Per-post UI state: comments expanded + loaded comments
  expanded: {},       // postId -> true
  commentsCache: {},  // postId -> [comments]
  // Composer photo (File or null) per composer instance id
  composerPhoto: {},
  // Navigation stack for detail views
  view: { name: 'home' }, // home | feed | wallet | communities | community | messages | thread | profile | wallet-*
  profileId: null,
  communityId: null,
  conversationId: null,
  threadOther: null,
  threadTimer: null,
  // Wallet (SF Wallet): demo money in IDR, integer amounts only
  wallet: null,       // { balance_idr, has_pin, receive_token }
  walletHidden: localStorage.getItem('sf_hide_balance') === '1',
  walletTxs: [],
  walletCursor: null,
  walletFilter: 'all', // all | in | out | deposit
  walletTxDetail: null,
  walletReturn: 'wallet', // where wallet flows go back to: 'home' | 'wallet'
  sendFlow: null,     // { step, recipient, amount, note, result, error }
  payFlow: null,      // { payload, resolved, amount, step, result, error }
  pinFlow: null,      // { mode, step, currentPin, newPin, returnTo, error }
  receiveFlow: null,  // { mode, payload, displayName, request, error }
  topupFlow: null,    // { step, amount, method, result, error }
  scanStream: null,   // active getUserMedia stream (stopped on navigation)
  scanRaf: null,
  scanError: null,
  receiveTimer: null, // payment-request countdown interval
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd';
  return new Date(iso).toLocaleDateString();
}

function avatarHtml(user, size) {
  const cls = 'avatar' + (size ? ' ' + size : '');
  const name = esc(user && user.display_name ? user.display_name : '?');
  if (user && user.avatar_url) {
    return `<img class="${cls}" src="${esc(user.avatar_url)}" alt="${name}">`;
  }
  const initial = name.charAt(0).toUpperCase() || '?';
  return `<span class="${cls} avatar-initials">${initial}</span>`;
}

function verifiedBadge(user) {
  return user && user.verified_at ? '<span class="badge-verified" title="Verified">✓</span>' : '';
}

// Inline SVG icons (stroke style, Feather-style paths). No emoji in the UI.
const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  wallet: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="4" y1="12" x2="20" y2="12"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  arrowUpRight: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>',
  arrowDownLeft: '<line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  card: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
};

function icon(name, filled, size) {
  const s = size || 24;
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle">${ICONS[name]}</svg>`;
}

function showToast(msg) {
  let t = document.querySelector('.toast');
  if (t) t.remove();
  t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let body;
  if (opts.form) {
    body = opts.form; // FormData: browser sets the content type
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // Session gone: drop the token and show the auth screen.
    // (Auth endpoints answer their own 401s — e.g. a wrong password — and
    // must not bounce the user out of the login flow.)
    state.token = null;
    state.user = null;
    localStorage.removeItem('sf_token');
    showAuth('login');
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok) {
    // Carry the server's error code (e.g. PIN_REQUIRED) so callers can act on it.
    const err = new Error(data.error || 'Request failed.');
    if (data.code) err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Auth screens
// ---------------------------------------------------------------------------

function showAuth(mode, dir) {
  stopViewTimers();
  state.view = { name: 'auth' };
  // Every auth render gets a fresh security check: never carry a verified
  // challenge between tabs, steps, or login/register.
  state.challenge = null;
  state.captchaVerified = false;
  // Switching tabs resets the login flow to step 1, but keeps a typed email.
  if (mode === 'login' && dir === undefined) state.loginStep = 1;
  const step = mode === 'login' ? (state.loginStep || 1) : 1;
  const anim = dir === 'forward' ? 'anim-forward' : dir === 'back' ? 'anim-back' : '';
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-logo">Social Feed</div>
      <div class="auth-tabs">
        <button class="auth-tab ${mode === 'login' ? 'active' : ''}" onclick="showAuth('login')">Log in</button>
        <button class="auth-tab ${mode === 'register' ? 'active' : ''}" onclick="showAuth('register')">Register</button>
      </div>
      <div class="form-error" id="auth-error"></div>
      ${mode === 'login' ? (step === 1 ? `
      <div class="auth-step ${anim}" id="login-step-1">
        <form id="auth-form" onsubmit="return goLoginStep2(event)" novalidate>
          <div class="field"><label>Email</label>
            <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" value="${esc(state.loginEmail || '')}" autofocus></div>
          <button class="btn-primary" id="auth-submit" type="submit">Next</button>
        </form>
      </div>` : `
      <div class="auth-step ${anim}" id="login-step-2">
        <div class="auth-email-chip"><span class="chip-email">${esc(state.loginEmail || '')}</span><button class="link-btn" type="button" onclick="backLoginStep1()">Change</button></div>
        <form id="auth-form" onsubmit="return doLogin(event)">
          <div class="field"><label>Password</label>
            <input type="password" name="password" required autocomplete="current-password" placeholder="Your password" autofocus></div>
          ${captchaWidgetHtml()}
          <button class="btn-primary" id="auth-submit" type="submit" disabled>Log in</button>
        </form>
      </div>`) : `
      <form id="auth-form" onsubmit="return doRegister(event)">
        <div class="field"><label>Display name</label>
          <input type="text" name="display_name" required maxlength="50" placeholder="Your name"></div>
        <div class="field"><label>Email</label>
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></div>
        <div class="field"><label>Password</label>
          <input type="password" name="password" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters">
          <div class="hint">At least 8 characters.</div></div>
        <div class="field"><label>Confirm password</label>
          <input type="password" name="confirm" required minlength="8" autocomplete="new-password" placeholder="Repeat your password"></div>
        ${captchaWidgetHtml()}
        <button class="btn-primary" id="auth-submit" type="submit" disabled>Create account</button>
      </form>`}
    </div>`;
}

function authError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg || '';
}

// ---------------------------------------------------------------------------
// Math CAPTCHA, reCAPTCHA-style: checkbox first, math question on click.
// The answer is verified against the server before the box gets its check.
// ---------------------------------------------------------------------------

function captchaWidgetHtml() {
  return `
    <div class="rc-box" id="captcha-widget">
      <div class="rc-row">
        <button type="button" class="rc-check" id="captcha-check" onclick="toggleCaptcha(event)" aria-label="I'm not a robot"></button>
        <span class="rc-label">I'm not a robot</span>
        <span class="rc-mark">Math check<br>protected</span>
      </div>
      <div class="rc-panel" id="captcha-panel" hidden>
        <div class="captcha-question" id="captcha-question">Loading…</div>
        <div class="captcha-row">
          <input type="text" name="captcha_answer" inputmode="numeric" autocomplete="off" placeholder="Your answer" onkeydown="if(event.key==='Enter'){event.preventDefault();verifyCaptcha(event);}">
          <button class="captcha-refresh" type="button" onclick="refreshChallenge(event)" title="New question" aria-label="New question">↻</button>
        </div>
        <button class="btn-primary rc-verify" type="button" id="captcha-verify-btn" onclick="verifyCaptcha(event)">Verify</button>
        <div class="rc-error" id="captcha-error"></div>
      </div>
    </div>`;
}

function captchaError(msg) {
  const el = document.getElementById('captcha-error');
  if (el) el.textContent = msg || '';
}

function setSubmitEnabled(enabled) {
  const btn = document.getElementById('auth-submit');
  if (btn) btn.disabled = !enabled;
}

async function loadChallenge() {
  const q = document.getElementById('captcha-question');
  try {
    state.challenge = await api('/api/auth/challenge');
    if (q) q.textContent = state.challenge.question;
  } catch (err) {
    state.challenge = null;
    if (q) q.textContent = 'Could not load the security check. Tap refresh to retry.';
  }
}

async function refreshChallenge(e) {
  if (e) e.preventDefault();
  const input = document.querySelector('input[name="captcha_answer"]');
  if (input) input.value = '';
  captchaError('');
  const q = document.getElementById('captcha-question');
  if (q) q.textContent = 'Loading…';
  await loadChallenge();
  if (input) input.focus();
}

function toggleCaptcha(e) {
  if (e) e.preventDefault();
  if (state.captchaVerified) return; // verified is final until submit/reset
  const panel = document.getElementById('captcha-panel');
  if (!panel) return;
  const opening = panel.hidden;
  panel.hidden = !opening;
  if (opening) {
    if (!state.challenge) {
      // Clear any stale question so the old text is never answered against
      // the new challenge.
      const q = document.getElementById('captcha-question');
      if (q) q.textContent = 'Loading…';
      loadChallenge();
    }
    const input = document.querySelector('input[name="captcha_answer"]');
    if (input) input.focus();
  }
}

async function verifyCaptcha(e) {
  if (e) e.preventDefault();
  const input = document.querySelector('input[name="captcha_answer"]');
  const answer = (input ? input.value : '').trim();
  if (!answer) {
    captchaError('Enter your answer first.');
    if (input) input.focus();
    return;
  }
  if (!state.challenge) {
    captchaError('No question loaded. Tap refresh to retry.');
    return;
  }
  const check = document.getElementById('captcha-check');
  const verifyBtn = document.getElementById('captcha-verify-btn');
  if (check) check.classList.add('verifying');
  if (verifyBtn) verifyBtn.disabled = true;
  if (input) input.disabled = true;
  captchaError('');
  try {
    const r = await api('/api/auth/challenge/verify', {
      method: 'POST',
      body: { challenge_id: state.challenge.challenge_id, captcha_answer: answer },
    });
    if (r.verified) {
      state.captchaVerified = true;
      if (check) { check.classList.remove('verifying'); check.classList.add('checked'); }
      const panel = document.getElementById('captcha-panel');
      if (panel) panel.hidden = true;
      setSubmitEnabled(true);
      return;
    }
    // Wrong answer: the same question stays (attempts left) or a new one
    // is needed after too many tries.
    if (r.error === 'too_many_attempts') {
      captchaError('Too many tries. Here is a new question.');
      await refreshChallenge();
    } else {
      captchaError('Incorrect answer. Try again.' +
        (r.attempts_left ? ` (${r.attempts_left} ${r.attempts_left === 1 ? 'try' : 'tries'} left)` : ''));
      if (input) { input.value = ''; input.focus(); }
    }
  } catch (err) {
    // Expired or unknown challenge (400): fetch a fresh question.
    captchaError('That question expired. Here is a new one.');
    await refreshChallenge();
  } finally {
    if (check) check.classList.remove('verifying');
    if (verifyBtn) verifyBtn.disabled = false;
    if (input) input.disabled = false;
  }
}

// Back to unchecked: used after a failed submit (the challenge was consumed
// server-side) and whenever the auth screen re-renders.
function resetCaptcha() {
  state.challenge = null;
  state.captchaVerified = false;
  const check = document.getElementById('captcha-check');
  if (check) check.classList.remove('checked', 'verifying');
  const panel = document.getElementById('captcha-panel');
  if (panel) panel.hidden = true;
  const q = document.getElementById('captcha-question');
  if (q) q.textContent = 'Loading…';
  const input = document.querySelector('input[name="captcha_answer"]');
  if (input) { input.value = ''; input.disabled = false; }
  captchaError('');
  setSubmitEnabled(false);
}

// Login step 1 -> 2: only advance when the email is non-empty and well-formed.
function goLoginStep2(e) {
  e.preventDefault();
  const input = e.target.querySelector('input[name="email"]');
  const email = (input.value || '').trim();
  if (!email) {
    authError('Enter your email address.');
    input.focus();
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    authError('That email address does not look right. Check it and try again.');
    input.focus();
    return false;
  }
  state.loginEmail = email;
  state.loginStep = 2;
  showAuth('login', 'forward');
  return false;
}

// Login step 2 -> 1: the email is kept, so the user can edit it.
function backLoginStep1() {
  state.loginStep = 1;
  showAuth('login', 'back');
}

async function doLogin(e) {
  e.preventDefault();
  if (!state.captchaVerified || !state.challenge) {
    authError('Please complete the security check first.');
    const panel = document.getElementById('captcha-panel');
    if (panel && panel.hidden) toggleCaptcha();
    return false;
  }
  const f = new FormData(e.target);
  const btn = document.getElementById('auth-submit');
  btn.disabled = true;
  authError('');
  try {
    const { user, token } = await api('/api/auth/login', {
      method: 'POST',
      body: {
        email: state.loginEmail,
        password: f.get('password'),
        challenge_id: state.challenge.challenge_id,
      },
    });
    enterApp(user, token);
  } catch (err) {
    authError(err.message);
    // The verified challenge was consumed by the attempt, so the widget
    // goes back to unchecked even when the failure was a wrong password.
    resetCaptcha();
  }
  return false;
}

async function doRegister(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('password') !== f.get('confirm')) {
    authError('Passwords do not match.');
    return false;
  }
  if (!state.captchaVerified || !state.challenge) {
    authError('Please complete the security check first.');
    const panel = document.getElementById('captcha-panel');
    if (panel && panel.hidden) toggleCaptcha();
    return false;
  }
  const btn = document.getElementById('auth-submit');
  btn.disabled = true;
  authError('');
  try {
    const { user, token } = await api('/api/auth/register', {
      method: 'POST',
      body: {
        display_name: f.get('display_name'),
        email: f.get('email'),
        password: f.get('password'),
        challenge_id: state.challenge.challenge_id,
      },
    });
    enterApp(user, token);
  } catch (err) {
    authError(err.message);
    // The verified challenge was consumed by the attempt.
    resetCaptcha();
  }
  return false;
}

function enterApp(user, token) {
  state.user = user;
  state.token = token;
  localStorage.setItem('sf_token', token);
  state.tab = 'home';
  state.view = { name: 'home' };
  state.feedPosts = [];
  state.feedCursor = null;
  state.feedDone = false;
  state.wallet = null;
  renderApp();
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  state.token = null;
  state.user = null;
  localStorage.removeItem('sf_token');
  showAuth('login');
}

// ---------------------------------------------------------------------------
// App shell + navigation
// ---------------------------------------------------------------------------

// Stop everything a view may have started: thread polling, the camera
// scanner, and the payment-request countdown. Called on every navigation.
function stopViewTimers() {
  stopThreadPolling();
  stopScan();
  stopReceiveTimer();
}

function renderApp() {
  stopViewTimers();
  app.innerHTML = `
    <div class="topbar">
      <div class="wordmark">Social Feed</div>
      <button class="icon-btn" title="New post" onclick="goTab('feed', true)">${icon('edit', false, 22)}</button>
    </div>
    <main class="view" id="view"></main>
    <nav class="tabbar">
      <button class="tab ${state.tab === 'home' ? 'active' : ''}" onclick="goTab('home')">
        <span class="tab-icon">${icon('home', state.tab === 'home', 24)}</span><span class="tab-label">Home</span></button>
      <button class="tab ${state.tab === 'wallet' ? 'active' : ''}" onclick="goTab('wallet')">
        <span class="tab-icon">${icon('wallet', state.tab === 'wallet', 24)}</span><span class="tab-label">Wallet</span></button>
      <button class="tab ${state.tab === 'communities' ? 'active' : ''}" onclick="goTab('communities')">
        <span class="tab-icon">${icon('users', state.tab === 'communities', 24)}</span><span class="tab-label">Communities</span></button>
      <button class="tab ${state.tab === 'messages' ? 'active' : ''}" onclick="goTab('messages')">
        <span class="tab-icon">${icon('message', state.tab === 'messages', 24)}</span><span class="tab-label">Messages</span></button>
      <button class="tab ${state.tab === 'profile' ? 'active' : ''}" onclick="goTab('profile')">
        <span class="tab-icon">${icon('user', state.tab === 'profile', 24)}</span><span class="tab-label">Profile</span></button>
    </nav>`;
  renderView();
}

function goTab(tab, focusComposer) {
  stopViewTimers();
  state.tab = tab;
  state.view = { name: tab };
  if (tab === 'profile') state.profileId = state.user.id;
  renderApp();
  if (focusComposer) {
    const ta = document.querySelector('.composer textarea');
    if (ta) ta.focus();
  }
}

function renderView() {
  const v = state.view;
  if (v.name === 'home') renderHome();
  else if (v.name === 'wallet') renderWallet();
  else if (v.name === 'wallet-send') renderSend();
  else if (v.name === 'wallet-receive') renderReceive();
  else if (v.name === 'wallet-topup') renderTopUp();
  else if (v.name === 'wallet-scan') renderScan();
  else if (v.name === 'wallet-pay') renderPay();
  else if (v.name === 'wallet-pin') renderPinSetup();
  else if (v.name === 'wallet-tx') renderTxDetail();
  else if (v.name === 'feed') renderFeed();
  else if (v.name === 'communities') renderCommunities();
  else if (v.name === 'community') renderCommunity(state.communityId);
  else if (v.name === 'messages') renderMessages();
  else if (v.name === 'thread') renderThread(state.conversationId);
  else if (v.name === 'profile') renderProfile(state.profileId);
}

function viewEl() {
  return document.getElementById('view');
}

// ---------------------------------------------------------------------------
// Composer (feed + community)
// ---------------------------------------------------------------------------

function composerHtml(id, communityId) {
  return `
  <div class="composer">
    ${avatarHtml(state.user)}
    <div class="composer-body">
      <textarea id="composer-text-${id}" rows="2" maxlength="2000" placeholder="What's on your mind?"></textarea>
      <div class="photo-preview" id="composer-preview-${id}" style="display:none"></div>
      <div class="composer-actions">
        <input type="file" id="composer-file-${id}" accept="image/*" style="display:none"
          onchange="onComposerPhoto('${id}', this)">
        <button class="photo-btn" title="Add photo" onclick="document.getElementById('composer-file-${id}').click()">${icon('image', false, 24)}</button>
        <button class="post-btn" id="composer-submit-${id}"
          onclick="submitPost('${id}', ${communityId ? `'${communityId}'` : 'null'})">Post</button>
      </div>
    </div>
  </div>`;
}

function onComposerPhoto(id, input) {
  const file = input.files && input.files[0];
  const preview = document.getElementById('composer-preview-' + id);
  if (!file) {
    state.composerPhoto[id] = null;
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }
  state.composerPhoto[id] = file;
  const reader = new FileReader();
  reader.onload = () => {
    preview.style.display = 'block';
    preview.innerHTML = `<img src="${reader.result}" alt="preview">
      <button class="photo-remove" onclick="removeComposerPhoto('${id}')">×</button>`;
  };
  reader.readAsDataURL(file);
}

function removeComposerPhoto(id) {
  state.composerPhoto[id] = null;
  const input = document.getElementById('composer-file-' + id);
  if (input) input.value = '';
  const preview = document.getElementById('composer-preview-' + id);
  preview.style.display = 'none';
  preview.innerHTML = '';
}

async function submitPost(id, communityId) {
  const ta = document.getElementById('composer-text-' + id);
  const btn = document.getElementById('composer-submit-' + id);
  const body = ta.value.trim();
  const photo = state.composerPhoto[id];
  if (!body && !photo) {
    showToast('Write something or add a photo.');
    return;
  }
  btn.disabled = true;
  try {
    const form = new FormData();
    form.append('body', body);
    if (communityId) form.append('community_id', communityId);
    if (photo) form.append('photo', photo);
    const { post } = await api('/api/posts', { method: 'POST', form });
    ta.value = '';
    removeComposerPhoto(id);
    if (communityId) {
      renderCommunity(communityId);
    } else {
      registerPosts([post]);
      state.feedPosts.unshift(post);
      renderFeedList();
    }
    showToast('Posted.');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Feed + post cards
// ---------------------------------------------------------------------------

async function renderFeed() {
  viewEl().innerHTML = composerHtml('feed', null) + '<div id="feed-list"></div>';
  if (state.feedPosts.length === 0 && !state.feedDone) {
    await loadFeed(false);
  } else {
    renderFeedList();
  }
}

async function loadFeed(append) {
  const url = '/api/feed?limit=20' + (append && state.feedCursor
    ? '&cursor=' + encodeURIComponent(state.feedCursor) : '');
  try {
    const { posts, next_cursor } = await api(url);
    registerPosts(posts);
    state.feedPosts = append ? state.feedPosts.concat(posts) : posts;
    state.feedCursor = next_cursor;
    state.feedDone = !next_cursor;
    renderFeedList();
  } catch (err) {
    if (!append) viewEl().innerHTML += `<div class="empty-state">${esc(err.message)}</div>`;
    else showToast(err.message);
  }
}

function renderFeedList() {
  const list = document.getElementById('feed-list');
  if (!list) return;
  if (state.feedPosts.length === 0) {
    list.innerHTML = '<div class="empty-state">No posts yet.<br>Be the first to post something.</div>';
    return;
  }
  list.innerHTML = state.feedPosts.map(postCardHtml).join('') +
    (state.feedDone ? '' :
      '<button class="btn-outline load-more" onclick="loadFeed(true)">Load more</button>');
}

function postCardHtml(p) {
  const mine = state.user && p.author.id === state.user.id;
  const comments = state.commentsCache[p.id] || [];
  const expanded = !!state.expanded[p.id];
  const preview = comments[0];
  return `
  <article class="post" id="post-${p.id}">
    <div class="post-header">
      <span style="cursor:pointer" onclick="openProfile('${p.author.id}')">${avatarHtml(p.author)}</span>
      <div class="who">
        <span class="name" style="cursor:pointer" onclick="openProfile('${p.author.id}')">${esc(p.author.display_name)}${verifiedBadge(p.author)}</span>
        <div class="time">${timeAgo(p.created_at)}${p.community_name ? ' · in ' + esc(p.community_name) : ''}</div>
      </div>
      <button class="menu-btn" onclick="openPostMenu('${p.id}', ${mine}, ${!!p.photo_url})">•••</button>
    </div>
    ${p.body ? `<div class="post-body" ondblclick="onPostDoubleTap('${p.id}', event)">${esc(p.body)}</div>` : ''}
    ${p.photo_url ? `
    <div class="post-photo-wrap" ondblclick="onPostDoubleTap('${p.id}', event)">
      <img class="post-photo" src="${esc(p.photo_url)}" alt="Post photo">
    </div>` : ''}
    <div class="action-row">
      <button class="action-btn ${p.liked_by_me ? 'liked' : ''}" id="like-btn-${p.id}"
        onclick="toggleLike('${p.id}')" title="Like">${icon('heart', p.liked_by_me, 24)}</button>
      <button class="action-btn" onclick="toggleComments('${p.id}')" title="Comments">${icon('message', false, 24)}</button>
      <button class="action-btn" onclick="sharePost('${p.id}')" title="Share">${icon('send', false, 24)}</button>
    </div>
    <div class="like-count" id="like-count-${p.id}">${p.like_count} ${p.like_count === 1 ? 'like' : 'likes'}</div>
    ${preview && !expanded ? `
    <div class="comment-preview"><span class="c-name">${esc(preview.author.display_name)}</span> ${esc(preview.body)}</div>` : ''}
    ${p.comment_count > 0 ? `
    <button class="view-comments" onclick="toggleComments('${p.id}')">
      ${expanded ? 'Hide comments' : `View all ${p.comment_count} comment${p.comment_count === 1 ? '' : 's'}`}</button>` : ''}
    <div id="comments-${p.id}">${expanded ? commentsSectionHtml(p) : ''}</div>
  </article>`;
}

function commentsSectionHtml(p) {
  const comments = state.commentsCache[p.id] || [];
  return `
  <div class="comments">
    ${comments.length === 0 ? '<div class="comment"><div class="c-body" style="color:var(--muted)">No comments yet.</div></div>' : ''}
    ${comments.map((c) => `
      <div class="comment">
        <span style="cursor:pointer" onclick="openProfile('${c.author.id}')">${avatarHtml(c.author, 'sm')}</span>
        <div class="c-body">
          <span class="c-name" style="cursor:pointer" onclick="openProfile('${c.author.id}')">${esc(c.author.display_name)}${verifiedBadge(c.author)}</span>
          <span class="c-time"> · ${timeAgo(c.created_at)}</span>
          <div class="c-text">${esc(c.body)}</div>
        </div>
      </div>`).join('')}
    <form class="comment-form" onsubmit="return submitComment(event, '${p.id}')">
      ${avatarHtml(state.user, 'sm')}
      <input name="body" maxlength="1000" placeholder="Add a comment…" required>
      <button type="submit">Post</button>
    </form>
  </div>`;
}

async function toggleComments(postId) {
  state.expanded[postId] = !state.expanded[postId];
  const p = findPost(postId);
  if (!p) return;
  if (state.expanded[postId]) {
    try {
      const { comments } = await api(`/api/posts/${postId}/comments?limit=50`);
      state.commentsCache[postId] = comments;
    } catch (err) {
      showToast(err.message);
      state.expanded[postId] = false;
      return;
    }
  }
  rerenderPostCard(postId);
}

async function submitComment(e, postId) {
  e.preventDefault();
  const input = e.target.elements.body;
  const body = input.value.trim();
  if (!body) return false;
  try {
    const { comment } = await api(`/api/posts/${postId}/comments`, {
      method: 'POST', body: { body },
    });
    const p = findPost(postId);
    if (p) p.comment_count += 1;
    (state.commentsCache[postId] = state.commentsCache[postId] || []).push(comment);
    rerenderPostCard(postId);
  } catch (err) {
    showToast(err.message);
  }
  return false;
}

function findPost(postId) {
  return state.postIndex[postId] || state.feedPosts.find((p) => p.id === postId) || null;
}

// Re-render one post card in place (keeps like/comment UI consistent).
function rerenderPostCard(postId) {
  const p = findPost(postId);
  const el = document.getElementById('post-' + postId);
  if (p && el) el.outerHTML = postCardHtml(p);
}

function refreshPostCard(postId) {
  // Re-render just this post's like button/count and comment link.
  const p = findPost(postId);
  const el = document.getElementById('post-' + postId);
  if (!p || !el) return;
  const btn = document.getElementById('like-btn-' + postId);
  if (btn) {
    btn.innerHTML = icon('heart', !!p.liked_by_me, 24);
    btn.classList.toggle('liked', !!p.liked_by_me);
  }
  const count = document.getElementById('like-count-' + postId);
  if (count) count.textContent = `${p.like_count} ${p.like_count === 1 ? 'like' : 'likes'}`;
}

async function toggleLike(postId) {
  const p = findPost(postId);
  if (!p) return;
  const liked = !p.liked_by_me;
  // Optimistic update; the server confirms the real count.
  p.liked_by_me = liked;
  p.like_count += liked ? 1 : -1;
  refreshPostCard(postId);
  try {
    const res = await api(`/api/posts/${postId}/like`, { method: liked ? 'PUT' : 'DELETE' });
    p.liked_by_me = res.liked;
    p.like_count = res.like_count;
    refreshPostCard(postId);
  } catch (err) {
    p.liked_by_me = !liked;
    p.like_count += liked ? -1 : 1;
    refreshPostCard(postId);
    showToast(err.message);
  }
}

// Double-tap: like (only likes, never unlikes) + heart burst animation.
function onPostDoubleTap(postId, event) {
  const wrap = event.currentTarget;
  const burst = document.createElement('div');
  burst.className = 'heart-burst';
  burst.textContent = '♥';
  wrap.appendChild(burst);
  setTimeout(() => burst.remove(), 750);
  const p = findPost(postId);
  if (p && !p.liked_by_me) toggleLike(postId);
}

function sharePost(postId) {
  const url = location.origin + '/#post-' + postId;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('Link copied.'));
  } else {
    showToast(url);
  }
}

// ---------------------------------------------------------------------------
// Post ••• menu
// ---------------------------------------------------------------------------

function openPostMenu(postId, mine, hasPhoto) {
  closeMenu();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.onclick = closeMenu;
  const sheet = document.createElement('div');
  sheet.className = 'menu-sheet';
  const p = findPost(postId);
  sheet.innerHTML = `
    <button onclick="closeMenu(); openProfile('${p ? p.author.id : ''}')">View profile</button>
    <button onclick="closeMenu(); copyPostText('${postId}')">Copy text</button>
    ${mine && hasPhoto ? `<button class="danger" onclick="closeMenu(); removePostPhoto('${postId}')">Remove photo</button>` : ''}
    <button onclick="closeMenu()">Cancel</button>`;
  document.body.appendChild(overlay);
  document.body.appendChild(sheet);
}

function closeMenu() {
  document.querySelectorAll('.overlay, .menu-sheet').forEach((el) => el.remove());
}

function copyPostText(postId) {
  const p = findPost(postId);
  if (!p) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(p.body || '').then(() => showToast('Copied.'));
  }
}

async function removePostPhoto(postId) {
  try {
    await api(`/api/posts/${postId}/photo`, { method: 'DELETE' });
    const p = findPost(postId);
    if (p) p.photo_url = null;
    rerenderPostCard(postId);
    showToast('Photo removed.');
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Post registry (so like/comment work on feed, profile, and community posts)
// ---------------------------------------------------------------------------

state.postIndex = {};

function registerPosts(posts) {
  (posts || []).forEach((p) => { state.postIndex[p.id] = p; });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function openProfile(userId) {
  stopThreadPolling();
  state.profileId = userId;
  state.view = { name: 'profile' };
  renderApp();
}

async function renderProfile(userId) {
  const mine = userId === state.user.id;
  viewEl().innerHTML = '<div class="empty-state">Loading profile…</div>';
  try {
    const [profile, { posts, next_cursor }] = await Promise.all([
      api('/api/users/' + userId),
      api(`/api/users/${userId}/posts?limit=20`),
    ]);
    registerPosts(posts);
    state.profilePosts = posts;
    state.profileCursor = next_cursor;
    viewEl().innerHTML = `
      ${!mine ? `<div class="back-row"><button class="icon-btn" onclick="goTab('feed')">←</button>
        <span class="title">${esc(profile.display_name)}</span></div>` : ''}
      <div class="profile-head">
        <div class="profile-top">
          ${avatarHtml(profile, 'lg')}
          <div class="profile-stats">
            <div class="stat"><div class="num">${profile.post_count}</div><div class="lbl">Posts</div></div>
            <div class="stat"><div class="num">${profile.community_count}</div><div class="lbl">Communities</div></div>
          </div>
        </div>
        <div class="profile-name">${esc(profile.display_name)}${verifiedBadge(profile)}</div>
        ${profile.bio ? `<div class="profile-bio">${esc(profile.bio)}</div>` : ''}
        <div class="profile-verified">✓ Verified since ${new Date(profile.verified_at).toLocaleDateString()}</div>
        <div class="profile-actions">
          ${mine ? `
            <button class="btn-outline" onclick="toggleEditProfile()">Edit profile</button>
            <button class="btn-outline btn-danger" onclick="doLogout()">Log out</button>` : `
            <button class="btn-outline" onclick="startConversation('${profile.id}')">Message</button>`}
        </div>
      </div>
      <div id="edit-profile" style="display:none"></div>
      <div class="section-label">Posts</div>
      <div id="profile-posts"></div>`;
    renderProfilePosts();
  } catch (err) {
    viewEl().innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderProfilePosts() {
  const box = document.getElementById('profile-posts');
  if (!box) return;
  const posts = state.profilePosts || [];
  if (posts.length === 0) {
    box.innerHTML = '<div class="empty-state">No posts yet.</div>';
    return;
  }
  box.innerHTML = posts.map(postCardHtml).join('') +
    (state.profileCursor
      ? '<button class="btn-outline load-more" onclick="loadMoreProfilePosts()">Load more</button>' : '');
}

async function loadMoreProfilePosts() {
  try {
    const { posts, next_cursor } = await api(
      `/api/users/${state.profileId}/posts?limit=20&cursor=${encodeURIComponent(state.profileCursor)}`);
    registerPosts(posts);
    state.profilePosts = state.profilePosts.concat(posts);
    state.profileCursor = next_cursor;
    renderProfilePosts();
  } catch (err) {
    showToast(err.message);
  }
}

function toggleEditProfile() {
  const box = document.getElementById('edit-profile');
  if (!box) return;
  if (box.style.display !== 'none') {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = `
    <form class="edit-form" onsubmit="return saveProfile(event)">
      <div class="avatar-row">
        ${avatarHtml(state.user, 'lg')}
        <div>
          <input type="file" id="avatar-file" accept="image/*" style="display:none" onchange="uploadAvatar(this)">
          <button type="button" class="btn-outline" onclick="document.getElementById('avatar-file').click()">Change profile photo</button>
          <div class="hint" style="font-size:12px;color:var(--muted);margin-top:4px">JPEG, PNG, GIF or WebP, up to 2 MB.</div>
        </div>
      </div>
      <div class="field"><label>Display name</label>
        <input name="display_name" maxlength="50" value="${esc(state.user.display_name)}" required></div>
      <div class="field"><label>Bio</label>
        <textarea name="bio" rows="3" maxlength="500">${esc(state.user.bio || '')}</textarea></div>
      <button class="btn-primary" type="submit">Save</button>
    </form>`;
}

async function saveProfile(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { user } = await api('/api/users/me', {
      method: 'PATCH',
      body: { display_name: f.get('display_name'), bio: f.get('bio') },
    });
    state.user = user;
    showToast('Profile saved.');
    renderProfile(state.user.id);
  } catch (err) {
    showToast(err.message);
  }
  return false;
}

async function uploadAvatar(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const form = new FormData();
    form.append('avatar', file);
    const { user } = await api('/api/users/me/avatar', { method: 'POST', form });
    state.user = user;
    showToast('Profile photo updated.');
    renderProfile(state.user.id);
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function renderMessages() {
  viewEl().innerHTML = '<div class="empty-state">Loading messages…</div>';
  try {
    const [{ conversations }, { users }] = await Promise.all([
      api('/api/conversations'),
      api('/api/users'),
    ]);
    viewEl().innerHTML = `
      <div class="back-row"><span class="title">Messages</span></div>
      ${conversations.length === 0
        ? '<div class="empty-state">No conversations yet.<br>Start one below.</div>'
        : conversations.map((c) => `
          <button class="row-item" onclick="openThread('${c.id}')">
            ${avatarHtml(c.other)}
            <div class="row-main">
              <div class="row-name">${esc(c.other.display_name)}${verifiedBadge(c.other)}</div>
              <div class="row-sub">${c.last_message ? esc((c.last_message.from_me ? 'You: ' : '') + c.last_message.body) : 'Say hello'}</div>
            </div>
            ${c.last_message ? `<span class="row-time">${timeAgo(c.last_message.created_at)}</span>` : ''}
            ${c.has_unread ? '<span class="unread-dot"></span>' : ''}
          </button>`).join('')}
      <div class="section-label">People</div>
      ${users.length === 0 ? '<div class="empty-state">No other users yet.</div>' : ''}
      ${users.map((u) => `
        <button class="row-item" onclick="startConversation('${u.id}')">
          ${avatarHtml(u)}
          <div class="row-main"><div class="row-name">${esc(u.display_name)}${verifiedBadge(u)}</div></div>
          <span class="row-time">Message →</span>
        </button>`).join('')}`;
  } catch (err) {
    viewEl().innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

async function startConversation(participantId) {
  try {
    const { conversation } = await api('/api/conversations', {
      method: 'POST', body: { participant_id: participantId },
    });
    openThread(conversation.id);
  } catch (err) {
    showToast(err.message);
  }
}

function openThread(conversationId) {
  stopThreadPolling();
  state.conversationId = conversationId;
  state.view = { name: 'thread' };
  state.tab = 'messages';
  renderApp();
}

function stopThreadPolling() {
  if (state.threadTimer) {
    clearInterval(state.threadTimer);
    state.threadTimer = null;
  }
}

async function renderThread(conversationId) {
  // Find the other participant from the conversation list.
  let other = state.threadOther;
  try {
    const { conversations } = await api('/api/conversations');
    const conv = conversations.find((c) => c.id === conversationId);
    if (conv) {
      other = conv.other;
      state.threadOther = other;
    }
  } catch { /* keep previous other */ }
  viewEl().innerHTML = `
    <div class="thread-head">
      <button class="icon-btn" onclick="goTab('messages')">←</button>
      ${other ? avatarHtml(other, 'sm') : ''}
      <span class="t-name" ${other ? `onclick="openProfile('${other.id}')" style="cursor:pointer"` : ''}>
        ${other ? esc(other.display_name) + verifiedBadge(other) : 'Conversation'}</span>
    </div>
    <div class="thread-messages" id="thread-messages">
      <div class="empty-state">Loading…</div>
    </div>
    <form class="thread-composer" onsubmit="return sendMessage(event)">
      <input name="body" maxlength="1000" placeholder="Message…" required autocomplete="off">
      <button type="submit">Send</button>
    </form>`;
  await loadThreadMessages(false);
  // Poll for new messages while the thread is open.
  state.threadTimer = setInterval(() => loadThreadMessages(true), 5000);
}

async function loadThreadMessages(silent) {
  try {
    const { messages } = await api(`/api/conversations/${state.conversationId}/messages?limit=100`);
    const box = document.getElementById('thread-messages');
    if (!box) return;
    const key = messages.map((m) => m.id).join(',');
    if (silent && box.dataset.key === key) return; // nothing new
    box.dataset.key = key;
    if (messages.length === 0) {
      box.innerHTML = '<div class="empty-state">No messages yet.<br>Say hello</div>';
      return;
    }
    box.innerHTML = messages.map((m) => {
      const mine = m.sender.id === state.user.id;
      return `<div class="msg ${mine ? 'mine' : 'theirs'}">${esc(m.body)}
        <span class="m-time">${timeAgo(m.created_at)}</span></div>`;
    }).join('');
    window.scrollTo(0, document.body.scrollHeight);
  } catch (err) {
    if (!silent) showToast(err.message);
  }
}

async function sendMessage(e) {
  e.preventDefault();
  const input = e.target.elements.body;
  const body = input.value.trim();
  if (!body) return false;
  input.value = '';
  try {
    await api(`/api/conversations/${state.conversationId}/messages`, {
      method: 'POST', body: { body },
    });
    await loadThreadMessages(false);
  } catch (err) {
    showToast(err.message);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

async function renderCommunities() {
  viewEl().innerHTML = `
    <div class="back-row"><span class="title">Communities</span></div>
    <div class="search-box"><input id="community-search" placeholder="Search communities…"
      oninput="searchCommunities(this.value)"></div>
    <div class="search-box">
      <form onsubmit="return createCommunity(event)" style="display:flex;gap:8px">
        <input name="name" maxlength="80" placeholder="New community name" required style="flex:1">
        <button class="btn-outline" type="submit">Create</button>
      </form>
    </div>
    <div id="community-list"><div class="empty-state">Loading…</div></div>`;
  await searchCommunities('');
}

async function searchCommunities(query) {
  const box = document.getElementById('community-list');
  try {
    const { communities } = await api('/api/communities?query=' + encodeURIComponent(query || ''));
    if (communities.length === 0) {
      box.innerHTML = '<div class="empty-state">No communities found.</div>';
      return;
    }
    box.innerHTML = communities.map((c) => `
      <div class="community-card">
        <div class="c-title">${esc(c.name)}</div>
        <div class="c-meta">${c.member_count} ${c.member_count === 1 ? 'member' : 'members'}</div>
        ${c.description ? `<div class="c-desc">${esc(c.description)}</div>` : ''}
        <div class="c-actions">
          <button class="btn-outline" onclick="openCommunity('${c.id}')">Open</button>
          ${c.joined
            ? `<button class="btn-outline" onclick="leaveCommunity('${c.id}')">Leave</button>`
            : `<button class="btn-outline" onclick="joinCommunity('${c.id}')">Join</button>`}
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

async function createCommunity(e) {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  if (!name) return false;
  try {
    const { community } = await api('/api/communities', {
      method: 'POST', body: { name, description: '' },
    });
    showToast('Community created.');
    openCommunity(community.id);
  } catch (err) {
    showToast(err.message);
  }
  return false;
}

async function joinCommunity(id) {
  try {
    await api(`/api/communities/${id}/join`, { method: 'POST' });
    showToast('Joined.');
    if (state.view.name === 'community') renderCommunity(id);
    else searchCommunities(document.getElementById('community-search')?.value || '');
  } catch (err) {
    showToast(err.message);
  }
}

async function leaveCommunity(id) {
  try {
    await api(`/api/communities/${id}/join`, { method: 'DELETE' });
    showToast('Left the community.');
    if (state.view.name === 'community') renderCommunity(id);
    else searchCommunities(document.getElementById('community-search')?.value || '');
  } catch (err) {
    showToast(err.message);
  }
}

function openCommunity(id) {
  stopThreadPolling();
  state.communityId = id;
  state.view = { name: 'community' };
  state.tab = 'communities';
  renderApp();
}

async function renderCommunity(id) {
  viewEl().innerHTML = '<div class="empty-state">Loading community…</div>';
  try {
    const [{ community }, { posts, next_cursor }] = await Promise.all([
      api('/api/communities/' + id),
      api(`/api/communities/${id}/posts?limit=20`),
    ]);
    registerPosts(posts);
    state.communityPosts = posts;
    state.communityCursor = next_cursor;
    viewEl().innerHTML = `
      <div class="back-row">
        <button class="icon-btn" onclick="goTab('communities')">←</button>
        <span class="title">${esc(community.name)}</span>
        <span style="margin-left:auto;color:var(--muted);font-size:13px">${community.member_count} members</span>
      </div>
      ${community.description ? `<div style="padding:12px 16px;border-bottom:1px solid var(--divider)">${esc(community.description)}</div>` : ''}
      ${community.joined
        ? composerHtml('community-' + id, id)
        : `<div class="join-prompt">Join this community to post in it.
            <div style="margin-top:10px"><button class="btn-outline" onclick="joinCommunity('${id}')">Join community</button></div></div>`}
      <div id="community-posts"></div>`;
    renderCommunityPosts();
  } catch (err) {
    viewEl().innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderCommunityPosts() {
  const box = document.getElementById('community-posts');
  if (!box) return;
  const posts = state.communityPosts || [];
  if (posts.length === 0) {
    box.innerHTML = '<div class="empty-state">No posts in this community yet.</div>';
    return;
  }
  box.innerHTML = posts.map(postCardHtml).join('') +
    (state.communityCursor
      ? '<button class="btn-outline load-more" onclick="loadMoreCommunityPosts()">Load more</button>' : '');
}

async function loadMoreCommunityPosts() {
  try {
    const { posts, next_cursor } = await api(
      `/api/communities/${state.communityId}/posts?limit=20&cursor=${encodeURIComponent(state.communityCursor)}`);
    registerPosts(posts);
    state.communityPosts = state.communityPosts.concat(posts);
    state.communityCursor = next_cursor;
    renderCommunityPosts();
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Wallet (SF Wallet) — super-app home, wallet, send/receive/top-up/scan
// ---------------------------------------------------------------------------
// Demo money in IDR, integer amounts only. Top-ups are simulated: no real
// money moves. QR codes use the vendored qrcode-generator (render) and
// jsQR (camera scan) libraries loaded in index.html.

state.txIndex = {};

function registerTxs(txs) {
  (txs || []).forEach((t) => { state.txIndex[t.id] = t; });
}

const idrFmt = new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0,
});
function fmtIDR(n) { return idrFmt.format(n || 0); }
function fmtNum(n) { return Number(n || 0).toLocaleString('id-ID'); }
function parseAmountInput(str) {
  const d = String(str || '').replace(/\D/g, '');
  return d ? parseInt(d, 10) : 0;
}
function onAmountInput(input) {
  const v = parseAmountInput(input.value);
  input.value = v ? fmtNum(v) : '';
}
function getAmount(inputId) {
  const input = document.getElementById(inputId);
  return input ? parseAmountInput(input.value) : 0;
}
function setAmount(inputId, amount) {
  const input = document.getElementById(inputId);
  if (input) input.value = fmtNum(amount);
}
function amountInputHtml(id) {
  return `<div class="amount-wrap"><span class="amount-prefix">Rp</span>
    <input id="${id}" class="amount-input" inputmode="numeric" autocomplete="off"
      placeholder="0" oninput="onAmountInput(this)"></div>`;
}
function amountChipsHtml(inputId) {
  return [10000, 20000, 50000, 100000].map((a) =>
    `<button type="button" class="chip" onclick="setAmount('${inputId}', ${a})">${fmtIDR(a)}</button>`).join('');
}
function newIdempotencyKey() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'key-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

async function loadWallet(force) {
  if (state.wallet && !force) return state.wallet;
  state.wallet = await api('/api/wallet');
  return state.wallet;
}

function balanceText(balance) {
  return state.walletHidden ? '••••••••' : fmtIDR(balance);
}

function toggleBalance() {
  state.walletHidden = !state.walletHidden;
  localStorage.setItem('sf_hide_balance', state.walletHidden ? '1' : '0');
  document.querySelectorAll('[data-balance]').forEach((el) => {
    el.textContent = balanceText(Number(el.dataset.balance));
  });
  document.querySelectorAll('.eye-btn').forEach((btn) => {
    btn.innerHTML = icon(state.walletHidden ? 'eyeOff' : 'eye', false, 20);
  });
}

function balanceCardHtml(wallet, withLink) {
  return `
  <div class="balance-card">
    <div class="balance-top">
      <span class="balance-label">SF Wallet balance</span>
      <button class="eye-btn" onclick="toggleBalance()" title="Hide/show balance">
        ${icon(state.walletHidden ? 'eyeOff' : 'eye', false, 20)}</button>
    </div>
    <div class="balance-amount" data-balance="${wallet.balance_idr}">${balanceText(wallet.balance_idr)}</div>
    ${withLink ? `<button class="link-btn" onclick="goTab('wallet')">View wallet →</button>` : ''}
  </div>`;
}

function quickActionsHtml(from) {
  return `
  <div class="quick-actions">
    <button class="qa-btn" onclick="openSend('${from}')"><span class="qa-icon">${icon('arrowUpRight', false, 22)}</span><span class="qa-label">Send</span></button>
    <button class="qa-btn" onclick="openReceive('${from}')"><span class="qa-icon">${icon('arrowDownLeft', false, 22)}</span><span class="qa-label">Receive</span></button>
    <button class="qa-btn" onclick="openTopUp('${from}')"><span class="qa-icon">${icon('plus', false, 22)}</span><span class="qa-label">Top Up</span></button>
    <button class="qa-btn" onclick="openScan('${from}')"><span class="qa-icon">${icon('scan', false, 22)}</span><span class="qa-label">Scan</span></button>
  </div>`;
}

function txRowHtml(t) {
  const label = t.type === 'deposit' ? 'Top up'
    : t.counterparty ? t.counterparty.display_name
    : t.type === 'payment' ? 'QR payment' : 'Transfer';
  const sub = t.description
    || (t.type === 'deposit' ? String(t.method || 'Top up').replace(/_/g, ' ')
      : t.type === 'payment' ? 'QR payment' : 'Transfer');
  const txIcon = t.type === 'deposit' ? 'plus'
    : t.direction === 'in' ? 'arrowDownLeft' : 'arrowUpRight';
  const sign = t.direction === 'in' ? '+' : '−';
  return `
  <button class="tx-row" onclick="openTxDetail('${t.id}')">
    <span class="tx-icon">${icon(txIcon, false, 20)}</span>
    <span class="tx-main">
      <span class="tx-name">${esc(label)}</span>
      <span class="tx-sub">${esc(sub)} · ${timeAgo(t.created_at)}</span>
    </span>
    <span class="tx-amount ${t.direction}">${sign}${fmtIDR(t.amount_idr)}</span>
  </button>`;
}

function backFromFlow() {
  goTab(state.walletReturn === 'home' ? 'home' : 'wallet');
}

// PIN entry: 6 boxes driven by one (visually hidden) numeric input.
// Tapping the boxes focuses the input; typing fills the boxes.
function pinEntryHtml(inputId, handler) {
  return `
  <div class="pin-entry">
    <div class="pin-boxes">
      ${[0, 1, 2, 3, 4, 5].map(() => '<span class="pin-box"></span>').join('')}
    </div>
    <input type="password" id="${inputId}" class="pin-hidden-input" inputmode="numeric"
      autocomplete="off" maxlength="6" oninput="${handler}">
  </div>`;
}

function focusPinInput(inputId) {
  const input = document.getElementById(inputId);
  if (input) input.focus();
}

function updatePinBoxes(input) {
  const boxes = input.parentElement.querySelectorAll('.pin-box');
  const v = input.value.replace(/\D/g, '');
  boxes.forEach((b, i) => b.classList.toggle('filled', i < v.length));
}

function qrImgHtml(text, size) {
  try {
    if (typeof qrcode === 'undefined') {
      return '<div class="empty-state">QR library failed to load.</div>';
    }
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return `<img class="qr-img" src="${qr.createDataURL(6, 8)}" alt="QR code" width="${size}" height="${size}">`;
  } catch (e) {
    return '<div class="empty-state">Could not generate the QR code.</div>';
  }
}

// ---------------------------------------------------------------------------
// Home tab
// ---------------------------------------------------------------------------

async function renderHome() {
  viewEl().innerHTML = `
    <div class="home-greet">
      ${avatarHtml(state.user)}
      <div><div class="home-hi">Hi, ${esc(firstName(state.user.display_name))}</div>
      <div class="home-sub">Welcome back</div></div>
    </div>
    <div id="home-balance"><div class="empty-state">Loading wallet…</div></div>
    ${quickActionsHtml('home')}
    <div class="section-label">Services</div>
    <div class="services-grid">
      <button class="service-tile" onclick="goTab('feed')"><span class="service-icon">${icon('home', false, 24)}</span><span>Feed</span></button>
      <button class="service-tile" onclick="goTab('communities')"><span class="service-icon">${icon('users', false, 24)}</span><span>Communities</span></button>
      <button class="service-tile" onclick="goTab('messages')"><span class="service-icon">${icon('message', false, 24)}</span><span>Messages</span></button>
      <button class="service-tile" onclick="goTab('profile')"><span class="service-icon">${icon('user', false, 24)}</span><span>Profile</span></button>
    </div>
    <div class="section-label">Recent activity</div>
    <div id="home-activity"><div class="empty-state">Loading…</div></div>
    <div class="section-label">Feed</div>
    <div id="home-feed"><div class="empty-state">Loading posts…</div></div>`;
  const [walletRes, txRes, feedRes] = await Promise.allSettled([
    loadWallet(true),
    api('/api/wallet/transactions?limit=5'),
    api('/api/feed?limit=5'),
  ]);
  const bal = document.getElementById('home-balance');
  if (bal) {
    bal.innerHTML = walletRes.status === 'fulfilled'
      ? balanceCardHtml(walletRes.value, true)
      : `<div class="empty-state">Could not load your wallet.</div>`;
  }
  const act = document.getElementById('home-activity');
  if (act) {
    if (txRes.status !== 'fulfilled') {
      act.innerHTML = '<div class="empty-state">Could not load activity.</div>';
    } else {
      const transactions = txRes.value.transactions || [];
      registerTxs(transactions);
      act.innerHTML = transactions.length === 0
        ? `<div class="empty-state">No wallet activity yet.<br>
           <button class="btn-outline" style="margin-top:8px" onclick="openTopUp('home')">Top up</button></div>`
        : transactions.map(txRowHtml).join('') +
          `<button class="btn-outline load-more" onclick="goTab('wallet')">See all activity</button>`;
    }
  }
  const feedBox = document.getElementById('home-feed');
  if (feedBox) {
    if (feedRes.status !== 'fulfilled') {
      feedBox.innerHTML = '<div class="empty-state">Could not load posts.</div>';
    } else {
      const posts = feedRes.value.posts || [];
      registerPosts(posts);
      feedBox.innerHTML = posts.length === 0
        ? '<div class="empty-state">No posts yet.</div>'
        : posts.map(postCardHtml).join('') +
          `<button class="btn-outline load-more" onclick="goTab('feed')">View all posts</button>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet tab
// ---------------------------------------------------------------------------

function walletFilterChipsHtml() {
  const labels = { all: 'All', in: 'In', out: 'Out', deposit: 'Top up' };
  return ['all', 'in', 'out', 'deposit'].map((f) =>
    `<button class="chip ${state.walletFilter === f ? 'active' : ''}" onclick="setWalletFilter('${f}')">${labels[f]}</button>`).join('');
}

async function renderWallet() {
  viewEl().innerHTML = `
    <div id="wallet-balance"><div class="empty-state">Loading wallet…</div></div>
    ${quickActionsHtml('wallet')}
    <button class="row-item" onclick="openPinSetup('wallet')">
      <span class="tx-icon">${icon('edit', false, 20)}</span>
      <div class="row-main"><div class="row-name" id="pin-row-label">Set wallet PIN</div>
      <div class="row-sub">Required for sending money and paying</div></div>
      <span class="row-time">${icon('chevronRight', false, 18)}</span>
    </button>
    <div class="filter-chips" id="wallet-filters">${walletFilterChipsHtml()}</div>
    <div id="wallet-history"><div class="empty-state">Loading…</div></div>`;
  try {
    const wallet = await loadWallet(true);
    const bal = document.getElementById('wallet-balance');
    if (bal) bal.innerHTML = balanceCardHtml(wallet, false);
    const pinLabel = document.getElementById('pin-row-label');
    if (pinLabel) pinLabel.textContent = wallet.has_pin ? 'Change wallet PIN' : 'Set wallet PIN';
  } catch (err) {
    const bal = document.getElementById('wallet-balance');
    if (bal) bal.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
  await loadWalletHistory(false);
}

async function loadWalletHistory(append) {
  const box = document.getElementById('wallet-history');
  const url = '/api/wallet/transactions?limit=20&filter=' + state.walletFilter +
    (append && state.walletCursor ? '&before=' + encodeURIComponent(state.walletCursor) : '');
  try {
    const { transactions, next_cursor } = await api(url);
    registerTxs(transactions);
    state.walletTxs = append ? state.walletTxs.concat(transactions) : transactions;
    state.walletCursor = next_cursor;
    renderWalletHistory();
  } catch (err) {
    if (box && !append) box.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    else showToast(err.message);
  }
}

function renderWalletHistory() {
  const box = document.getElementById('wallet-history');
  if (!box) return;
  if (state.walletTxs.length === 0) {
    box.innerHTML = `<div class="empty-state">No transactions yet.<br>
      <div style="margin-top:10px;display:flex;gap:8px;justify-content:center">
        <button class="btn-outline" onclick="openTopUp('wallet')">Top up</button>
        <button class="btn-outline" onclick="openReceive('wallet')">Receive</button>
      </div></div>`;
    return;
  }
  box.innerHTML = state.walletTxs.map(txRowHtml).join('') +
    (state.walletCursor
      ? '<button class="btn-outline load-more" onclick="loadWalletHistory(true)">Load more</button>' : '');
}

function setWalletFilter(f) {
  state.walletFilter = f;
  state.walletTxs = [];
  state.walletCursor = null;
  const chips = document.getElementById('wallet-filters');
  if (chips) chips.innerHTML = walletFilterChipsHtml();
  loadWalletHistory(false);
}

function openTxDetail(txId) {
  const tx = state.txIndex[txId];
  if (!tx) return;
  state.walletTxDetail = tx;
  state.view = { name: 'wallet-tx' };
  renderApp();
}

function renderTxDetail() {
  const t = state.walletTxDetail;
  if (!t) { goTab('wallet'); return; }
  const sign = t.direction === 'in' ? '+' : '−';
  const title = t.type === 'deposit' ? 'Top up'
    : t.type === 'payment' ? 'QR payment' : 'Transfer';
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="goTab('wallet')">←</button>
      <span class="title">Transaction detail</span></div>
    <div class="tx-detail">
      <div class="tx-detail-amount ${t.direction}">${sign}${fmtIDR(t.amount_idr)}</div>
      <div class="tx-detail-type">${title} · ${esc(t.status)}</div>
      ${t.counterparty ? `
      <div class="detail-row"><span>Counterparty</span>
        <span style="display:flex;align-items:center;gap:8px">${avatarHtml(t.counterparty, 'sm')}${esc(t.counterparty.display_name)}</span></div>` : ''}
      <div class="detail-row"><span>Date</span><span>${new Date(t.created_at).toLocaleString()}</span></div>
      ${t.description ? `<div class="detail-row"><span>Note</span><span>${esc(t.description)}</span></div>` : ''}
      ${t.method ? `<div class="detail-row"><span>Method</span><span>${esc(String(t.method).replace(/_/g, ' '))}</span></div>` : ''}
      <div class="detail-row"><span>Fee</span><span>${fmtIDR(t.fee_idr)}</span></div>
      <div class="detail-row"><span>Reference</span><span>${esc(t.reference || t.id)}</span></div>
      <div class="detail-row"><span>Transaction ID</span>
        <span style="word-break:break-all;font-size:12px">${esc(t.id)}</span></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Send money flow
// ---------------------------------------------------------------------------

function openSend(from) {
  state.walletReturn = from || 'wallet';
  state.sendFlow = { step: 'recipient', recipient: null, amount: 0, note: '', result: null, error: '' };
  state.tab = 'wallet';
  state.view = { name: 'wallet-send' };
  renderApp();
}

function sendGoStep(step) {
  state.sendFlow.step = step;
  renderSend();
}

function sendAgain() {
  openSend(state.walletReturn);
}

function renderSend() {
  const f = state.sendFlow;
  if (!f) { backFromFlow(); return; }
  if (f.step === 'recipient') renderSendRecipient();
  else if (f.step === 'amount') renderSendAmount();
  else if (f.step === 'confirm') renderSendConfirm();
  else if (f.step === 'pin') renderSendPin();
  else if (f.step === 'success') renderSendSuccess();
}

async function renderSendRecipient() {
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="backFromFlow()">←</button>
      <span class="title">Send money</span></div>
    <div class="search-box"><input id="send-search" placeholder="Search people…"
      oninput="filterSendPeople(this.value)"></div>
    <div id="send-people"><div class="empty-state">Loading people…</div></div>`;
  try {
    const [{ users }, { transactions }] = await Promise.all([
      api('/api/users'),
      api('/api/wallet/transactions?limit=20'),
    ]);
    state.sendPeople = users;
    const seen = new Set();
    const recent = [];
    (transactions || []).forEach((t) => {
      if (t.counterparty && !seen.has(t.counterparty.id)) {
        seen.add(t.counterparty.id);
        recent.push(t.counterparty);
      }
    });
    state.sendRecent = recent;
    renderSendPeopleList('');
  } catch (err) {
    const box = document.getElementById('send-people');
    if (box) box.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderSendPeopleList(query) {
  const box = document.getElementById('send-people');
  if (!box) return;
  const q = (query || '').trim().toLowerCase();
  const people = (state.sendPeople || []).filter((u) =>
    !q || u.display_name.toLowerCase().includes(q));
  const recent = (state.sendRecent || []).filter((u) =>
    !q || u.display_name.toLowerCase().includes(q));
  box.innerHTML = `
    ${recent.length > 0 ? '<div class="section-label">Recent</div>' +
      recent.map((u) => sendPersonRow(u)).join('') : ''}
    <div class="section-label">All people</div>
    ${people.length === 0 ? '<div class="empty-state">No matching people.</div>' : ''}
    ${people.map((u) => sendPersonRow(u)).join('')}`;
}

function sendPersonRow(u) {
  return `
    <button class="row-item" onclick="pickSendRecipient('${u.id}')">
      ${avatarHtml(u)}
      <div class="row-main"><div class="row-name">${esc(u.display_name)}${verifiedBadge(u)}</div></div>
      <span class="row-time">${icon('chevronRight', false, 18)}</span>
    </button>`;
}

function filterSendPeople(q) { renderSendPeopleList(q); }

function pickSendRecipient(userId) {
  const u = (state.sendPeople || []).find((x) => x.id === userId)
    || (state.sendRecent || []).find((x) => x.id === userId);
  if (!u) return;
  state.sendFlow.recipient = u;
  state.sendFlow.step = 'amount';
  renderSend();
}

function renderSendAmount() {
  const f = state.sendFlow;
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="sendGoStep('recipient')">←</button>
      <span class="title">Send money</span></div>
    <div class="send-recipient">
      ${avatarHtml(f.recipient)}
      <div><div class="row-name">${esc(f.recipient.display_name)}${verifiedBadge(f.recipient)}</div>
      <div class="row-sub">Recipient</div></div>
    </div>
    <div class="amount-section">
      <div class="field-label">Amount</div>
      ${amountInputHtml('send-amount')}
      <div class="chip-row">${amountChipsHtml('send-amount')}</div>
      <div class="hint">Min ${fmtIDR(1000)} · Max ${fmtIDR(5000000)}</div>
    </div>
    <div class="field" style="padding:0 16px"><label>Note (optional)</label>
      <input id="send-note" maxlength="200" placeholder="What's this for?" value="${esc(f.note || '')}"></div>
    <div class="form-error" id="send-error">${esc(f.error || '')}</div>
    <div style="padding:0 16px"><button class="btn-primary" onclick="sendAmountNext()">Continue</button></div>`;
  const input = document.getElementById('send-amount');
  if (f.amount) input.value = fmtNum(f.amount);
  if (input) input.focus();
}

function sendAmountNext() {
  const f = state.sendFlow;
  const amount = getAmount('send-amount');
  const errEl = document.getElementById('send-error');
  if (!amount || amount < 1000 || amount > 5000000) {
    if (errEl) errEl.textContent = 'Enter an amount between Rp1.000 and Rp5.000.000.';
    return;
  }
  f.amount = amount;
  f.note = (document.getElementById('send-note')?.value || '').trim();
  f.error = '';
  f.step = 'confirm';
  renderSend();
}

function renderSendConfirm() {
  const f = state.sendFlow;
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="sendGoStep('amount')">←</button>
      <span class="title">Confirm send</span></div>
    <div class="confirm-card">
      <div class="confirm-recipient">${avatarHtml(f.recipient)}
        <div><div class="row-name">${esc(f.recipient.display_name)}</div>
        <div class="row-sub">Recipient</div></div></div>
      <div class="detail-row"><span>Amount</span><span class="detail-strong">${fmtIDR(f.amount)}</span></div>
      <div class="detail-row"><span>Fee</span><span>${fmtIDR(0)}</span></div>
      <div class="detail-row"><span>Total</span><span class="detail-strong">${fmtIDR(f.amount)}</span></div>
      ${f.note ? `<div class="detail-row"><span>Note</span><span>${esc(f.note)}</span></div>` : ''}
    </div>
    <div class="form-error" id="send-error">${esc(f.error || '')}</div>
    <div style="padding:0 16px"><button class="btn-primary" onclick="sendConfirmNext()">Confirm &amp; pay</button></div>`;
}

async function sendConfirmNext() {
  const f = state.sendFlow;
  // No PIN yet? Route to PIN setup first, then come back here.
  try {
    const wallet = await loadWallet(true);
    if (!wallet.has_pin) {
      openPinSetup('send');
      return;
    }
  } catch (err) {
    showToast(err.message);
    return;
  }
  f.step = 'pin';
  renderSend();
}

function renderSendPin() {
  const f = state.sendFlow;
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="sendGoStep('confirm')">←</button>
      <span class="title">Enter wallet PIN</span></div>
    <div class="pin-screen">
      <div class="pin-prompt">Enter your 6-digit PIN to send <b>${fmtIDR(f.amount)}</b>
        to <b>${esc(f.recipient.display_name)}</b>.</div>
      ${pinEntryHtml('send-pin', 'onSendPinInput(this)')}
      <div class="form-error" id="send-error">${esc(f.error || '')}</div>
    </div>`;
  focusPinInput('send-pin');
}

async function onSendPinInput(input) {
  updatePinBoxes(input);
  const pin = input.value.replace(/\D/g, '');
  input.value = pin;
  if (pin.length !== 6) return;
  input.disabled = true;
  const f = state.sendFlow;
  f.error = '';
  try {
    const res = await api('/api/wallet/transfers', {
      method: 'POST',
      body: {
        recipient: f.recipient.id, amountIdr: f.amount,
        description: f.note || undefined,
        idempotencyKey: newIdempotencyKey(), pin,
      },
    });
    state.wallet = { ...(state.wallet || {}), balance_idr: res.balance_idr };
    f.result = res;
    f.step = 'success';
    renderSend();
  } catch (err) {
    if (err.code === 'PIN_REQUIRED') {
      openPinSetup('send');
      return;
    }
    f.error = err.message;
    input.disabled = false;
    input.value = '';
    updatePinBoxes(input);
    const errEl = document.getElementById('send-error');
    if (errEl) errEl.textContent = err.message;
    input.focus();
  }
}

function renderSendSuccess() {
  const f = state.sendFlow;
  const res = f.result;
  viewEl().innerHTML = `
    <div class="success-screen">
      <div class="success-check">${icon('check', false, 40)}</div>
      <div class="success-title">Sent!</div>
      <div class="success-amount">${fmtIDR(f.amount)}</div>
      <div class="success-sub">to ${esc(f.recipient.display_name)}</div>
      <div class="detail-row"><span>New balance</span><span>${fmtIDR(res.balance_idr)}</span></div>
      <div class="detail-row"><span>Reference</span><span>${esc(res.transaction.reference || res.transaction.id)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn-outline" style="flex:1" onclick="sendAgain()">Send again</button>
        <button class="btn-primary" style="flex:1;margin-top:0" onclick="backFromFlow()">Done</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Receive money (static QR + fixed-amount request QR)
// ---------------------------------------------------------------------------

function openReceive(from) {
  state.walletReturn = from || 'wallet';
  state.receiveFlow = { mode: 'qr', payload: null, displayName: '', request: null, error: '' };
  state.tab = 'wallet';
  state.view = { name: 'wallet-receive' };
  renderApp();
}

function renderReceive() {
  const f = state.receiveFlow;
  if (!f) { backFromFlow(); return; }
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="backFromFlow()">←</button>
      <span class="title">Receive money</span></div>
    <div class="auth-tabs" style="margin:12px 16px">
      <button class="auth-tab ${f.mode === 'qr' ? 'active' : ''}" onclick="setReceiveMode('qr')">My QR</button>
      <button class="auth-tab ${f.mode === 'request' ? 'active' : ''}" onclick="setReceiveMode('request')">Request amount</button>
    </div>
    <div id="receive-body"></div>`;
  if (f.mode === 'qr') renderReceiveQr();
  else renderReceiveRequest();
}

function setReceiveMode(mode) {
  stopReceiveTimer();
  state.receiveFlow.mode = mode;
  renderReceive();
}

async function renderReceiveQr() {
  const f = state.receiveFlow;
  const box = document.getElementById('receive-body');
  if (!box) return;
  box.innerHTML = '<div class="empty-state">Loading your QR code…</div>';
  try {
    const { payload, display_name } = await api('/api/wallet/receive-qr');
    f.payload = payload;
    f.displayName = display_name;
    box.innerHTML = `
      <div class="qr-box">
        ${qrImgHtml(payload, 220)}
        <div class="qr-name">${esc(display_name)}</div>
        <div class="qr-note">Ask the sender to scan this code.<br>They choose the amount.</div>
        <button class="btn-outline" onclick="copyPayload()">Copy code</button>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderReceiveRequest() {
  const f = state.receiveFlow;
  const box = document.getElementById('receive-body');
  if (!box) return;
  if (f.request) {
    const req = f.request;
    box.innerHTML = `
      <div class="qr-box">
        ${qrImgHtml(req.payload, 220)}
        <div class="qr-amount">${fmtIDR(req.amount_idr)}</div>
        ${req.note ? `<div class="qr-note">${esc(req.note)}</div>` : ''}
        <div class="qr-countdown" id="request-countdown"></div>
        <button class="btn-outline" onclick="copyRequestPayload()">Copy code</button>
        <button class="btn-outline" style="margin-top:8px" onclick="newPaymentRequest()">New request</button>
      </div>`;
    startReceiveCountdown(req.expires_at);
    return;
  }
  box.innerHTML = `
    <div class="amount-section">
      <div class="field-label">Amount to request</div>
      ${amountInputHtml('request-amount')}
      <div class="chip-row">${amountChipsHtml('request-amount')}</div>
      <div class="hint">Min ${fmtIDR(1000)} · Max ${fmtIDR(5000000)} · QR expires in 15 minutes</div>
    </div>
    <div class="field" style="padding:0 16px"><label>Note (optional)</label>
      <input id="request-note" maxlength="200" placeholder="What's this for?"></div>
    <div class="form-error" id="receive-error">${esc(f.error || '')}</div>
    <div style="padding:0 16px"><button class="btn-primary" onclick="createPaymentRequest()">Generate QR</button></div>`;
}

function newPaymentRequest() {
  stopReceiveTimer();
  state.receiveFlow.request = null;
  renderReceiveRequest();
}

async function createPaymentRequest() {
  const f = state.receiveFlow;
  const amount = getAmount('request-amount');
  const errEl = document.getElementById('receive-error');
  if (!amount || amount < 1000 || amount > 5000000) {
    if (errEl) errEl.textContent = 'Enter an amount between Rp1.000 and Rp5.000.000.';
    return;
  }
  const note = (document.getElementById('request-note')?.value || '').trim();
  try {
    const req = await api('/api/wallet/payment-requests', {
      method: 'POST', body: { amountIdr: amount, note: note || undefined },
    });
    f.request = { ...req, note };
    f.error = '';
    renderReceiveRequest();
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
  }
}

function startReceiveCountdown(expiresAt) {
  stopReceiveTimer();
  const tick = () => {
    const el = document.getElementById('request-countdown');
    if (!el) { stopReceiveTimer(); return; }
    const left = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    if (left <= 0) {
      el.textContent = 'Expired — generate a new request.';
      stopReceiveTimer();
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `Expires in ${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  state.receiveTimer = setInterval(tick, 1000);
}

function stopReceiveTimer() {
  if (state.receiveTimer) {
    clearInterval(state.receiveTimer);
    state.receiveTimer = null;
  }
}

function copyPayload() {
  const text = (state.receiveFlow && state.receiveFlow.payload) || '';
  copyText(text);
}

function copyRequestPayload() {
  const text = (state.receiveFlow && state.receiveFlow.request)
    ? state.receiveFlow.request.payload : '';
  copyText(text);
}

function copyText(text) {
  if (!text) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Code copied.'));
  } else {
    showToast(text);
  }
}

// ---------------------------------------------------------------------------
// Top up (simulated — no real money moves)
// ---------------------------------------------------------------------------

function openTopUp(from) {
  state.walletReturn = from || 'wallet';
  state.topupFlow = { step: 'form', amount: 0, method: 'bank_transfer', result: null, error: '' };
  state.tab = 'wallet';
  state.view = { name: 'wallet-topup' };
  renderApp();
}

const TOPUP_METHODS = [
  { id: 'bank_transfer', label: 'Bank Transfer', sub: 'BCA · Mandiri · BRI' },
  { id: 'e_wallet', label: 'E-wallet', sub: 'GoPay · OVO · DANA' },
  { id: 'virtual_account', label: 'Virtual Account', sub: 'Instant VA number' },
];

function renderTopUp() {
  const f = state.topupFlow;
  if (!f) { backFromFlow(); return; }
  if (f.step === 'success') { renderTopUpSuccess(); return; }
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="backFromFlow()">←</button>
      <span class="title">Top up</span></div>
    <div class="demo-notice">Simulated top-up — no real money moves. Your balance is demo money.</div>
    <div class="amount-section">
      <div class="field-label">Amount</div>
      ${amountInputHtml('topup-amount')}
      <div class="chip-row">${amountChipsHtml('topup-amount')}</div>
      <div class="hint">Min ${fmtIDR(1000)} · Max ${fmtIDR(5000000)}</div>
    </div>
    <div class="section-label">Payment method (demo)</div>
    <div style="padding:0 16px 12px;display:flex;flex-direction:column;gap:8px">
      ${TOPUP_METHODS.map((m) => `
        <button type="button" class="method-card ${f.method === m.id ? 'selected' : ''}"
          onclick="pickTopUpMethod('${m.id}')">
          <span class="method-icon">${icon('card', false, 22)}</span>
          <span class="method-main"><span class="method-label">${m.label}</span>
          <span class="method-sub">${m.sub}</span></span>
          ${f.method === m.id ? `<span class="method-check">${icon('check', false, 20)}</span>` : ''}
        </button>`).join('')}
    </div>
    <div class="form-error" id="topup-error">${esc(f.error || '')}</div>
    <div style="padding:0 16px 16px"><button class="btn-primary" id="topup-submit" onclick="submitTopUp()">Top up</button></div>`;
  const input = document.getElementById('topup-amount');
  if (f.amount) input.value = fmtNum(f.amount);
}

function pickTopUpMethod(id) {
  state.topupFlow.method = id;
  renderTopUp();
}

async function submitTopUp() {
  const f = state.topupFlow;
  const amount = getAmount('topup-amount');
  const errEl = document.getElementById('topup-error');
  if (!amount || amount < 1000 || amount > 5000000) {
    if (errEl) errEl.textContent = 'Enter an amount between Rp1.000 and Rp5.000.000.';
    return;
  }
  const btn = document.getElementById('topup-submit');
  btn.disabled = true;
  try {
    const res = await api('/api/wallet/deposits', {
      method: 'POST',
      body: { amountIdr: amount, method: f.method, idempotencyKey: newIdempotencyKey() },
    });
    state.wallet = { ...(state.wallet || {}), balance_idr: res.balance_idr };
    f.amount = amount;
    f.result = res;
    f.step = 'success';
    renderTopUp();
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
    btn.disabled = false;
  }
}

function renderTopUpSuccess() {
  const f = state.topupFlow;
  viewEl().innerHTML = `
    <div class="success-screen">
      <div class="success-check">${icon('check', false, 40)}</div>
      <div class="success-title">Top-up successful</div>
      <div class="success-amount">${fmtIDR(f.amount)}</div>
      <div class="success-sub">added to your wallet (demo)</div>
      <div class="detail-row"><span>New balance</span><span>${fmtIDR(f.result.balance_idr)}</span></div>
      <div class="detail-row"><span>Reference</span><span>${esc(f.result.transaction.reference || f.result.transaction.id)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn-outline" style="flex:1" onclick="goTab('wallet')">View wallet</button>
        <button class="btn-primary" style="flex:1;margin-top:0" onclick="backFromFlow()">Done</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Scan QR (camera via jsQR + manual code entry)
// ---------------------------------------------------------------------------

function openScan(from) {
  state.walletReturn = from || 'wallet';
  state.scanError = null;
  state.tab = 'wallet';
  state.view = { name: 'wallet-scan' };
  renderApp();
}

function scanAgain() {
  openScan(state.walletReturn);
}

function renderScan() {
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="backFromFlow()">←</button>
      <span class="title">Scan QR</span></div>
    <div class="scan-box">
      <video id="scan-video" playsinline muted></video>
      <canvas id="scan-canvas" style="display:none"></canvas>
      <div class="scan-frame"></div>
      <div class="scan-hint" id="scan-hint">Point your camera at a payment QR code</div>
    </div>
    <div class="form-error" id="scan-error">${esc(state.scanError || '')}</div>
    <div class="section-label">Or enter a code manually</div>
    <div style="padding:0 16px;display:flex;gap:8px">
      <input id="scan-manual" placeholder="SF-PAY:…" autocomplete="off"
        style="flex:1;min-width:0;padding:11px 12px;border:1px solid var(--divider);border-radius:8px;background:var(--input-bg);color:var(--text);outline:none">
      <button class="btn-outline" onclick="scanManual()">Continue</button>
    </div>`;
  startScan();
}

function scanManual() {
  const input = document.getElementById('scan-manual');
  const payload = (input?.value || '').trim();
  if (!payload) {
    const errEl = document.getElementById('scan-error');
    if (errEl) errEl.textContent = 'Paste a payment code first.';
    return;
  }
  onScanPayload(payload);
}

async function startScan() {
  const video = document.getElementById('scan-video');
  const canvas = document.getElementById('scan-canvas');
  const hint = document.getElementById('scan-hint');
  if (!video || !canvas) return;
  if (typeof jsQR === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    if (hint) hint.textContent = 'Camera scanning is not available here. Use the manual code entry below.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    // The user may have left the view while permission was pending.
    if (!document.getElementById('scan-video')) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    state.scanStream = stream;
    video.srcObject = stream;
    await video.play();
    const ctx = canvas.getContext('2d');
    const tick = () => {
      if (!state.scanStream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          onScanPayload(code.data);
          return;
        }
      }
      state.scanRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    if (hint) hint.textContent = 'Camera unavailable or permission denied. Use the manual code entry below.';
  }
}

function stopScan() {
  if (state.scanRaf) {
    cancelAnimationFrame(state.scanRaf);
    state.scanRaf = null;
  }
  if (state.scanStream) {
    state.scanStream.getTracks().forEach((t) => t.stop());
    state.scanStream = null;
  }
}

async function onScanPayload(payload) {
  stopScan();
  try {
    const resolved = await api('/api/wallet/resolve-qr', {
      method: 'POST', body: { payload },
    });
    state.payFlow = {
      payload, resolved,
      amount: resolved.amount_idr || 0,
      step: 'confirm', result: null, error: '',
    };
    state.view = { name: 'wallet-pay' };
    renderApp();
  } catch (err) {
    state.scanError = err.message;
    // Stay on the scan view so the user can retry.
    state.view = { name: 'wallet-scan' };
    renderApp();
  }
}

// ---------------------------------------------------------------------------
// Pay a scanned QR
// ---------------------------------------------------------------------------

function renderPay() {
  const f = state.payFlow;
  if (!f) { backFromFlow(); return; }
  if (f.step === 'confirm') renderPayConfirm();
  else if (f.step === 'pin') renderPayPin();
  else if (f.step === 'success') renderPaySuccess();
}

function payGoStep(step) {
  state.payFlow.step = step;
  renderPay();
}

function renderPayConfirm() {
  const f = state.payFlow;
  const r = f.resolved;
  const fixed = r.amount_idr !== null && r.amount_idr !== undefined;
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="scanAgain()">←</button>
      <span class="title">Confirm payment</span></div>
    <div class="confirm-card">
      <div class="confirm-recipient">${avatarHtml(r.recipient)}
        <div><div class="row-name">${esc(r.recipient.display_name)}${verifiedBadge(r.recipient)}</div>
        <div class="row-sub">Pay to</div></div></div>
      ${fixed ? `
        <div class="detail-row"><span>Amount</span><span class="detail-strong">${fmtIDR(r.amount_idr)}</span></div>` : `
        <div class="field-label" style="margin-top:8px">Amount</div>
        ${amountInputHtml('pay-amount')}
        <div class="chip-row">${amountChipsHtml('pay-amount')}</div>
        <div class="hint">Min ${fmtIDR(1000)} · Max ${fmtIDR(5000000)}</div>`}
      ${r.note ? `<div class="detail-row"><span>Note</span><span>${esc(r.note)}</span></div>` : ''}
      <div class="detail-row"><span>Fee</span><span>${fmtIDR(0)}</span></div>
    </div>
    <div class="form-error" id="pay-error">${esc(f.error || '')}</div>
    <div style="padding:0 16px"><button class="btn-primary" onclick="payConfirmNext()">Confirm &amp; pay</button></div>`;
  if (!fixed && f.amount) {
    const input = document.getElementById('pay-amount');
    if (input) input.value = fmtNum(f.amount);
  }
}

async function payConfirmNext() {
  const f = state.payFlow;
  const r = f.resolved;
  if (r.amount_idr === null || r.amount_idr === undefined) {
    const amount = getAmount('pay-amount');
    const errEl = document.getElementById('pay-error');
    if (!amount || amount < 1000 || amount > 5000000) {
      if (errEl) errEl.textContent = 'Enter an amount between Rp1.000 and Rp5.000.000.';
      return;
    }
    f.amount = amount;
  } else {
    f.amount = r.amount_idr;
  }
  f.error = '';
  try {
    const wallet = await loadWallet(true);
    if (!wallet.has_pin) {
      openPinSetup('pay');
      return;
    }
  } catch (err) {
    showToast(err.message);
    return;
  }
  f.step = 'pin';
  renderPay();
}

function renderPayPin() {
  const f = state.payFlow;
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="payGoStep('confirm')">←</button>
      <span class="title">Enter wallet PIN</span></div>
    <div class="pin-screen">
      <div class="pin-prompt">Enter your 6-digit PIN to pay <b>${fmtIDR(f.amount)}</b>
        to <b>${esc(f.resolved.recipient.display_name)}</b>.</div>
      ${pinEntryHtml('pay-pin', 'onPayPinInput(this)')}
      <div class="form-error" id="pay-error">${esc(f.error || '')}</div>
    </div>`;
  focusPinInput('pay-pin');
}

async function onPayPinInput(input) {
  updatePinBoxes(input);
  const pin = input.value.replace(/\D/g, '');
  input.value = pin;
  if (pin.length !== 6) return;
  input.disabled = true;
  const f = state.payFlow;
  f.error = '';
  try {
    const res = await api('/api/wallet/pay', {
      method: 'POST',
      body: {
        payload: f.payload,
        amountIdr: (f.resolved.amount_idr === null || f.resolved.amount_idr === undefined)
          ? f.amount : undefined,
        idempotencyKey: newIdempotencyKey(), pin,
      },
    });
    state.wallet = { ...(state.wallet || {}), balance_idr: res.balance_idr };
    f.result = res;
    f.step = 'success';
    renderPay();
  } catch (err) {
    if (err.code === 'PIN_REQUIRED') {
      openPinSetup('pay');
      return;
    }
    // The QR may have expired or been redeemed meanwhile: back to scan.
    if (/expired|already used|not recognized|Invalid QR/.test(err.message)) {
      state.scanError = err.message;
      state.view = { name: 'wallet-scan' };
      renderApp();
      return;
    }
    f.error = err.message;
    input.disabled = false;
    input.value = '';
    updatePinBoxes(input);
    const errEl = document.getElementById('pay-error');
    if (errEl) errEl.textContent = err.message;
    input.focus();
  }
}

function renderPaySuccess() {
  const f = state.payFlow;
  const res = f.result;
  viewEl().innerHTML = `
    <div class="success-screen">
      <div class="success-check">${icon('check', false, 40)}</div>
      <div class="success-title">Payment successful</div>
      <div class="success-amount">${fmtIDR(f.amount)}</div>
      <div class="success-sub">to ${esc(f.resolved.recipient.display_name)}</div>
      <div class="detail-row"><span>New balance</span><span>${fmtIDR(res.balance_idr)}</span></div>
      <div class="detail-row"><span>Reference</span><span>${esc(res.transaction.reference || res.transaction.id)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn-outline" style="flex:1" onclick="scanAgain()">Scan again</button>
        <button class="btn-primary" style="flex:1;margin-top:0" onclick="backFromFlow()">Done</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Wallet PIN setup / change
// ---------------------------------------------------------------------------

function openPinSetup(returnTo) {
  const hasPin = state.wallet && state.wallet.has_pin;
  state.pinFlow = {
    mode: hasPin ? 'change' : 'setup',
    step: hasPin ? 'current' : 'new',
    currentPin: '', newPin: '', error: '',
    returnTo: returnTo || 'wallet',
  };
  state.tab = 'wallet';
  state.view = { name: 'wallet-pin' };
  renderApp();
}

function renderPinSetup() {
  const f = state.pinFlow;
  if (!f) { goTab('wallet'); return; }
  const titles = {
    current: 'Enter your current PIN',
    new: f.mode === 'change' ? 'Enter a new 6-digit PIN' : 'Set your wallet PIN',
    confirm: 'Confirm your new PIN',
  };
  const prompts = {
    current: 'Enter your current 6-digit PIN to continue.',
    new: 'Choose a 6-digit PIN. You will use it to send money and pay.',
    confirm: 'Enter the new PIN once more to confirm it.',
  };
  viewEl().innerHTML = `
    <div class="back-row"><button class="icon-btn" onclick="pinSetupBack()">←</button>
      <span class="title">${titles[f.step]}</span></div>
    <div class="pin-screen">
      <div class="pin-prompt">${prompts[f.step]}</div>
      ${pinEntryHtml('pin-setup', 'onPinSetupInput(this)')}
      <div class="form-error" id="pin-error">${esc(f.error || '')}</div>
    </div>`;
  focusPinInput('pin-setup');
}

function pinSetupBack() {
  const f = state.pinFlow;
  if (f.step === 'confirm') {
    f.step = 'new';
    f.newPin = '';
    renderPinSetup();
    return;
  }
  if (f.step === 'new' && f.mode === 'change') {
    f.step = 'current';
    renderPinSetup();
    return;
  }
  pinSetupDone(false);
}

function pinSetupDone(success) {
  const f = state.pinFlow;
  const ret = f ? f.returnTo : 'wallet';
  state.pinFlow = null;
  if (success) {
    if (state.wallet) state.wallet.has_pin = true;
    showToast('Wallet PIN saved.');
  }
  if (ret === 'send' && state.sendFlow) {
    state.sendFlow.step = 'confirm';
    state.view = { name: 'wallet-send' };
    renderApp();
  } else if (ret === 'pay' && state.payFlow) {
    state.payFlow.step = 'confirm';
    state.view = { name: 'wallet-pay' };
    renderApp();
  } else {
    goTab('wallet');
  }
}

async function onPinSetupInput(input) {
  updatePinBoxes(input);
  const pin = input.value.replace(/\D/g, '');
  input.value = pin;
  if (pin.length !== 6) return;
  const f = state.pinFlow;
  if (f.step === 'current') {
    f.currentPin = pin;
    f.step = 'new';
    f.error = '';
    renderPinSetup();
    return;
  }
  if (f.step === 'new') {
    f.newPin = pin;
    f.step = 'confirm';
    f.error = '';
    renderPinSetup();
    return;
  }
  // Confirm step.
  if (pin !== f.newPin) {
    f.error = 'PINs do not match. Try again.';
    f.newPin = '';
    f.step = 'new';
    renderPinSetup();
    return;
  }
  input.disabled = true;
  try {
    await api('/api/wallet/pin', {
      method: 'POST',
      body: f.mode === 'change'
        ? { pin: f.newPin, currentPin: f.currentPin }
        : { pin: f.newPin },
    });
    pinSetupDone(true);
  } catch (err) {
    f.error = err.message;
    // A wrong current PIN sends the user back to the current-PIN step.
    if (f.mode === 'change' && /Current PIN/.test(err.message)) {
      f.step = 'current';
      f.currentPin = '';
      f.newPin = '';
    }
    renderPinSetup();
  }
}

// ---------------------------------------------------------------------------
// Boot: validate the stored session, then go straight into the app.
// ---------------------------------------------------------------------------

async function boot() {
  if (!state.token) {
    showAuth('login');
    return;
  }
  try {
    const { user } = await api('/api/auth/session');
    state.user = user;
    renderApp();
  } catch {
    // api() already showed the auth screen on 401; network errors land here.
    if (state.token) showAuth('login');
  }
}

boot();
