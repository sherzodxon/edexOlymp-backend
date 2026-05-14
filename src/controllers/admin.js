// src/controllers/admin.js
const prisma = require('../db');
const XLSX = require('xlsx');

// ──────────────────────────────────────────────
// Barcha talabalar natijasi
// ──────────────────────────────────────────────
const getResults = async (req, res) => {
  const { grade, status, search } = req.query;

  try {
    const where = {};
    if (grade) where.grade = parseInt(grade);
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { school: { contains: search, mode: 'insensitive' } },
      ];
    }

    const students = await prisma.student.findMany({
      where,
      include: {
        typingAttempts: { orderBy: { attemptNumber: 'asc' } },
        testSession: { select: { score: true, isCompleted: true, startedAt: true, finishedAt: true } },
        docsSubmission: { select: { score: true, fileName: true, isChecked: true } },
        pptxSubmission: { select: { score: true, fileName: true, isChecked: true } },
      },
      orderBy: { totalScore: 'desc' },
    });

    const data = students.map(s => ({
      ...s,
      totalScore: parseFloat(
        ((s.typingScore || 0) + (s.testScore || 0) + (s.docsScore || 0) + (s.pptxScore || 0)).toFixed(2)
      ),
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('Admin get results error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Leaderboard — barcha sinflar bo'yicha umumiy reyting
// (Foydalanuvchi talabi: 3 guruhga bo'lish yo'q!)
// ──────────────────────────────────────────────
const getLeaderboard = async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: { status: 'COMPLETED' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        school: true,
        grade: true,
        typingScore: true,
        testScore: true,
        docsScore: true,
        pptxScore: true,
        totalScore: true,
      },
      orderBy: { totalScore: 'desc' },
      take: 100,
    });

    const withTotal = students.map(s => ({
      ...s,
      totalScore: parseFloat(
        ((s.typingScore || 0) + (s.testScore || 0) + (s.docsScore || 0) + (s.pptxScore || 0)).toFixed(2)
      ),
    }));
    withTotal.sort((a, b) => b.totalScore - a.totalScore);
    const ranked = withTotal.map((s, i) => ({ ...s, rank: i + 1 }));

    // Eski mijozlar uchun groups formatini ham qaytaramiz
    res.json({
      success: true,
      data: {
        all: { label: 'Barcha sinflar', students: ranked },
      },
      students: ranked,
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Test savol yaratish
// ──────────────────────────────────────────────
const createQuestion = async (req, res) => {
  const { grade, questionText, optionA, optionB, optionC, optionD, correctOption, orderIndex, imageUrl } = req.body;

  if (!questionText || !optionA || !optionB || !optionC || !optionD || !correctOption) {
    return res.status(400).json({ error: "Barcha maydonlarni to'ldiring" });
  }
  if (!['A', 'B', 'C', 'D'].includes(correctOption)) {
    return res.status(400).json({ error: "To'g'ri javob A, B, C yoki D bo'lishi kerak" });
  }

  try {
    const question = await prisma.testQuestion.create({
      data: {
        grade: parseInt(grade) || 0,
        questionText,
        imageUrl: imageUrl || null,
        optionA, optionB, optionC, optionD,
        correctOption,
        orderIndex: parseInt(orderIndex) || 0,
      },
    });
    res.status(201).json({ success: true, data: question });
  } catch (err) {
    console.error('Create question error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Savol rasmi yuklash (multer orqali)
// ──────────────────────────────────────────────
const uploadQuestionImage = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Rasm yuklanmadi' });
  const { id } = req.params;

  try {
    const imageUrl = `/uploads/questions/${req.file.filename}`;

    if (id && id !== 'new') {
      await prisma.testQuestion.update({
        where: { id: parseInt(id) },
        data: { imageUrl },
      });
    }

    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('Upload question image error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Savollar ro'yxati
// ──────────────────────────────────────────────
const getQuestions = async (req, res) => {
  const { grade } = req.query;
  try {
    const where = { isActive: true };
    if (grade) where.grade = parseInt(grade);

    const questions = await prisma.testQuestion.findMany({
      where,
      orderBy: [{ grade: 'asc' }, { orderIndex: 'asc' }],
    });
    res.json({ success: true, data: questions });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Savolni o'chirish
// ──────────────────────────────────────────────
const deleteQuestion = async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.testQuestion.update({
      where: { id: parseInt(id) },
      data: { isActive: false },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Exam config (taymer, mezon) yangilash
// docsCriteria / pptxCriteria formati:
// {
//   "group_5_6":  { "baholash_mezonlari": [...] },
//   "group_7_8":  { "baholash_mezonlari": [...] },
//   "group_9":    { "baholash_mezonlari": [...] }
// }
// ──────────────────────────────────────────────
const updateConfig = async (req, res) => {
  const {
    typingTimeLimitSec, testTimeLimitSec, docsTimeLimitSec, pptxTimeLimitSec,
    docsCriteria, pptxCriteria,
  } = req.body;

  try {
    let config = await prisma.examConfig.findFirst({ where: { isActive: true } });

    const data = {};
    if (typingTimeLimitSec !== undefined) data.typingTimeLimitSec = parseInt(typingTimeLimitSec);
    if (testTimeLimitSec   !== undefined) data.testTimeLimitSec   = parseInt(testTimeLimitSec);
    if (docsTimeLimitSec   !== undefined) data.docsTimeLimitSec   = parseInt(docsTimeLimitSec);
    if (pptxTimeLimitSec   !== undefined) data.pptxTimeLimitSec   = parseInt(pptxTimeLimitSec);
    if (docsCriteria !== undefined) {
      data.docsCriteria = typeof docsCriteria === 'string'
        ? docsCriteria
        : JSON.stringify(docsCriteria);
    }
    if (pptxCriteria !== undefined) {
      data.pptxCriteria = typeof pptxCriteria === 'string'
        ? pptxCriteria
        : JSON.stringify(pptxCriteria);
    }

    if (config) {
      config = await prisma.examConfig.update({ where: { id: config.id }, data });
    } else {
      // Create — birinchi marta
      config = await prisma.examConfig.create({
        data: {
          ...data,
          docsCriteria: data.docsCriteria ?? '{}',
          pptxCriteria: data.pptxCriteria ?? '{}',
        },
      });
    }

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('Config update error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Config olish
// ──────────────────────────────────────────────
const getConfig = async (req, res) => {
  try {
    const config = await prisma.examConfig.findFirst({ where: { isActive: true } });
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Talabani o'chirish
// ──────────────────────────────────────────────
const deleteStudent = async (req, res) => {
  const { id } = req.params;
  const studentId = parseInt(id);
  try {
    await prisma.$transaction(async (tx) => {
      const session = await tx.testSession.findFirst({ where: { studentId } });
      if (session) {
        await tx.testAnswer.deleteMany({ where: { testSessionId: session.id } });
        await tx.testSession.delete({ where: { id: session.id } });
      }
      await tx.typingAttempt.deleteMany({ where: { studentId } });
      await tx.docsSubmission.deleteMany({ where: { studentId } });
      await tx.pptxSubmission.deleteMany({ where: { studentId } });
      await tx.student.delete({ where: { id: studentId } });
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete student error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Excel eksport — yagona umumiy ro'yxat (PPTX bilan)
// ──────────────────────────────────────────────
const exportExcel = async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      include: {
        typingAttempts: { orderBy: { attemptNumber: 'asc' } },
        testSession: true,
        docsSubmission: true,
        pptxSubmission: true,
      },
      orderBy: { totalScore: 'desc' },
    });

    const rows = students.map((s, i) => {
      const bestAttempt = s.typingAttempts.reduce((best, curr) => (curr.wpm > (best?.wpm || 0) ? curr : best), null);
      return {
        '#': i + 1,
        'Ism': s.firstName,
        'Familiya': s.lastName,
        'Maktab': s.school,
        'Sinf': s.grade,
        'Holat': statusLabel(s.status),
        'Typing WPM': bestAttempt?.wpm || 0,
        'Typing Ball': s.typingScore,
        'Test Ball': s.testScore,
        'Word Ball': s.docsScore,
        'PPTX Ball': s.pptxScore,
        'Jami Ball': s.totalScore,
        'Sana': new Date(s.createdAt).toLocaleString('uz-UZ'),
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 4 }, { wch: 14 }, { wch: 14 }, { wch: 25 }, { wch: 6 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Natijalar');

    // Reyting (yakunlangan talabalar) — yagona ro'yxat
    const completed = students.filter(s => s.status === 'COMPLETED');
    const ratingRows = completed.map((s, i) => ({
      '#': i + 1,
      'Ism Familiya': `${s.firstName} ${s.lastName}`,
      'Maktab': s.school,
      'Sinf': s.grade,
      'Typing': s.typingScore,
      'Test': s.testScore,
      'Word': s.docsScore,
      'PPTX': s.pptxScore,
      'Jami': s.totalScore,
    }));
    const ws2 = XLSX.utils.json_to_sheet(ratingRows);
    XLSX.utils.book_append_sheet(wb, ws2, 'Reyting');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="edex-exam-natijalar.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

function statusLabel(status) {
  const labels = { TYPING: 'Typing', TEST: 'Test', DOCS: 'Word', PPTX: 'PowerPoint', COMPLETED: 'Yakunlangan' };
  return labels[status] || status;
}

module.exports = { getResults, getLeaderboard, createQuestion, uploadQuestionImage, getQuestions, deleteQuestion, updateConfig, getConfig, deleteStudent, exportExcel };
