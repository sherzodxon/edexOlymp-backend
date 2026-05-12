// src/controllers/test.js
const prisma = require('../db');

const TEST_QUESTION_COUNT = 20;       // har talabaga 20 ta savol
const DEFAULT_TEST_TIME   = 600;      // 10 daqiqa

// Massivni Fisher-Yates algoritmi orqali aralashtirish
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Berilgan tartib (questionId massivi) bo'yicha savollarni qaytaradi
function applyOrder(questions, orderIds) {
  if (!orderIds || !orderIds.length) return questions;
  const map = new Map(questions.map(q => [q.id, q]));
  const ordered = [];
  for (const id of orderIds) {
    if (map.has(id)) ordered.push(map.get(id));
  }
  // Tartibda yo'q savollar (yangi qo'shilganlar) oxiriga qo'shiladi
  for (const q of questions) {
    if (!orderIds.includes(q.id)) ordered.push(q);
  }
  return ordered;
}

// ──────────────────────────────────────────────
// Test bosqichini boshlash (session yaratish)
// ──────────────────────────────────────────────
const startTest = async (req, res) => {
  const { token } = req.body;

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { testSession: { include: { answers: true } } },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (student.status === 'TYPING') {
      return res.status(400).json({ error: 'Avval typing qismini yakunlang' });
    }
    if (student.status !== 'TEST') {
      return res.status(409).json({ error: 'Test allaqachon yakunlangan' });
    }

    const config       = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const timeLimitSec = config?.testTimeLimitSec || DEFAULT_TEST_TIME;

    // Talaba sinfiga mos savollar
    const allQuestions = await prisma.testQuestion.findMany({
      where: {
        isActive: true,
        OR: [{ grade: student.grade }, { grade: 0 }],
      },
      select: {
        id: true, questionText: true, imageUrl: true,
        optionA: true, optionB: true, optionC: true, optionD: true, orderIndex: true,
      },
      orderBy: { orderIndex: 'asc' },
    });

    // Mavjud session bor bo'lsa — savollar va qolgan vaqt bilan qaytaramiz
    if (student.testSession) {
      const elapsedSec   = Math.floor((Date.now() - new Date(student.testSession.startedAt).getTime()) / 1000);
      const remainingSec = Math.max(0, timeLimitSec - elapsedSec);

      // Vaqt tugagan — avtomatik yakunlash
      if (remainingSec <= 0 && !student.testSession.isCompleted) {
        const correctCount = student.testSession.answers?.filter(a => a.isCorrect)?.length ?? 0;
        const score = parseFloat(correctCount.toFixed(2));
        await prisma.testSession.update({
          where: { id: student.testSession.id },
          data: { isCompleted: true, finishedAt: new Date(), score },
        });
        await prisma.student.update({
          where: { id: student.id },
          data: { status: 'DOCS', testScore: score, totalScore: { increment: score } },
        });
        return res.json({ success: true, completed: true, score });
      }

      // Saqlangan tartibda savollarni qaytaramiz (refresh paytida tartib o'zgarmasligi uchun)
      let orderIds = [];
      try {
        if (student.testSession.questionOrder) {
          orderIds = JSON.parse(student.testSession.questionOrder);
        }
      } catch { /* default — orderIndex */ }

      const orderedQuestions = orderIds.length
        ? applyOrder(allQuestions, orderIds).slice(0, TEST_QUESTION_COUNT)
        : allQuestions.slice(0, TEST_QUESTION_COUNT);

      const existingAnswers = (student.testSession.answers ?? []).map(a => ({
        questionId: a.questionId,
        selectedOption: a.selectedOption,
      }));

      return res.json({
        success: true,
        data: student.testSession,
        questions: orderedQuestions,
        existingAnswers,
        timeLimitSec,
        remainingSec,
        alreadyStarted: true,
      });
    }

    // ── Yangi session — savollarni har talaba uchun random aralashtiramiz ──
    const shuffled = shuffleArray(allQuestions).slice(0, TEST_QUESTION_COUNT);
    const orderIds = shuffled.map(q => q.id);

    let session = await prisma.testSession.findFirst({ where: { studentId: student.id } });
    if (!session) {
      session = await prisma.testSession.create({
        data: {
          studentId: student.id,
          questionOrder: JSON.stringify(orderIds),
        },
      });
    } else if (!session.questionOrder) {
      session = await prisma.testSession.update({
        where: { id: session.id },
        data: { questionOrder: JSON.stringify(orderIds) },
      });
    }

    res.status(201).json({
      success: true,
      data: session,
      questions: shuffled,
      timeLimitSec,
      remainingSec: timeLimitSec,
    });
  } catch (err) {
    console.error('Start test error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Savollarni olish (boshlangan session uchun)
// ──────────────────────────────────────────────
const getQuestions = async (req, res) => {
  const { token } = req.params;

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { testSession: { include: { answers: true } } },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (!student.testSession) return res.status(404).json({ error: 'Session topilmadi' });
    if (student.testSession.isCompleted) {
      return res.json({ success: true, completed: true, score: student.testSession.score });
    }

    const allQuestions = await prisma.testQuestion.findMany({
      where: {
        isActive: true,
        OR: [{ grade: student.grade }, { grade: 0 }],
      },
      select: {
        id: true, questionText: true, imageUrl: true,
        optionA: true, optionB: true, optionC: true, optionD: true,
      },
    });

    let orderIds = [];
    try {
      if (student.testSession.questionOrder) {
        orderIds = JSON.parse(student.testSession.questionOrder);
      }
    } catch { /* ignored */ }

    const orderedQuestions = orderIds.length
      ? applyOrder(allQuestions, orderIds).slice(0, TEST_QUESTION_COUNT)
      : allQuestions.slice(0, TEST_QUESTION_COUNT);

    const config    = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const elapsed   = Math.floor((Date.now() - student.testSession.startedAt.getTime()) / 1000);
    const timeLimit = config?.testTimeLimitSec || DEFAULT_TEST_TIME;

    res.json({
      success: true,
      questions: orderedQuestions,
      session: student.testSession,
      timeLimitSec: timeLimit,
      elapsedSec: elapsed,
      remainingSec: Math.max(0, timeLimit - elapsed),
      existingAnswers: student.testSession.answers.map((a) => ({
        questionId: a.questionId,
        selectedOption: a.selectedOption,
      })),
    });
  } catch (err) {
    console.error('Get questions error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Test javoblarini yuborish (submit)
// ──────────────────────────────────────────────
const submitTest = async (req, res) => {
  const { token, answers } = req.body;
  // answers: [{ questionId, selectedOption }]

  if (!token || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Token va javoblar majburiy' });
  }

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      select: { id: true, status: true, testScore: true, testSession: true },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (!student.testSession) return res.status(404).json({ error: 'Session topilmadi' });
    if (student.testSession.isCompleted) {
      return res.json({ success: true, score: student.testSession.score, alreadySubmitted: true });
    }

    const questionIds = answers.map((a) => a.questionId);
    const questions = await prisma.testQuestion.findMany({
      where: { id: { in: questionIds } },
      select: { id: true, correctOption: true },
    });

    const correctMap = new Map(questions.map((q) => [q.id, q.correctOption]));
    let correctCount = 0;

    const answerData = answers.map((a) => {
      const isCorrect = correctMap.get(a.questionId) === a.selectedOption;
      if (isCorrect) correctCount++;
      return {
        testSessionId: student.testSession.id,
        questionId: a.questionId,
        selectedOption: a.selectedOption,
        isCorrect,
      };
    });

    // Test bali = to'g'ri javoblar soni (max 20)
    const score = parseFloat(Math.min(correctCount, TEST_QUESTION_COUNT).toFixed(2));

    const prevTestScore = student.testScore ?? 0;
    const scoreDiff = score - prevTestScore;

    await prisma.$transaction(async (tx) => {
      for (const a of answerData) {
        await tx.testAnswer.upsert({
          where: {
            testSessionId_questionId: {
              testSessionId: a.testSessionId,
              questionId: a.questionId,
            },
          },
          update: { selectedOption: a.selectedOption, isCorrect: a.isCorrect },
          create: a,
        });
      }

      await tx.testSession.update({
        where: { id: student.testSession.id },
        data: { score, isCompleted: true, finishedAt: new Date() },
      });

      await tx.student.update({
        where: { id: student.id },
        data: {
          status: 'DOCS',
          testScore: score,
          totalScore: scoreDiff !== 0 ? { increment: scoreDiff } : undefined,
        },
      });
    });

    res.json({ success: true, score, correctCount, totalQuestions: answers.length });
  } catch (err) {
    console.error('Submit test error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

module.exports = { startTest, getQuestions, submitTest };
