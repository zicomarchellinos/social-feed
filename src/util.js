'use strict';
// Shared helpers: ids, timestamps, token hashing, cursor pagination,
// and server-side image validation (MIME + magic bytes).

const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// Random high-entropy session token. Only its SHA-256 hash is stored.
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Cursor: base64url of "created_at|id". Opaque to clients.
function encodeCursor(createdAt, id) {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep < 0) return null;
    return { createdAt: raw.slice(0, sep), id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

function parseLimit(value, fallback = 20, max = 50) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// Detect an image type from magic bytes. Returns 'jpg' | 'png' | 'gif' |
// 'webp' or null when the bytes are not a supported image. Never trust the
// client-supplied MIME type alone.
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Validate an uploaded file: declared MIME must be an image AND the magic
// bytes must agree. Returns the detected extension ('jpg'|'png'|'gif'|'webp')
// or null when invalid.
function validateImageFile(file) {
  if (!file || !file.buffer || file.buffer.length === 0) return null;
  if (!ALLOWED_MIMES.has(file.mimetype)) return null;
  return detectImageType(file.buffer);
}

module.exports = {
  uuid,
  nowIso,
  genToken,
  hashToken,
  encodeCursor,
  decodeCursor,
  parseLimit,
  detectImageType,
  validateImageFile,
};
