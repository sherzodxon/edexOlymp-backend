// src/controllers/student.js
const prisma = require('../db');

// ──────────────────────────────────────────────
// Ro'yxatdan o'tish
// ──────────────────────────────────────────────
const register = async (req, res) => {
  const { token, firstName, lastName, school, grade } = req.body;

  if (!token || !firstName || !lastName || !school || !grade) {
    return res.status(400).json({ error: 'Barcha maydonlar to\'ldirilishi shart' });
  }

  const gradeNum = parseInt(grade);
  if (gradeNum < 5 || gradeNum > 11) {
    return res.status(400).json({ error: 'Sinf 5 dan 11 gacha bo\'lishi kerak' });
  }

  try {
    const existing = await prisma.student.findUnique({ where: { token } });
    if (existing) {
      return res.json({ success: true, data: existing });
    }

    const student = await prisma.student.create({
      data: { token, firstName, lastName, school, grade: gradeNum },
    });

    res.status(201).json({ success: true, data: student });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Talaba holatini olish
// ──────────────────────────────────────────────
const getProfile = async (req, res) => {
  const { token } = req.params;

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: {
        typingAttempts: { orderBy: { attemptNumber: 'asc' } },
        testSession: { include: { answers: true } },
        docsSubmission: true,
      },
    });

    if (!student) {
      return res.status(404).json({ error: 'Talaba topilmadi' });
    }

    res.json({ success: true, data: student });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

module.exports = { register, getProfile };
