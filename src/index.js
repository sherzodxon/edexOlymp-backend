// src/index.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const routes = require('./routes');
const prisma = require('./db');

const app = express();

const PORT = process.env.PORT || 4000;

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────

const allowedOrigins = [
  'https://edex-olymp.vercel.app',
  process.env.FRONTEND_URL,
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Postman/server-side requestlar uchun
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log('❌ Blocked by CORS:', origin);

    return callback(new Error('CORS not allowed'));
  },

  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-admin-key',
  ],

  credentials: true,
};

// Middleware
app.use(cors(corsOptions));

// OPTIONS preflight
app.options(/.*/, cors(corsOptions));

// ─────────────────────────────────────────────
// Debug logger (temporary)
// ─────────────────────────────────────────────

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}]`,
    req.method,
    req.originalUrl,
    'Origin:',
    req.headers.origin || 'no-origin'
  );

  next();
});

// ─────────────────────────────────────────────
// Body parsers
// ─────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

app.use(express.urlencoded({
  extended: true,
}));

// ─────────────────────────────────────────────
// Static uploads
// ─────────────────────────────────────────────

app.use(
  '/uploads',
  express.static(path.join(__dirname, '../uploads'))
);

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// API routes
// ─────────────────────────────────────────────

app.use('/api', routes);

// ─────────────────────────────────────────────
// 404
// ─────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
  });
});

// ─────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('❌ ERROR:', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Fayl juda katta (maks 10MB)',
    });
  }

  // CORS xato
  if (err.message === 'CORS not allowed') {
    return res.status(403).json({
      error: 'CORS blocked',
    });
  }

  res.status(500).json({
    error: err.message || 'Internal server error',
  });
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────

const start = async () => {
  try {
    await prisma.$connect();

    console.log('✅ Database connected');

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log('🌍 Allowed origins:', allowedOrigins);
    });

  } catch (err) {
    console.error('❌ Failed to start:', err);

    process.exit(1);
  }
};

start();