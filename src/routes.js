'use strict';
// All API routes for Social Feed. Auth is a Bearer token; only the SHA-256
// hash of the token is stored (sessions.token_hash). Passwords are hashed
// with bcryptjs. No handler ever returns password_hash or a raw token
// except at login/register time.

const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const { db, publicUser } = require('./db');
const {
  uuid, nowIso, genToken, hashToken,
  encodeCursor, decodeCursor, parseLimit, validateImageFile,
} = require('./util');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const POSTS_DIR = path.join(UPLOADS_DIR, 'posts');
fs.mkdirSync(AVATARS_DIR, { recursive: true });
fs.mkdirSync(POSTS_DIR, { recursive: true });

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_POST_CHARS = 2000;
const MAX_COMMENT_CHARS = 1000;
const MAX_BIO_CHARS = 500;
const MAX_NAME_CHARS = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_AUTH_ERROR = 'Email or password is incorrect.';

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function createSession(userId) {
  const token = genToken();
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), userId, hashToken(token),
    new Date(Date.now() + SESSION_TTL_MS).toISOString(), now, now);
  return token;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return next(httpError(401, 'Authentication required.'));
  const row = db.prepare(
    `SELECT s.*, u.id AS user_id, u.display_name, u.email, u.bio,
            u.avatar_url, u.verified_at, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL`
  ).get(hashToken(match[1]));
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
    return next(httpError(401, 'Session expired. Please log in again.'));
  }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);
  req.session = { id: row.id };
  req.user = {
    id: row.user_id,
    display_name: row.display_name,
    email: row.email,
    bio: row.bio || '',
    avatar_url: row.avatar_url || null,
    verified_at: row.verified_at,
    created_at: row.created_at,
  };
  next();
}

// Optional auth: attaches req.user when a valid token is present, otherwise
// continues anonymously. Used by the feed so liked_by_me works when logged in.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return next();
  const row = db.prepare(
    `SELECT s.id AS session_id, u.id AS user_id
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL`
  ).get(hashToken(match[1]));
  if (row) req.user = { id: row.user_id };
  next();
}

function validEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// ---------------------------------------------------------------------------
// Math CAPTCHA (security check on login/register)
// ---------------------------------------------------------------------------
// Challenges live only in memory: the question goes to the client, the
// answer never leaves the server. Lifecycle: pending -> verified (via
// POST /auth/challenge/verify) -> consumed (by one login/register attempt).
// Each challenge expires after 5 minutes and allows 3 wrong answers.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 3;
const MATH_CHECK_ERROR = 'Math check failed. Please try a new question.';
const challenges = new Map(); // challenge_id -> { answer, expiresAt, status, attempts }

function newChallenge() {
  // Lazy cleanup of expired challenges.
  const now = Date.now();
  for (const [id, c] of challenges) {
    if (c.expiresAt <= now) challenges.delete(id);
  }
  const ops = ['+', '-', '×'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a, b, answer;
  if (op === '×') {
    a = 2 + Math.floor(Math.random() * 8); // 2–9
    b = 2 + Math.floor(Math.random() * 8); // 2–9
    answer = a * b;
  } else if (op === '+') {
    a = Math.floor(Math.random() * 21); // 0–20
    b = Math.floor(Math.random() * 21); // 0–20
    answer = a + b;
  } else {
    a = Math.floor(Math.random() * 21); // 0–20
    b = Math.floor(Math.random() * (a + 1)); // 0–a, so the result is >= 0
    answer = a - b;
  }
  const id = uuid();
  challenges.set(id, { answer, expiresAt: now + CHALLENGE_TTL_MS, status: 'pending', attempts: 0 });
  return { challenge_id: id, question: `What is ${a} ${op} ${b}?` };
}

// Consumes the challenge: only a server-verified, unexpired challenge
// passes, and it is deleted whether the login/register itself succeeds.
function verifyChallenge(req) {
  const id = req.body.challenge_id;
  if (typeof id !== 'string' || id === '') return false;
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.expiresAt <= Date.now()) return false;
  return c.status === 'verified';
}

// ---------------------------------------------------------------------------
// Simple per-IP rate limits (in-memory)
// ---------------------------------------------------------------------------
// server.js sets `trust proxy`, so behind Render req.ip is the real client IP.

const CHALLENGE_LIMIT = { windowMs: 60 * 1000, max: 30 }; // challenge fetches
const AUTH_FAIL_LIMIT = { windowMs: 15 * 60 * 1000, max: 10 }; // failed logins
const challengeHits = new Map(); // ip -> { count, resetAt }
const authFails = new Map(); // ip -> { count, resetAt }

// Counts one hit; returns true when the caller is over the limit.
function hitLimit(store, ip, limit) {
  const now = Date.now();
  let rec = store.get(ip);
  if (!rec || rec.resetAt <= now) {
    rec = { count: 0, resetAt: now + limit.windowMs };
    store.set(ip, rec);
  }
  rec.count += 1;
  return rec.count > limit.max;
}

// ---------------------------------------------------------------------------
// Post serialization + pagination helpers
// ---------------------------------------------------------------------------

const POST_SELECT = `
  SELECT p.id, p.body, p.photo_url, p.community_id, p.created_at,
         u.id AS author_id, u.display_name AS author_name,
         u.avatar_url AS author_avatar, u.verified_at AS author_verified,
         c.name AS community_name,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
         (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id) AS comment_count,
         EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me
  FROM posts p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN communities c ON c.id = p.community_id
`;

function serializePost(row) {
  return {
    id: row.id,
    body: row.body,
    photo_url: row.photo_url || null,
    community_id: row.community_id || null,
    community_name: row.community_name || null,
    created_at: row.created_at,
    author: {
      id: row.author_id,
      display_name: row.author_name,
      avatar_url: row.author_avatar || null,
      verified_at: row.author_verified,
    },
    like_count: row.like_count,
    comment_count: row.comment_count,
    liked_by_me: !!row.liked_by_me,
  };
}

