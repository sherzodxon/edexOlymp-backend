// src/routes/index.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { adminAuth } = require('../middleware/auth');
const { register, getProfile } = require('../controllers/student');
const { submitAttempt } = require('../controllers/typing');
const { startTest, getQuestions, submitTest } = require('../controllers/test');
const { uploadDoc, getDocsStatus, downloadStudentDoc } = require('../controllers/docs');
const { uploadPptx, getPptxStatus, downloadStudentPptx } = require('../controllers/pptx');
const {
  getResults, getLeaderboard, createQuestion, uploadQuestionImage,
  getQuestions: adminGetQuestions, deleteQuestion,
  updateConfig, getConfig, deleteStudent, exportExcel,
} = require('../controllers/admin');

// ── Multer konfiguratsiyasi (Word fayllar uchun) ──
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// PPTX fayllar uchun alohida papka
const pptxDir = path.join(__dirname, '../../uploads/pptx');
if (!fs.existsSync(pptxDir)) fs.mkdirSync(pptxDir, { recursive: true });

// Savollar uchun rasm papkasi
const questionImgDir = path.join(__dirname, '../../uploads/questions');
if (!fs.existsSync(questionImgDir)) fs.mkdirSync(questionImgDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

// Rasm yuklash uchun multer (jpg/png/gif/webp, max 5MB)
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, questionImgDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `q_${Date.now()}${ext}`);
  },
});
const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Faqat rasm fayllari qabul qilinadi'));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.docx', '.doc'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Faqat .docx yoki .doc fayllar qabul qilinadi'));
  },
});

// PPTX uchun multer (.pptx, max 25MB)
const pptxStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, pptxDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const uploadPptxFile = multer({
  storage: pptxStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pptx', '.ppt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Faqat .pptx yoki .ppt fayllar qabul qilinadi'));
  },
});

// ──────────────────────────────────────────────
// PUBLIC ROUTES
// ──────────────────────────────────────────────

// Talaba
router.post('/auth/register', register);
router.get('/student/:token', getProfile);

// Typing
router.post('/typing/attempt', submitAttempt);

// Test
router.post('/test/start', startTest);
router.get('/test/questions/:token', getQuestions);
router.post('/test/submit', submitTest);

// Docs
router.post('/docs/upload', upload.single('file'), uploadDoc);
router.get('/docs/status/:token', getDocsStatus);

// PPTX
router.post('/pptx/upload', uploadPptxFile.single('file'), uploadPptx);
router.get('/pptx/status/:token', getPptxStatus);

// Admin: talaba faylini yuklab olish
router.get('/admin/docs/:studentId/download', adminAuth, downloadStudentDoc);
router.get('/admin/pptx/:studentId/download', adminAuth, downloadStudentPptx);

// Leaderboard (public)
router.get('/leaderboard', getLeaderboard);

// ──────────────────────────────────────────────
// ADMIN ROUTES
// ──────────────────────────────────────────────
router.get('/admin/results', adminAuth, getResults);
router.delete('/admin/students/:id', adminAuth, deleteStudent);
router.get('/admin/export', adminAuth, exportExcel);

// Savollar
router.get('/admin/questions', adminAuth, adminGetQuestions);
router.post('/admin/questions', adminAuth, createQuestion);
router.post('/admin/questions/:id/image', adminAuth, uploadImage.single('image'), uploadQuestionImage);
router.delete('/admin/questions/:id', adminAuth, deleteQuestion);

// Config
router.get('/admin/config', adminAuth, getConfig);
router.put('/admin/config', adminAuth, updateConfig);

module.exports = router;
