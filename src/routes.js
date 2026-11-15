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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
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
// answer never leaves the server. Each challenge is single-use and expires
// after 5 minutes.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MATH_CHECK_ERROR = 'Math check failed. Please try a new question.';
const challenges = new Map(); // challenge_id -> { answer, expiresAt }

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
  challenges.set(id, { answer, expiresAt: now + CHALLENGE_TTL_MS });
  return { challenge_id: id, question: `What is ${a} ${op} ${b}?` };
}

// Single-use: the challenge is deleted whether the answer is right or wrong.
function verifyChallenge(req) {
  const id = req.body.challenge_id;
  const given = req.body.captcha_answer;
  if (typeof id !== 'string' || id === '') return false;
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.expiresAt <= Date.now()) return false;
  const n = typeof given === 'string' ? given.trim() : given;
  if (n === '' || n === null || n === undefined) return false;
  return Number(n) === c.answer;
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

module.exports = router;
