'use strict';
/* Social Feed — single-page frontend (vanilla JS, no build step).
   Talks to the Express API in ../server.js. Session token lives in
   localStorage; on load the app validates it and goes straight in. */

const app = document.getElementById('app');

const state = {
  token: localStorage.getItem('sf_token') || null,
  user: null,
  tab: 'feed',
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
  view: { name: 'feed' }, // feed | communities | community | messages | thread | profile
  profileId: null,
  communityId: null,
  conversationId: null,
  threadOther: null,
  threadTimer: null,
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
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

// ---------------------------------------------------------------------------
// Auth screens
// ---------------------------------------------------------------------------

function showAuth(mode, dir) {
  stopThreadPolling();
  state.view = { name: 'auth' };
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
          ${captchaFieldHtml()}
          <button class="btn-primary" id="auth-submit" type="submit">Log in</button>
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
        ${captchaFieldHtml()}
        <button class="btn-primary" id="auth-submit" type="submit">Create account</button>
      </form>`}
    </div>`;
  // Fetch a fresh math question whenever the form shows one.
  if ((mode === 'login' && step === 2) || mode === 'register') loadChallenge();
}

function authError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg || '';
}

// ---------------------------------------------------------------------------
// Math CAPTCHA: the question comes from the server; the answer never does.
// ---------------------------------------------------------------------------

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
  const q = document.getElementById('captcha-question');
  if (q) q.textContent = 'Loading…';
  await loadChallenge();
  if (input) input.focus();
}

// After a failed math check: fresh question, clear only the answer.
function onCaptchaFailed() {
  refreshChallenge();
}

function captchaFieldHtml() {
  return `
    <div class="captcha-box">
      <div class="captcha-question" id="captcha-question">Loading…</div>
      <div class="captcha-row">
        <input type="text" name="captcha_answer" required inputmode="numeric" autocomplete="off" placeholder="Your answer">
        <button class="captcha-refresh" type="button" onclick="refreshChallenge(event)" title="New question" aria-label="New question">↻</button>
      </div>
    </div>`;
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
        challenge_id: state.challenge ? state.challenge.challenge_id : null,
        captcha_answer: f.get('captcha_answer'),
      },
    });
    enterApp(user, token);
  } catch (err) {
    authError(err.message);
    btn.disabled = false;
    // The challenge is single-use: any failed submit spent it, so a fresh
    // question is needed even when the failure was a wrong password.
    onCaptchaFailed();
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
        challenge_id: state.challenge ? state.challenge.challenge_id : null,
        captcha_answer: f.get('captcha_answer'),
      },
    });
    enterApp(user, token);
  } catch (err) {
    authError(err.message);
    btn.disabled = false;
    // The challenge is single-use: any failed submit spent it, so a fresh
    // question is needed even when the failure was not the math itself.
    onCaptchaFailed();
  }
  return false;
}

function enterApp(user, token) {
  state.user = user;
  state.token = token;
  localStorage.setItem('sf_token', token);
  state.tab = 'feed';
  state.view = { name: 'feed' };
  state.feedPosts = [];
  state.feedCursor = null;
  state.feedDone = false;
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

function renderApp() {
  app.innerHTML = `
    <div class="topbar">
      <div class="wordmark">Social Feed</div>
      <button class="icon-btn" title="New post" onclick="goTab('feed', true)">${icon('edit', false, 22)}</button>
    </div>
    <main class="view" id="view"></main>
    <nav class="tabbar">
      <button class="tab ${state.tab === 'feed' ? 'active' : ''}" onclick="goTab('feed')">
        <span class="tab-icon">${icon('home', state.tab === 'feed', 24)}</span><span class="tab-label">Feed</span></button>
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
  stopThreadPolling();
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
  if (v.name === 'feed') renderFeed();
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
