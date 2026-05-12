// src/controllers/pptx.js
const prisma = require('../db');
const path   = require('path');
const fs     = require('fs');
const JSZip  = require('jszip');

const MAX_PPTX_SCORE    = 25;     // PPTX uchun maksimal ball
const DEFAULT_PPTX_TIME = 1200;   // 20 daqiqa

// ──────────────────────────────────────────────
// PowerPoint fayl yuklash
// ──────────────────────────────────────────────
const uploadPptx = async (req, res) => {
  const { token } = req.body;
  if (!token)    return res.status(400).json({ error: 'Token majburiy' });
  if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { pptxSubmission: true, docsSubmission: true },
    });

    if (!student)    return res.status(404).json({ error: 'Talaba topilmadi' });
    if (student.status !== 'PPTX' && student.status !== 'COMPLETED')
      return res.status(400).json({ error: 'Avval oldingi bosqichlarni yakunlang' });
    if (student.pptxSubmission)
      return res.status(409).json({ error: 'Siz allaqachon PPTX fayl yuklagansiz' });

    const config      = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const allCriteria = config?.pptxCriteria ? safeJson(config.pptxCriteria) : null;
    const criteria    = pickCriteriaForGrade(allCriteria, student.grade);
    const filePath    = req.file.path;

    // PPTX faylni tahlil qilish (JSZip orqali XML lar)
    const stats = await analyzePptx(filePath);

    const { score, feedback } = evaluatePptx(stats, criteria);

    await prisma.$transaction(async (tx) => {
      await tx.pptxSubmission.create({
        data: {
          studentId: student.id,
          fileName:  req.file.originalname,
          filePath,
          fileSize:  req.file.size,
          score,
          feedback:  JSON.stringify(feedback),
          isChecked: true,
          checkedAt: new Date(),
        },
      });
      await tx.student.update({
        where: { id: student.id },
        data: { status: 'COMPLETED', pptxScore: score, totalScore: { increment: score } },
      });
    });

    res.status(201).json({ success: true, data: { score, feedback, fileName: req.file.originalname } });
  } catch (err) {
    console.error('Pptx upload error:', err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Admin: pptx fayl yuklab olish
// ──────────────────────────────────────────────
const downloadStudentPptx = async (req, res) => {
  const { studentId } = req.params;
  try {
    const submission = await prisma.pptxSubmission.findFirst({
      where: { studentId: parseInt(studentId) },
      include: { student: true },
    });
    if (!submission) return res.status(404).json({ error: 'Fayl topilmadi' });

    const filePath = submission.filePath;
    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: 'Fayl serverda topilmadi' });

    const fileName = `${submission.student.lastName}_${submission.student.firstName}_${submission.fileName}`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    console.error('Download pptx error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// PPTX holatini olish
// ──────────────────────────────────────────────
const getPptxStatus = async (req, res) => {
  const { token } = req.params;
  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { pptxSubmission: true, docsSubmission: true, testSession: true },
    });
    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });

    const config       = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const timeLimitSec = config?.pptxTimeLimitSec || DEFAULT_PPTX_TIME;

    let remainingSec = timeLimitSec;
    if (student.docsSubmission?.submittedAt) {
      const elapsedSec = Math.floor(
        (Date.now() - new Date(student.docsSubmission.submittedAt).getTime()) / 1000
      );
      remainingSec = Math.max(0, timeLimitSec - elapsedSec);
    }

    const allCriteria = config?.pptxCriteria ? safeJson(config.pptxCriteria) : null;
    const criteria    = pickCriteriaForGrade(allCriteria, student.grade);

    res.json({
      success: true,
      data: { status: student.status, submission: student.pptxSubmission, timeLimitSec, remainingSec, criteria, maxScore: MAX_PPTX_SCORE },
    });
  } catch (err) {
    console.error('Pptx status error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Sinf guruhiga mos mezonni tanlash
// Guruhlar: 5-6, 7-8, 9 (9 va undan yuqori)
// ──────────────────────────────────────────────
function pickCriteriaForGrade(allCriteria, grade) {
  if (!allCriteria) return null;
  const hasGroups = allCriteria.group_5_6 || allCriteria.group_7_8 || allCriteria.group_9 || allCriteria.group_9_11;
  if (!hasGroups) return allCriteria;
  const g = parseInt(grade) || 0;
  if (g <= 6) return allCriteria.group_5_6  ?? null;
  if (g <= 8) return allCriteria.group_7_8  ?? null;
  return allCriteria.group_9 ?? allCriteria.group_9_11 ?? null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ──────────────────────────────────────────────
// JSZip orqali .pptx XML dan ma'lumotlarni o'qish
// ──────────────────────────────────────────────
async function analyzePptx(filePath) {
  const result = {
    slideCount: 0,
    totalText: '',
    totalWords: 0,
    totalCharCount: 0,
    titleCount: 0,
    bulletCount: 0,
    imageCount: 0,
    chartCount: 0,
    tableCount: 0,
    smartArtCount: 0,
    videoCount: 0,
    audioCount: 0,
    fonts: [],
    fontSizes: [],
    colors: [],
    hasTransitions: false,
    hasAnimations: false,
    hasNotes: false,
    hasMaster: false,
    layouts: [],
  };

  try {
    const data = fs.readFileSync(filePath);
    const zip  = await JSZip.loadAsync(data);

    const fileNames = Object.keys(zip.files);

    // Slidelarni topish
    const slideFiles = fileNames.filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f));
    result.slideCount = slideFiles.length;

    // Notes (speaker notes)
    const notesFiles = fileNames.filter(f => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(f));
    result.hasNotes = notesFiles.length > 0;

    // Master/Layout
    const masterFiles = fileNames.filter(f => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(f));
    result.hasMaster = masterFiles.length > 0;
    const layoutFiles = fileNames.filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(f));
    result.layouts = layoutFiles;

    // Rasmlar
    const mediaFiles = fileNames.filter(f => /^ppt\/media\//i.test(f));
    result.imageCount = mediaFiles.filter(f => /\.(jpe?g|png|gif|bmp|webp|svg)$/i.test(f)).length;
    result.videoCount = mediaFiles.filter(f => /\.(mp4|avi|mov|wmv|webm)$/i.test(f)).length;
    result.audioCount = mediaFiles.filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)).length;

    // Chartlar
    result.chartCount = fileNames.filter(f => /^ppt\/charts\//i.test(f) && /chart\d+\.xml$/i.test(f)).length;

    const fontSet      = new Set();
    const sizeSet      = new Set();
    const colorSet     = new Set();
    let titleHits      = 0;
    let bulletHits     = 0;
    let tableHits      = 0;
    let smartArtHits   = 0;
    let transitionHit  = false;
    let animationHit   = false;
    let allText        = '';

    for (const slidePath of slideFiles) {
      const xml = await zip.file(slidePath).async('string');

      // Sarlavha (title placeholder)
      if (/<p:ph[^>]*type="(title|ctrTitle)"/i.test(xml)) titleHits++;

      // Bullet va matn
      bulletHits += (xml.match(/<a:buChar/g) ?? []).length;
      bulletHits += (xml.match(/<a:buAutoNum/g) ?? []).length;

      // Jadval
      tableHits += (xml.match(/<a:tbl>/g) ?? []).length;

      // SmartArt
      if (/diagrams\/diagram/i.test(xml) || /<dgm:/i.test(xml)) smartArtHits++;

      // Transition
      if (/<p:transition/i.test(xml)) transitionHit = true;

      // Animation
      if (/<p:timing/i.test(xml) && /<p:par|<p:cTn/i.test(xml)) animationHit = true;

      // Shrift, o'lcham, rang
      [...xml.matchAll(/typeface="([^"]+)"/g)].forEach(m => fontSet.add(m[1]));
      [...xml.matchAll(/sz="(\d+)"/g)].forEach(m => {
        const size = parseInt(m[1]);
        if (size > 0) sizeSet.add(Math.round(size / 100));
      });
      [...xml.matchAll(/srgbClr\s+val="([0-9A-Fa-f]{6})"/g)].forEach(m => colorSet.add(m[1].toUpperCase()));

      // Matn
      const txt = (xml.match(/<a:t>[^<]*<\/a:t>/g) ?? [])
        .map(s => s.replace(/<\/?a:t>/g, ''))
        .join(' ');
      allText += ' ' + txt;
    }

    result.titleCount   = titleHits;
    result.bulletCount  = bulletHits;
    result.tableCount   = tableHits;
    result.smartArtCount= smartArtHits;
    result.hasTransitions = transitionHit;
    result.hasAnimations  = animationHit;
    result.fonts        = [...fontSet];
    result.fontSizes    = [...sizeSet].sort((a, b) => a - b);
    result.colors       = [...colorSet];

    const cleanText  = allText.trim().replace(/\s+/g, ' ');
    result.totalText = cleanText;
    result.totalCharCount = cleanText.length;
    result.totalWords = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0;

  } catch (err) {
    console.error('analyzePptx error:', err.message);
  }

  return result;
}