// Newest-first page over (created_at DESC, id DESC). cursor = encodeCursor of
// the last item of the previous page.
function pageNewest(baseSql, whereSql, params, viewerId, cursor, limit) {
  const conditions = [whereSql];
  const values = [viewerId, ...params];
  const c = decodeCursor(cursor);
  if (c) {
    conditions.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
    values.push(c.createdAt, c.createdAt, c.id);
  }
  const rows = db.prepare(
    `${baseSql} WHERE ${conditions.filter(Boolean).join(' AND ')}
     ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
  ).all(...values, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
    : null;
  return { items: page.map(serializePost), next_cursor: nextCursor };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

router.get('/auth/challenge', (req, res, next) => {
  if (hitLimit(challengeHits, req.ip, CHALLENGE_LIMIT)) {
    return next(httpError(429, 'Too many requests. Please wait a moment and try again.'));
  }
  res.json(newChallenge());
});

// Verify one answer. A wrong answer keeps the challenge pending (up to 3
// attempts, so a bot cannot brute-force the small answer space); a right
// answer marks it verified, which is what login/register require.
router.post('/auth/challenge/verify', (req, res, next) => {
  if (hitLimit(challengeHits, req.ip, CHALLENGE_LIMIT)) {
    return next(httpError(429, 'Too many requests. Please wait a moment and try again.'));
  }
  const id = req.body.challenge_id;
  const given = req.body.captcha_answer;
  if (typeof id !== 'string' || id === '') {
    return next(httpError(400, 'Challenge expired. Please try a new question.'));
  }
  const c = challenges.get(id);
  if (!c || c.expiresAt <= Date.now()) {
    if (c) challenges.delete(id);
    return next(httpError(400, 'Challenge expired. Please try a new question.'));
  }
  if (c.status === 'verified') return res.json({ verified: true });
  const n = typeof given === 'string' ? given.trim() : given;
  if (n === '' || n === null || n === undefined || Number(n) !== c.answer) {
    c.attempts += 1;
    if (c.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      challenges.delete(id);
      return res.json({ verified: false, error: 'too_many_attempts' });
    }
    return res.json({
      verified: false,
      error: 'incorrect_answer',
      attempts_left: CHALLENGE_MAX_ATTEMPTS - c.attempts,
    });
  }
  c.status = 'verified';
  c.verifiedAt = Date.now();
  return res.json({ verified: true });
});

router.post('/auth/register', (req, res, next) => {
  if (!verifyChallenge(req)) return next(httpError(400, MATH_CHECK_ERROR));
  const displayName = (req.body.display_name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!displayName) return next(httpError(400, 'Display name is required.'));
  if (displayName.length > MAX_NAME_CHARS) return next(httpError(400, 'Display name is too long.'));
  if (!validEmail(email)) return next(httpError(400, 'Please enter a valid email address.'));
  if (typeof password !== 'string' || password.length < 8) {
    return next(httpError(400, 'Password must be at least 8 characters.'));
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return next(httpError(409, 'An account with this email already exists.'));

  const now = nowIso();
  const id = uuid();
  // Instant verification: verified_at is set at creation, no review step.
  db.prepare(
    `INSERT INTO users (id, display_name, email, password_hash, bio, avatar_url, verified_at, created_at)
     VALUES (?, ?, ?, ?, '', NULL, ?, ?)`
  ).run(id, displayName, email, bcrypt.hashSync(password, 10), now, now);
  const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  const token = createSession(id);
  res.status(201).json({ user, token });
});

router.post('/auth/login', (req, res, next) => {
  if (!verifyChallenge(req)) return next(httpError(400, MATH_CHECK_ERROR));
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Same generic error for unknown email and wrong password.
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    if (hitLimit(authFails, req.ip, AUTH_FAIL_LIMIT)) {
      return next(httpError(429, 'Too many login attempts. Try again in a few minutes.'));
    }
    return next(httpError(401, GENERIC_AUTH_ERROR));
  }
  authFails.delete(req.ip);
  const token = createSession(user.id);
  res.json({ user: publicUser(user), token });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), req.session.id);
  res.json({ ok: true });
});

router.get('/auth/session', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

router.get('/users', requireAuth, (req, res) => {
  // People list for starting DMs (everyone except the current user).
  const rows = db.prepare(
    `SELECT id, display_name, avatar_url, verified_at FROM users
     WHERE id != ? ORDER BY display_name COLLATE NOCASE ASC`
  ).all(req.user.id);
  res.json({ users: rows.map((r) => ({
    id: r.id, display_name: r.display_name,
    avatar_url: r.avatar_url || null, verified_at: r.verified_at,
  })) });
});

router.get('/users/:id', requireAuth, (req, res, next) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return next(httpError(404, 'User not found.'));
  const postCount = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ?').get(row.id).n;
  const communityCount = db.prepare(
    'SELECT COUNT(*) AS n FROM community_members WHERE user_id = ?'
  ).get(row.id).n;
  res.json({ ...publicUser(row), post_count: postCount, community_count: communityCount });
});

router.patch('/users/me', requireAuth, (req, res, next) => {
  const updates = {};
  if (req.body.display_name !== undefined) {
    const name = String(req.body.display_name).trim();
    if (!name) return next(httpError(400, 'Display name is required.'));
    if (name.length > MAX_NAME_CHARS) return next(httpError(400, 'Display name is too long.'));
    updates.display_name = name;
  }
  if (req.body.bio !== undefined) {
    const bio = String(req.body.bio);
    if (bio.length > MAX_BIO_CHARS) return next(httpError(400, 'Bio is too long.'));
    updates.bio = bio;
  }
  if (Object.keys(updates).length === 0) return next(httpError(400, 'Nothing to update.'));
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(updates), req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
}).single('avatar');

router.post('/users/me/avatar', requireAuth, (req, res, next) => {
  uploadAvatar(req, res, (err) => {
    if (err) return next(httpError(400, err.code === 'LIMIT_FILE_SIZE'
      ? 'Avatar must be 2 MB or smaller.' : 'Avatar upload failed.'));
    const ext = validateImageFile(req.file);
    if (!ext) return next(httpError(400, 'Please upload a JPEG, PNG, GIF, or WebP image.'));
    const filename = `${uuid()}.${ext}`;
    const filepath = path.join(AVATARS_DIR, filename);
    fs.writeFileSync(filepath, req.file.buffer);
    const old = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?')
      .run(`/uploads/avatars/${filename}`, req.user.id);
    // Best-effort cleanup of the replaced avatar file.
    if (old && old.avatar_url && old.avatar_url.startsWith('/uploads/avatars/')) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, old.avatar_url.slice('/uploads/'.length))); } catch { /* ignore */ }
    }
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });
});

router.get('/users/:id/posts', requireAuth, (req, res, next) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return next(httpError(404, 'User not found.'));
  const limit = parseLimit(req.query.limit);
  const page = pageNewest(POST_SELECT, 'p.author_id = ?', [req.params.id],
    req.user.id, req.query.cursor, limit);
  res.json({ posts: page.items, next_cursor: page.next_cursor });
});

// ---------------------------------------------------------------------------
// Posts / feed / likes / comments
// ---------------------------------------------------------------------------

router.get('/feed', requireAuth, (req, res) => {
  const limit = parseLimit(req.query.limit);
  const page = pageNewest(POST_SELECT, 'p.community_id IS NULL', [],
    req.user.id, req.query.cursor, limit);
  res.json({ posts: page.items, next_cursor: page.next_cursor });
});

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
}).single('photo');

router.post('/posts', requireAuth, (req, res, next) => {
  uploadPhoto(req, res, (err) => {
    if (err) return next(httpError(400, err.code === 'LIMIT_FILE_SIZE'
      ? 'Photo must be 5 MB or smaller.' : 'Photo upload failed.'));
    const body = (req.body.body || '').trim();
    const communityId = (req.body.community_id || '').trim() || null;
    let photoUrl = null;
    if (req.file) {
      const ext = validateImageFile(req.file);
      if (!ext) return next(httpError(400, 'Please upload a JPEG, PNG, GIF, or WebP image.'));
      const filename = `${uuid()}.${ext}`;
      fs.writeFileSync(path.join(POSTS_DIR, filename), req.file.buffer);
      photoUrl = `/uploads/posts/${filename}`;
    }
    if (!body && !photoUrl) {
      return next(httpError(400, 'Write something or add a photo.'));
    }
    if (body.length > MAX_POST_CHARS) return next(httpError(400, 'Post is too long.'));
    if (communityId) {
      const community = db.prepare('SELECT id FROM communities WHERE id = ?').get(communityId);
      if (!community) return next(httpError(404, 'Community not found.'));
      const member = db.prepare(
        'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?'
      ).get(communityId, req.user.id);
      if (!member) return next(httpError(403, 'Join this community before posting in it.'));
    }
    const id = uuid();
    db.prepare(
      `INSERT INTO posts (id, author_id, body, photo_url, community_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, req.user.id, body, photoUrl, communityId, nowIso());
    const row = db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(req.user.id, id);
    res.status(201).json({ post: serializePost(row) });
  });
});

