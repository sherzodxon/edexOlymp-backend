// src/index.js

require('dotenv').config();

const express = require('express');
const path = require('path');

const routes = require('./routes');
const prisma = require('./db');

const app = express();

const PORT = process.env.PORT || 4000;


app.use((req, res, next) => {

  res.header(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-key'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});


app.use(express.json({
  limit: '10mb'
}));

app.use(express.urlencoded({
  extended: true,
}));


app.use(
  '/uploads',
  express.static(path.join(__dirname, '../uploads'))
);


app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});


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
// ERROR HANDLER
// ─────────────────────────────────────────────

app.use((err, req, res, next) => {

  console.error(err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Fayl juda katta (maks 10MB)',
    });
  }

  res.status(500).json({
    error: err.message || 'Internal server error',
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const start = async () => {

  try {

    await prisma.$connect();

    console.log('✅ Database connected');

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {

    console.error('❌ Failed to start:', err);

    process.exit(1);
  }
};

start();