// ──────────────────────────────────────────────
// Asosiy baholash (max 25)
// Admin paneldagi mezonlar asosida
// ──────────────────────────────────────────────
function evaluatePptx(stats, criteria) {
  const feedback = [];
  let earned = 0;

  if (criteria?.baholash_mezonlari?.length) {
    criteria.baholash_mezonlari.forEach(mezon => {
      const maxBall = mezon.maksimal_ball ?? 5;
      const nom     = (mezon.nomi ?? '').toLowerCase();
      const { ball, hint } = gradePptxMezon(nom, maxBall, stats);
      earned += ball;
      feedback.push({
        item: mezon.nomi,
        passed: ball >= maxBall * 0.5,
        points: parseFloat(ball.toFixed(2)),
        maxPoints: maxBall,
        hint: ball >= maxBall ? null : hint,
      });
    });
    return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_PPTX_SCORE), feedback };
  }

  // Mezon yo'q — umumiy default mezonlar (max 25)
  const defaults = [
    { item: "Slaydlar soni (≥ 5)",       check: stats.slideCount >= 5,   partial: stats.slideCount >= 3, full: 5, part: 2.5, hint: `${stats.slideCount} ta slayd` },
    { item: "Sarlavha mavjudligi",       check: stats.titleCount >= 3,   partial: stats.titleCount >= 1, full: 5, part: 2.5, hint: `${stats.titleCount} ta sarlavha` },
    { item: "Rasmlar / multimedia",      check: stats.imageCount >= 2,   partial: stats.imageCount >= 1, full: 5, part: 2.5, hint: `${stats.imageCount} ta rasm` },
    { item: "Animatsiya / o'tish",       check: stats.hasAnimations || stats.hasTransitions, partial: false, full: 5, part: 0, hint: 'Animatsiya yoki o\'tish effektlari topilmadi' },
    { item: "Matn / mazmun",             check: stats.totalWords >= 80,  partial: stats.totalWords >= 30, full: 5, part: 2.5, hint: `${stats.totalWords} ta so'z` },
  ];
  defaults.forEach(d => {
    const points = d.check ? d.full : d.partial ? d.part : 0;
    earned += points;
    feedback.push({ item: d.item, passed: d.check, points, hint: d.check ? null : d.hint });
  });
  return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_PPTX_SCORE), feedback };
}