router.delete('/posts/:id/photo', requireAuth, (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next(httpError(404, 'Post not found.'));
  if (post.author_id !== req.user.id) return next(httpError(403, 'Only the author can remove this photo.'));
  if (!post.photo_url) return next(httpError(400, 'This post has no photo.'));
  if (post.photo_url.startsWith('/uploads/posts/')) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, post.photo_url.slice('/uploads/'.length))); } catch { /* ignore */ }
  }
  db.prepare('UPDATE posts SET photo_url = NULL WHERE id = ?').run(post.id);
  res.json({ ok: true });
});

router.put('/posts/:id/like', requireAuth, (req, res, next) => {
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next(httpError(404, 'Post not found.'));
  db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, post.id, nowIso());
  const count = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(post.id).n;
  res.json({ liked: true, like_count: count });
});

router.delete('/posts/:id/like', requireAuth, (req, res, next) => {
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next(httpError(404, 'Post not found.'));
  db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, post.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(post.id).n;
  res.json({ liked: false, like_count: count });
});

router.get('/posts/:id/comments', requireAuth, (req, res, next) => {
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next(httpError(404, 'Post not found.'));
  const limit = parseLimit(req.query.limit, 20);
  const c = decodeCursor(req.query.cursor);
  let rows;
  if (c) {
    rows = db.prepare(
      `SELECT cm.id, cm.body, cm.created_at,
              u.id AS author_id, u.display_name AS author_name,
              u.avatar_url AS author_avatar, u.verified_at AS author_verified
       FROM comments cm JOIN users u ON u.id = cm.author_id
       WHERE cm.post_id = ? AND (cm.created_at > ? OR (cm.created_at = ? AND cm.id > ?))
       ORDER BY cm.created_at ASC, cm.id ASC LIMIT ?`
    ).all(req.params.id, c.createdAt, c.createdAt, c.id, limit + 1);
  } else {
    rows = db.prepare(
      `SELECT cm.id, cm.body, cm.created_at,
              u.id AS author_id, u.display_name AS author_name,
              u.avatar_url AS author_avatar, u.verified_at AS author_verified
       FROM comments cm JOIN users u ON u.id = cm.author_id
       WHERE cm.post_id = ?
       ORDER BY cm.created_at ASC, cm.id ASC LIMIT ?`
    ).all(req.params.id, limit + 1);
  }
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    comments: page.map((r) => ({
      id: r.id, body: r.body, created_at: r.created_at,
      author: {
        id: r.author_id, display_name: r.author_name,
        avatar_url: r.author_avatar || null, verified_at: r.author_verified,
      },
    })),
    next_cursor: hasMore
      ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
      : null,
  });
});

