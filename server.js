'use strict';
// Social Feed — single-service app: Express API + static frontend + SQLite.
// Listens on PORT (Render sets it) or 3000 locally.

const path = require('path');
const express = require('express');

// Initialize the database (creates data/social-feed.db + schema on startup).
require('./src/db');
const api = require('./src/routes');

const app = express();
// Behind Render's proxy; lets req.ip be the real client IP for rate limiting.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// API
app.use('/api', api);

// Uploaded photos/avatars, served at /uploads/...
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Static single-page frontend.
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback: any non-API route serves the app shell.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JSON error handler (must be last).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const body = { error: err.message || 'Something went wrong.' };
  if (err.code) body.code = err.code; // e.g. PIN_REQUIRED for the wallet client
  res.status(status).json(body);
});

app.listen(PORT, () => {
  console.log(`Social Feed listening on port ${PORT}`);
});