// ──────────────────────────────────────────────
// Har bir PPTX mezon turini baholash
// ──────────────────────────────────────────────
function gradePptxMezon(nom, maxBall, stats) {
  // Slaydlar soni
  if (nom.includes('slayd') || nom.includes('slide')) {
    const c = stats.slideCount;
    let ball = c >= 8 ? maxBall
             : c >= 5 ? maxBall * 0.8
             : c >= 3 ? maxBall * 0.5
             : c >= 1 ? maxBall * 0.25
             : 0;
    return { ball, hint: `${c} ta slayd (tavsiya: ≥ 5)` };
  }

  // Sarlavha / Title
  if (nom.includes('sarlavha') || nom.includes('title') || nom.includes('mavzu')) {
    const t = stats.titleCount;
    let ball = t >= stats.slideCount * 0.7 ? maxBall
             : t >= stats.slideCount * 0.4 ? maxBall * 0.7
             : t >= 1                       ? maxBall * 0.4
             : 0;
    return { ball, hint: `${t}/${stats.slideCount} ta slaydda sarlavha bor` };
  }

  // Rasm / multimedia / vizual
  if (nom.includes('rasm') || nom.includes('image') || nom.includes('vizual') || nom.includes('media')) {
    const total = stats.imageCount + stats.videoCount + stats.audioCount;
    let ball = total >= 4 ? maxBall
             : total >= 2 ? maxBall * 0.75
             : total >= 1 ? maxBall * 0.5
             : 0;
    return { ball, hint: `${stats.imageCount} rasm, ${stats.videoCount} video, ${stats.audioCount} audio` };
  }

  // Diagramma / chart / grafik
  if (nom.includes('diagramma') || nom.includes('chart') || nom.includes('grafik')) {
    const c = stats.chartCount;
    let ball = c >= 2 ? maxBall : c >= 1 ? maxBall * 0.7 : 0;
    return { ball, hint: c === 0 ? 'Diagramma topilmadi' : `${c} ta diagramma` };
  }

  // Jadval
  if (nom.includes('jadval') || nom.includes('table')) {
    const t = stats.tableCount;
    let ball = t >= 2 ? maxBall : t >= 1 ? maxBall * 0.7 : 0;
    return { ball, hint: t === 0 ? 'Jadval topilmadi' : `${t} ta jadval` };
  }

  // SmartArt
  if (nom.includes('smartart') || nom.includes('sxema')) {
    const s = stats.smartArtCount;
    let ball = s >= 1 ? maxBall : 0;
    return { ball, hint: s === 0 ? 'SmartArt topilmadi' : `${s} ta SmartArt` };
  }

  // Animatsiya / o'tish / transition
  if (nom.includes('animatsiya') || nom.includes('animation') || nom.includes("o'tish") || nom.includes('transition') || nom.includes('effekt')) {
    let ball = (stats.hasAnimations && stats.hasTransitions) ? maxBall
             : (stats.hasAnimations || stats.hasTransitions) ? maxBall * 0.6
             : 0;
    return {
      ball,
      hint: `Animatsiya: ${stats.hasAnimations ? 'bor' : "yo'q"}, slayd o'tishi: ${stats.hasTransitions ? 'bor' : "yo'q"}`,
    };
  }

  // Shrift
  if (nom.includes('shrift') || nom.includes('font')) {
    const fonts = stats.fonts ?? [];
    const isReasonable = fonts.length > 0 && fonts.length <= 3;
    let ball = isReasonable ? maxBall
             : fonts.length > 0 ? maxBall * 0.5
             : maxBall * 0.2;
    return { ball, hint: `Shriftlar: ${fonts.join(', ') || 'aniqlanmadi'}` };
  }

  // Rang / dizayn
  if (nom.includes('rang') || nom.includes('color') || nom.includes('dizayn') || nom.includes('design')) {
    const c = (stats.colors ?? []).length;
    let ball = c >= 2 && c <= 8 ? maxBall
             : c >= 1           ? maxBall * 0.6
             : maxBall * 0.2;
    return { ball, hint: `${c} ta rang ishlatilgan (tavsiya: 2–6)` };
  }

  // Matn / mazmun / kontent
  if (nom.includes('matn') || nom.includes('kontent') || nom.includes('mazmun') || nom.includes('content') || nom.includes("ma'lumot")) {
    const w = stats.totalWords;
    let ball = w >= 100 ? maxBall
             : w >= 50  ? maxBall * 0.75
             : w >= 20  ? maxBall * 0.5
             : w >= 5   ? maxBall * 0.25
             : 0;
    return { ball, hint: `${w} ta so'z` };
  }

  // Eslatma / notes
  if (nom.includes('eslatma') || nom.includes('notes') || nom.includes("ma'ruzachi")) {
    let ball = stats.hasNotes ? maxBall : 0;
    return { ball, hint: stats.hasNotes ? 'Eslatmalar bor' : 'Speaker notes topilmadi' };
  }

  // Master / shablon / layout
  if (nom.includes('master') || nom.includes('shablon') || nom.includes('layout') || nom.includes("ko'rinish")) {
    const layouts = (stats.layouts ?? []).length;
    let ball = stats.hasMaster && layouts >= 2 ? maxBall
             : stats.hasMaster                 ? maxBall * 0.7
             : maxBall * 0.3;
    return { ball, hint: `Master: ${stats.hasMaster ? 'bor' : "yo'q"}, layouts: ${layouts}` };
  }

  // Bullet / ro'yxat
  if (nom.includes('bullet') || nom.includes("ro'yxat") || nom.includes('list') || nom.includes('punkt')) {
    const b = stats.bulletCount;
    let ball = b >= 5 ? maxBall : b >= 2 ? maxBall * 0.7 : b >= 1 ? maxBall * 0.4 : 0;
    return { ball, hint: `${b} ta marker (bullet) topildi` };
  }

  // Umumiy ko'rinish / format
  if (nom.includes('format') || nom.includes('umumiy') || nom.includes('rasmiy') || nom.includes('estetik')) {
    let parts = 0;
    if (stats.slideCount   >= 3) parts += 0.2;
    if (stats.titleCount   >= 1) parts += 0.2;
    if (stats.imageCount   >= 1) parts += 0.2;
    if ((stats.fonts ?? []).length > 0)  parts += 0.2;
    if (stats.hasAnimations || stats.hasTransitions) parts += 0.2;
    let ball = parseFloat((parts * maxBall).toFixed(2));
    return { ball, hint: `Slayd: ${stats.slideCount}, sarlavha: ${stats.titleCount}, rasm: ${stats.imageCount}` };
  }

  // Default — slayd va matn soniga qarab
  let ball = stats.slideCount >= 5 && stats.totalWords >= 50 ? maxBall * 0.8
           : stats.slideCount >= 3 ? maxBall * 0.5
           : maxBall * 0.2;
  return { ball, hint: `${stats.slideCount} ta slayd, ${stats.totalWords} ta so'z` };
}

module.exports = { uploadPptx, getPptxStatus, downloadStudentPptx };