router.post('/posts/:id/comments', requireAuth, (req, res, next) => {
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next(httpError(404, 'Post not found.'));
  const body = (req.body.body || '').trim();
  if (!body) return next(httpError(400, 'Comment cannot be empty.'));
  if (body.length > MAX_COMMENT_CHARS) return next(httpError(400, 'Comment is too long.'));
  const id = uuid();
  const createdAt = nowIso();
  db.prepare(
    'INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, post.id, req.user.id, body, createdAt);
  res.status(201).json({
    comment: {
      id, body, created_at: createdAt,
      author: {
        id: req.user.id, display_name: req.user.display_name,
        avatar_url: req.user.avatar_url || null, verified_at: req.user.verified_at,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Conversations / messages
// ---------------------------------------------------------------------------

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

router.get('/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id AS conversation_id, c.created_at,
            u.id AS other_id, u.display_name AS other_name,
            u.avatar_url AS other_avatar, u.verified_at AS other_verified,
            (SELECT m.body FROM messages m WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
            (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_at,
            (SELECT m.sender_id FROM messages m WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_id,
            EXISTS(SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id
                   AND m2.sender_id != ?
                   AND (cp.last_read_at IS NULL OR m2.created_at > cp.last_read_at)) AS has_unread
     FROM conversations c
     JOIN conversation_participants cp
       ON cp.conversation_id = c.id AND cp.user_id = ?
     JOIN conversation_participants cp2
       ON cp2.conversation_id = c.id AND cp2.user_id != ?
     JOIN users u ON u.id = cp2.user_id
     ORDER BY COALESCE(last_at, c.created_at) DESC`
  ).all(req.user.id, req.user.id, req.user.id);
  res.json({
    conversations: rows.map((r) => ({
      id: r.conversation_id,
      created_at: r.created_at,
      other: {
        id: r.other_id, display_name: r.other_name,
        avatar_url: r.other_avatar || null, verified_at: r.other_verified,
      },
      last_message: r.last_body ? {
        body: r.last_body, created_at: r.last_at,
        from_me: r.last_sender_id === req.user.id,
      } : null,
      has_unread: !!r.has_unread,
    })),
  });
});

router.post('/conversations', requireAuth, (req, res, next) => {
  const participantId = req.body.participant_id;
  if (!participantId || participantId === req.user.id) {
    return next(httpError(400, 'Choose another user to message.'));
  }
  const other = db.prepare('SELECT id FROM users WHERE id = ?').get(participantId);
  if (!other) return next(httpError(404, 'User not found.'));
  const key = pairKey(req.user.id, participantId);
  let conv = db.prepare('SELECT id FROM conversations WHERE pair_key = ?').get(key);
  if (!conv) {
    const id = uuid();
    const insert = db.transaction(() => {
      db.prepare('INSERT INTO conversations (id, pair_key, created_at) VALUES (?, ?, ?)')
        .run(id, key, nowIso());
      db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)')
        .run(id, req.user.id);
      db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)')
        .run(id, participantId);
    });
    try {
      insert();
    } catch (e) {
      // Lost a race with a concurrent create for the same pair; re-read it.
      conv = db.prepare('SELECT id FROM conversations WHERE pair_key = ?').get(key);
      if (!conv) throw e;
      return res.json({ conversation: { id: conv.id } });
    }
    conv = { id };
  }
  res.json({ conversation: { id: conv.id } });
});

function requireParticipant(req, res, next) {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return next(httpError(404, 'Conversation not found.'));
  const member = db.prepare(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!member) return next(httpError(403, 'You are not part of this conversation.'));
  next();
}

router.get('/conversations/:id/messages', requireAuth, requireParticipant, (req, res) => {
  const limit = parseLimit(req.query.limit, 50, 100);
  const c = decodeCursor(req.query.cursor);
  let rows;
  const select = `
    SELECT m.id, m.body, m.created_at,
           u.id AS sender_id, u.display_name AS sender_name,
           u.avatar_url AS sender_avatar, u.verified_at AS sender_verified
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ?`;
  if (c) {
    rows = db.prepare(`${select} AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
      ORDER BY m.created_at ASC, m.id ASC LIMIT ?`)
      .all(req.params.id, c.createdAt, c.createdAt, c.id, limit + 1);
  } else {
    rows = db.prepare(`${select} ORDER BY m.created_at ASC, m.id ASC LIMIT ?`)
      .all(req.params.id, limit + 1);
  }
  // Reading the thread marks it read for this participant.
  db.prepare(
    `UPDATE conversation_participants SET last_read_at = ?
     WHERE conversation_id = ? AND user_id = ?`
  ).run(nowIso(), req.params.id, req.user.id);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    messages: page.map((r) => ({
      id: r.id, body: r.body, created_at: r.created_at,
      sender: {
        id: r.sender_id, display_name: r.sender_name,
        avatar_url: r.sender_avatar || null, verified_at: r.sender_verified,
      },
    })),
    next_cursor: hasMore
      ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
      : null,
  });
});

router.post('/conversations/:id/messages', requireAuth, requireParticipant, (req, res, next) => {
  const body = (req.body.body || '').trim();
  if (!body) return next(httpError(400, 'Message cannot be empty.'));
  if (body.length > MAX_COMMENT_CHARS) return next(httpError(400, 'Message is too long.'));
  const id = uuid();
  const createdAt = nowIso();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.params.id, req.user.id, body, createdAt);
  res.status(201).json({
    message: {
      id, body, created_at: createdAt,
      sender: {
        id: req.user.id, display_name: req.user.display_name,
        avatar_url: req.user.avatar_url || null, verified_at: req.user.verified_at,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

router.get('/communities', requireAuth, (req, res) => {
  const q = (req.query.query || '').trim();
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT cm.id, cm.name, cm.description, cm.created_at,
            (SELECT COUNT(*) FROM community_members m WHERE m.community_id = cm.id) AS member_count,
            EXISTS(SELECT 1 FROM community_members m2
                   WHERE m2.community_id = cm.id AND m2.user_id = ?) AS joined
     FROM communities cm
     WHERE (? = '' OR cm.name LIKE ? OR cm.description LIKE ?)
     ORDER BY cm.created_at DESC, cm.id DESC`
  ).all(req.user.id, q, like, like);
  res.json({
    communities: rows.map((r) => ({
      id: r.id, name: r.name, description: r.description, created_at: r.created_at,
      member_count: r.member_count, joined: !!r.joined,
    })),
  });
});

router.get('/communities/:id', requireAuth, (req, res, next) => {
  const row = db.prepare(
    `SELECT cm.id, cm.name, cm.description, cm.created_at,
            (SELECT COUNT(*) FROM community_members m WHERE m.community_id = cm.id) AS member_count,
            EXISTS(SELECT 1 FROM community_members m2
                   WHERE m2.community_id = cm.id AND m2.user_id = ?) AS joined
     FROM communities cm WHERE cm.id = ?`
  ).get(req.user.id, req.params.id);
  if (!row) return next(httpError(404, 'Community not found.'));
  res.json({
    community: {
      id: row.id, name: row.name, description: row.description,
      created_at: row.created_at, member_count: row.member_count, joined: !!row.joined,
    },
  });
});

router.post('/communities', requireAuth, (req, res, next) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  if (!name) return next(httpError(400, 'Community name is required.'));
  if (name.length > 80) return next(httpError(400, 'Community name is too long.'));
  if (description.length > 500) return next(httpError(400, 'Description is too long.'));
  const id = uuid();
  const now = nowIso();
  const create = db.transaction(() => {
    db.prepare(
      'INSERT INTO communities (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, description, req.user.id, now);
    // Creator auto-joins.
    db.prepare(
      'INSERT INTO community_members (community_id, user_id, created_at) VALUES (?, ?, ?)'
    ).run(id, req.user.id, now);
  });
  create();
  res.status(201).json({
    community: {
      id, name, description, created_at: now, member_count: 1, joined: true,
    },
  });
});

router.post('/communities/:id/join', requireAuth, (req, res, next) => {
  const community = db.prepare('SELECT id FROM communities WHERE id = ?').get(req.params.id);
  if (!community) return next(httpError(404, 'Community not found.'));
  db.prepare(
    'INSERT OR IGNORE INTO community_members (community_id, user_id, created_at) VALUES (?, ?, ?)'
  ).run(req.params.id, req.user.id, nowIso());
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?'
  ).get(req.params.id).n;
  res.json({ joined: true, member_count: count });
});

router.delete('/communities/:id/join', requireAuth, (req, res, next) => {
  const community = db.prepare('SELECT id FROM communities WHERE id = ?').get(req.params.id);
  if (!community) return next(httpError(404, 'Community not found.'));
  db.prepare(
    'DELETE FROM community_members WHERE community_id = ? AND user_id = ?'
  ).run(req.params.id, req.user.id);
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?'
  ).get(req.params.id).n;
  res.json({ joined: false, member_count: count });
});

router.get('/communities/:id/posts', requireAuth, (req, res, next) => {
  const community = db.prepare('SELECT id FROM communities WHERE id = ?').get(req.params.id);
  if (!community) return next(httpError(404, 'Community not found.'));
  const limit = parseLimit(req.query.limit);
  const page = pageNewest(POST_SELECT, 'p.community_id = ?', [req.params.id],
    req.user.id, req.query.cursor, limit);
  res.json({ posts: page.items, next_cursor: page.next_cursor });
});

// ---------------------------------------------------------------------------
// Wallet (SF Wallet)
// ---------------------------------------------------------------------------
// Demo money in Indonesian rupiah, INTEGER amounts only — never floats.
// Deposits are SIMULATED: no payment gateway is connected, no real money
// moves. Every money movement is one SQLite transaction with a conditional
// debit (balance guard), and every mutating endpoint honors idempotency keys.

const MIN_AMOUNT_IDR = 1000;
const MAX_AMOUNT_IDR = 5000000;
const DEPOSIT_METHODS = ['bank_transfer', 'e_wallet', 'virtual_account'];
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000; // 15 minutes
const PAYMENT_REQUEST_TTL_MS = 15 * 60 * 1000; // 15 minutes
const QR_PREFIX = 'SF-PAY:';

function getOrCreateWallet(userId) {
  let w = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (w) return w;
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO wallets (id, user_id, balance_idr, receive_token, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?)`
  ).run(uuid(), userId, uuid(), now, now);
  return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
}

function validateAmount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return 'Amount must be a whole number of rupiah.';
  }
  if (value < MIN_AMOUNT_IDR || value > MAX_AMOUNT_IDR) {
    return 'Amount must be between Rp1.000 and Rp5.000.000.';
  }
  return null;
}

function validIdempotencyKey(key) {
  return key === undefined
    || (typeof key === 'string' && key.length >= 1 && key.length <= 128);
}

const TX_SELECT = `
  SELECT t.*,
         su.id AS sender_user_id, su.display_name AS sender_name, su.avatar_url AS sender_avatar,
         ru.id AS recipient_user_id, ru.display_name AS recipient_name, ru.avatar_url AS recipient_avatar
  FROM transactions t
  LEFT JOIN wallets sw ON sw.id = t.sender_wallet_id
  LEFT JOIN users su ON su.id = sw.user_id
  LEFT JOIN wallets rw ON rw.id = t.recipient_wallet_id
  LEFT JOIN users ru ON ru.id = rw.user_id
`;

function getTx(id) {
  return db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id);
}

function serializeTransaction(row, viewerWalletId) {
  const out = row.sender_wallet_id === viewerWalletId;
  const cp = out
    ? { id: row.recipient_user_id, display_name: row.recipient_name, avatar_url: row.recipient_avatar }
    : { id: row.sender_user_id, display_name: row.sender_name, avatar_url: row.sender_avatar };
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    direction: out ? 'out' : 'in',
    amount_idr: row.amount_idr,
    fee_idr: row.fee_idr,
    method: row.method || null,
    reference: row.reference || null,
    description: row.description || null,
    counterparty: cp.id
      ? { id: cp.id, display_name: cp.display_name, avatar_url: cp.avatar_url || null }
      : null,
    created_at: row.created_at,
  };
}

function findIdempotentTx(walletId, key) {
  if (!key) return null;
  return db.prepare(
    `SELECT * FROM transactions
     WHERE idempotency_key = ? AND (sender_wallet_id = ? OR recipient_wallet_id = ?)`
  ).get(key, walletId, walletId);
}

function idempotencyMatches(row, expected) {
  return row.type === expected.type
    && row.amount_idr === expected.amount
    && row.sender_wallet_id === (expected.senderWalletId || null)
    && row.recipient_wallet_id === (expected.recipientWalletId || null)
    && (row.method || null) === (expected.method || null)
    && (row.description || null) === (expected.description || null);
}

// Returns the idempotent replay response when the key was already used,
// or null when this is a fresh request. Throws (via next) on mismatch.
function idempotentReplay(res, walletId, key, expected) {
  const existing = findIdempotentTx(walletId, key);
  if (!existing) return {};
  if (!idempotencyMatches(existing, expected)) {
    return { conflict: true };
  }
  const fresh = db.prepare('SELECT balance_idr FROM wallets WHERE id = ?').get(walletId);
  res.json({
    balance_idr: fresh.balance_idr,
    transaction: serializeTransaction(getTx(existing.id), walletId),
  });
  return { replayed: true };
}

// PIN check for money-out operations. Returns null when the PIN verifies,
// otherwise the httpError to return. Wrong PINs count toward a 15-minute
// lock; a correct PIN resets the counter. Never logs PINs.
function checkWalletPin(wallet, pin) {
  if (!wallet.pin_hash) {
    return httpError(403, 'Set a wallet PIN before sending money.', 'PIN_REQUIRED');
  }
  if (wallet.pin_locked_until && new Date(wallet.pin_locked_until).getTime() > Date.now()) {
    return httpError(429, 'Too many wrong PIN attempts. Wallet locked for 15 minutes.');
  }
  if (wallet.pin_locked_until) {
    // Lock expired: clear it.
    db.prepare('UPDATE wallets SET pin_attempts = 0, pin_locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), wallet.id);
    wallet.pin_attempts = 0;
    wallet.pin_locked_until = null;
  }
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return httpError(400, 'Enter your 6-digit wallet PIN.');
  }
  if (!bcrypt.compareSync(pin, wallet.pin_hash)) {
    const attempts = (wallet.pin_attempts || 0) + 1;
    if (attempts >= PIN_MAX_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + PIN_LOCK_MS).toISOString();
      db.prepare('UPDATE wallets SET pin_attempts = ?, pin_locked_until = ?, updated_at = ? WHERE id = ?')
        .run(attempts, lockedUntil, nowIso(), wallet.id);
      return httpError(429, 'Too many wrong PIN attempts. Wallet locked for 15 minutes.');
    }
    db.prepare('UPDATE wallets SET pin_attempts = ?, updated_at = ? WHERE id = ?')
      .run(attempts, nowIso(), wallet.id);
    const left = PIN_MAX_ATTEMPTS - attempts;
    return httpError(400, `Incorrect PIN. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`);
  }
  if (wallet.pin_attempts) {
    db.prepare('UPDATE wallets SET pin_attempts = 0, pin_locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), wallet.id);
  }
  return null;
}

// Atomic money-out: conditional debit (balance guard), credit, ledger row,
// plus an optional extra step inside the same transaction (e.g. redeeming
// a payment request). Throws httpError on insufficient funds; the caller
// maps SQLITE_CONSTRAINT_UNIQUE to 409.
function executeTransfer({ type, senderWallet, recipientWallet, amount, description, reference, idempotencyKey, txId, extra }) {
  const run = db.transaction(() => {
    const now = nowIso();
    const debit = db.prepare(
      `UPDATE wallets SET balance_idr = balance_idr - ?, updated_at = ?
       WHERE id = ? AND balance_idr >= ?`
    ).run(amount, now, senderWallet.id, amount);
    if (debit.changes !== 1) throw httpError(400, 'Insufficient balance.');
    db.prepare(
      'UPDATE wallets SET balance_idr = balance_idr + ?, updated_at = ? WHERE id = ?'
    ).run(amount, now, recipientWallet.id);
    db.prepare(
      `INSERT INTO transactions (id, idempotency_key, type, status, sender_wallet_id, recipient_wallet_id, amount_idr, fee_idr, reference, description, created_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, 0, ?, ?, ?)`
    ).run(txId, idempotencyKey || null, type, senderWallet.id, recipientWallet.id,
      amount, reference || null, description || null, now);
    if (extra) extra();
    return txId;
  });
  return run();
}

function resolveRecipient(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (validEmail(v)) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(v.toLowerCase()) || null;
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(v) || null;
}

// QR payloads look like SF-PAY:<uuid>. The token is either a wallet's
// static receive_token (open amount) or a payment_requests token
// (fixed amount, single-use, 15-minute expiry).
function parsePayloadToken(payload) {
  if (typeof payload !== 'string') return null;
  const m = new RegExp(`^${QR_PREFIX}([0-9a-fA-F-]{36})$`).exec(payload.trim());
  return m ? m[1].toLowerCase() : null;
}

// Looks the token up without checking expiry/redeemed state (the caller
// decides which state checks apply — a pay retry must still find a
// redeemed request to replay its idempotent result).
function lookupPayloadTarget(token) {
  const reqRow = db.prepare('SELECT * FROM payment_requests WHERE token = ?').get(token);
  if (reqRow) {
    const user = db.prepare(
      'SELECT id, display_name, avatar_url, verified_at FROM users WHERE id = ?'
    ).get(reqRow.recipient_user_id);
    if (!user) return null;
    return {
      kind: 'request', token, recipient: user,
      amount_idr: reqRow.amount_idr, note: reqRow.note,
      expires_at: reqRow.expires_at, redeemed_at: reqRow.redeemed_at,
    };
  }
  const w = db.prepare('SELECT * FROM wallets WHERE receive_token = ?').get(token);
  if (w) {
    const user = db.prepare(
      'SELECT id, display_name, avatar_url, verified_at FROM users WHERE id = ?'
    ).get(w.user_id);
    if (!user) return null;
    return {
      kind: 'receive', token, recipient: user,
      amount_idr: null, note: null, expires_at: null, redeemed_at: null,
    };
  }
  return null;
}

function resolvePayload(payload) {
  const token = parsePayloadToken(payload);
  if (!token) {
    throw httpError(400, 'Invalid QR code. Make sure you scanned a Social Feed payment code.');
  }
  const target = lookupPayloadTarget(token);
  if (!target) {
    throw httpError(400, 'QR code not recognized. Make sure you scanned a Social Feed payment code.');
  }
  if (target.kind === 'request') {
    if (target.redeemed_at) throw httpError(400, 'This payment request was already used.');
    if (new Date(target.expires_at).getTime() <= Date.now()) {
      throw httpError(400, 'This payment request has expired.');
    }
  }
  return target;
}

function publicRecipient(user) {
  return {
    id: user.id, display_name: user.display_name,
    avatar_url: user.avatar_url || null, verified_at: user.verified_at,
  };
}

// --- Wallet summary (creates the wallet lazily) ---
router.get('/wallet', requireAuth, (req, res) => {
  const wallet = getOrCreateWallet(req.user.id);
  res.json({
    balance_idr: wallet.balance_idr,
    has_pin: !!wallet.pin_hash,
    receive_token: wallet.receive_token,
  });
});

// --- Transaction history, newest first, cursor-paginated ---
// ?filter=all|in|out|deposit, ?limit (max 50), ?before=<cursor>
router.get('/wallet/transactions', requireAuth, (req, res) => {
  const wallet = getOrCreateWallet(req.user.id);
  const limit = parseLimit(req.query.limit, 20, 50);
  const filter = ['in', 'out', 'deposit'].includes(req.query.filter) ? req.query.filter : 'all';
  const c = decodeCursor(req.query.before || req.query.cursor);
  const conditions = [];
  const params = [];
  if (filter === 'in') {
    conditions.push('t.recipient_wallet_id = ?');
    params.push(wallet.id);
  } else if (filter === 'out') {
    conditions.push('t.sender_wallet_id = ?');
    params.push(wallet.id);
  } else if (filter === 'deposit') {
    conditions.push("t.type = 'deposit'");
    conditions.push('t.recipient_wallet_id = ?');
    params.push(wallet.id);
  } else {
    conditions.push('(t.sender_wallet_id = ? OR t.recipient_wallet_id = ?)');
    params.push(wallet.id, wallet.id);
  }
  if (c) {
    conditions.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
    params.push(c.createdAt, c.createdAt, c.id);
  }
  const rows = db.prepare(
    `${TX_SELECT} WHERE ${conditions.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ?`
  ).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    transactions: page.map((r) => serializeTransaction(r, wallet.id)),
    next_cursor: hasMore
      ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
      : null,
  });
});

// --- Simulated top-up (demo: no real money moves) ---
router.post('/wallet/deposits', requireAuth, (req, res, next) => {
  const amountErr = validateAmount(req.body.amountIdr);
  if (amountErr) return next(httpError(400, amountErr));
  const amount = req.body.amountIdr;
  const method = req.body.method;
  if (!DEPOSIT_METHODS.includes(method)) return next(httpError(400, 'Choose a top-up method.'));
  const key = req.body.idempotencyKey;
  if (!validIdempotencyKey(key)) return next(httpError(400, 'Invalid idempotency key.'));
  const wallet = getOrCreateWallet(req.user.id);
  if (key) {
    const replay = idempotentReplay(res, wallet.id, key, {
      type: 'deposit', amount, senderWalletId: null,
      recipientWalletId: wallet.id, method, description: null,
    });
    if (replay.conflict) return next(httpError(409, 'This request was already used with different details.'));
    if (replay.replayed) return;
  }
  const now = nowIso();
  const id = uuid();
  const reference = 'DEP-' + id.slice(0, 8).toUpperCase();
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO transactions (id, idempotency_key, type, status, sender_wallet_id, recipient_wallet_id, amount_idr, fee_idr, method, reference, description, created_at)
       VALUES (?, ?, 'deposit', 'completed', NULL, ?, ?, 0, ?, ?, NULL, ?)`
    ).run(id, key || null, wallet.id, amount, method, reference, now);
    db.prepare('UPDATE wallets SET balance_idr = balance_idr + ?, updated_at = ? WHERE id = ?')
      .run(amount, now, wallet.id);
  });
  try {
    run();
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return next(httpError(409, 'This request was already processed.'));
    }
    throw e;
  }
  const fresh = db.prepare('SELECT balance_idr FROM wallets WHERE id = ?').get(wallet.id);
  res.status(201).json({
    balance_idr: fresh.balance_idr,
    transaction: serializeTransaction(getTx(id), wallet.id),
  });
});

// --- Send money to another user (by user id or email) ---
router.post('/wallet/transfers', requireAuth, (req, res, next) => {
  const amountErr = validateAmount(req.body.amountIdr);
  if (amountErr) return next(httpError(400, amountErr));
  const amount = req.body.amountIdr;
  const description = req.body.description === undefined
    ? null : String(req.body.description).trim() || null;
  if (description && description.length > 200) {
    return next(httpError(400, 'Note is too long (max 200 characters).'));
  }
  const key = req.body.idempotencyKey;
  if (!validIdempotencyKey(key)) return next(httpError(400, 'Invalid idempotency key.'));
  const recipient = resolveRecipient(req.body.recipient);
  if (!recipient) return next(httpError(404, 'Recipient not found.'));
  if (recipient.id === req.user.id) {
    return next(httpError(400, 'You cannot send money to yourself.'));
  }
  const senderWallet = getOrCreateWallet(req.user.id);
  const recipientWallet = getOrCreateWallet(recipient.id);
  if (key) {
    const replay = idempotentReplay(res, senderWallet.id, key, {
      type: 'transfer', amount, senderWalletId: senderWallet.id,
      recipientWalletId: recipientWallet.id, method: null, description,
    });
    if (replay.conflict) return next(httpError(409, 'This request was already used with different details.'));
    if (replay.replayed) return;
  }
  const pinErr = checkWalletPin(senderWallet, req.body.pin);
  if (pinErr) return next(pinErr);
  if (senderWallet.balance_idr < amount) {
    return next(httpError(400, 'Insufficient balance. Top up first or send a smaller amount.'));
  }
  const id = uuid();
  const reference = 'TRF-' + id.slice(0, 8).toUpperCase();
  let txId;
  try {
    txId = executeTransfer({
      type: 'transfer', senderWallet, recipientWallet, amount,
      description, reference, idempotencyKey: key || null, txId: id,
    });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return next(httpError(409, 'This request was already processed.'));
    }
    throw e;
  }
  const fresh = db.prepare('SELECT balance_idr FROM wallets WHERE id = ?').get(senderWallet.id);
  res.status(201).json({
    balance_idr: fresh.balance_idr,
    transaction: serializeTransaction(getTx(txId), senderWallet.id),
  });
});

// --- Set or change the 6-digit wallet PIN ---
router.post('/wallet/pin', requireAuth, (req, res, next) => {
  const pin = req.body.pin;
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return next(httpError(400, 'PIN must be exactly 6 digits.'));
  }
  const wallet = getOrCreateWallet(req.user.id);
  if (wallet.pin_locked_until && new Date(wallet.pin_locked_until).getTime() > Date.now()) {
    return next(httpError(429, 'Too many wrong PIN attempts. Wallet locked for 15 minutes.'));
  }
  if (wallet.pin_hash) {
    const current = req.body.currentPin;
    if (typeof current !== 'string' || !bcrypt.compareSync(current, wallet.pin_hash)) {
      return next(httpError(400, 'Current PIN is incorrect.'));
    }
  }
  db.prepare(
    'UPDATE wallets SET pin_hash = ?, pin_attempts = 0, pin_locked_until = NULL, updated_at = ? WHERE id = ?'
  ).run(bcrypt.hashSync(pin, 10), nowIso(), wallet.id);
  res.json({ ok: true, has_pin: true });
});

// --- Static receive QR (open amount; the payer chooses) ---
router.get('/wallet/receive-qr', requireAuth, (req, res) => {
  const wallet = getOrCreateWallet(req.user.id);
  res.json({
    payload: QR_PREFIX + wallet.receive_token,
    display_name: req.user.display_name,
  });
});

// --- Create a fixed-amount payment request (QR), 15-minute expiry ---
router.post('/wallet/payment-requests', requireAuth, (req, res, next) => {
  const amountErr = validateAmount(req.body.amountIdr);
  if (amountErr) return next(httpError(400, amountErr));
  const amount = req.body.amountIdr;
  const note = req.body.note === undefined ? null : String(req.body.note).trim() || null;
  if (note && note.length > 200) {
    return next(httpError(400, 'Note is too long (max 200 characters).'));
  }
  const token = uuid();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + PAYMENT_REQUEST_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO payment_requests (token, recipient_user_id, amount_idr, note, expires_at, redeemed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(token, req.user.id, amount, note, expiresAt, now);
  res.status(201).json({
    token, payload: QR_PREFIX + token, amount_idr: amount, expires_at: expiresAt,
  });
});

// --- Resolve a scanned QR payload (before the payer confirms) ---
router.post('/wallet/resolve-qr', requireAuth, (req, res, next) => {
  let target;
  try {
    target = resolvePayload(req.body.payload);
  } catch (e) {
    return next(e);
  }
  res.json({
    kind: target.kind,
    recipient: publicRecipient(target.recipient),
    amount_idr: target.amount_idr,
    note: target.note,
    expires_at: target.expires_at,
  });
});

// --- Pay a QR code (fixed request or open receive QR) ---
router.post('/wallet/pay', requireAuth, (req, res, next) => {
  const token = parsePayloadToken(req.body.payload);
  if (!token) {
    return next(httpError(400, 'Invalid QR code. Make sure you scanned a Social Feed payment code.'));
  }
  const target = lookupPayloadTarget(token);
  if (!target) {
    return next(httpError(400, 'QR code not recognized. Make sure you scanned a Social Feed payment code.'));
  }
  if (target.recipient.id === req.user.id) {
    return next(httpError(400, 'You cannot pay yourself.'));
  }
  let amount;
  if (target.kind === 'request') {
    amount = target.amount_idr;
    if (req.body.amountIdr !== undefined && req.body.amountIdr !== null
      && req.body.amountIdr !== amount) {
      return next(httpError(400, 'Amount does not match the requested amount.'));
    }
  } else {
    const amountErr = validateAmount(req.body.amountIdr);
    if (amountErr) return next(httpError(400, amountErr));
    amount = req.body.amountIdr;
  }
  const key = req.body.idempotencyKey;
  if (!validIdempotencyKey(key)) return next(httpError(400, 'Invalid idempotency key.'));
  const senderWallet = getOrCreateWallet(req.user.id);
  const recipientWallet = getOrCreateWallet(target.recipient.id);
  // Idempotency is checked BEFORE the redeemed/expired state checks, so a
  // retry of a completed pay replays the original result instead of failing
  // on the (now redeemed) request.
  if (key) {
    const replay = idempotentReplay(res, senderWallet.id, key, {
      type: 'payment', amount, senderWalletId: senderWallet.id,
      recipientWalletId: recipientWallet.id, method: null, description: target.note,
    });
    if (replay.conflict) return next(httpError(409, 'This request was already used with different details.'));
    if (replay.replayed) return;
  }
  if (target.kind === 'request') {
    if (target.redeemed_at) return next(httpError(400, 'This payment request was already used.'));
    if (new Date(target.expires_at).getTime() <= Date.now()) {
      return next(httpError(400, 'This payment request has expired.'));
    }
  }
  const pinErr = checkWalletPin(senderWallet, req.body.pin);
  if (pinErr) return next(pinErr);
  if (senderWallet.balance_idr < amount) {
    return next(httpError(400, 'Insufficient balance. Top up first or pay a smaller amount.'));
  }
  const id = uuid();
  const reference = 'PAY-' + id.slice(0, 8).toUpperCase();
  let txId;
  try {
    txId = executeTransfer({
      type: 'payment', senderWallet, recipientWallet, amount,
      description: target.note, reference, idempotencyKey: key || null, txId: id,
      extra: target.kind === 'request' ? () => {
        // Redeem inside the same transaction; the NULL check is the race
        // guard when two payers hit one request at once.
        const r = db.prepare(
          'UPDATE payment_requests SET redeemed_at = ? WHERE token = ? AND redeemed_at IS NULL'
        ).run(nowIso(), target.token);
        if (r.changes !== 1) throw httpError(400, 'This payment request was already used.');
      } : null,
    });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return next(httpError(409, 'This request was already processed.'));
    }
    throw e;
  }
  const fresh = db.prepare('SELECT balance_idr FROM wallets WHERE id = ?').get(senderWallet.id);
  res.status(201).json({
    balance_idr: fresh.balance_idr,
    transaction: serializeTransaction(getTx(txId), senderWallet.id),
  });
});

module.exports = router;
