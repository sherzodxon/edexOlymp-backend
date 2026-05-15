// src/controllers/pptx.js
const prisma = require('../db');
const path   = require('path');
const fs     = require('fs');
const JSZip  = require('jszip');

const MAX_PPTX_SCORE    = 25;
const DEFAULT_PPTX_TIME = 1200; // 20 daqiqa

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

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (student.status !== 'PPTX' && student.status !== 'COMPLETED')
      return res.status(400).json({ error: 'Avval oldingi bosqichlarni yakunlang' });
    if (student.pptxSubmission)
      return res.status(409).json({ error: 'Siz allaqachon PPTX fayl yuklagansiz' });

    const config      = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const allCriteria = config?.pptxCriteria ? safeJson(config.pptxCriteria) : null;
    const criteria    = pickCriteriaForGrade(allCriteria, student.grade);
    const filePath    = req.file.path;

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
      data: {
        status: student.status,
        submission: student.pptxSubmission,
        timeLimitSec,
        remainingSec,
        criteria,
        maxScore: MAX_PPTX_SCORE,
      },
    });
  } catch (err) {
    console.error('Pptx status error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Sinf guruhiga mos mezonni tanlash
// ──────────────────────────────────────────────
function pickCriteriaForGrade(allCriteria, grade) {
  if (!allCriteria) return null;
  const hasGroups =
    allCriteria.group_5_6 || allCriteria.group_7_8 ||
    allCriteria.group_9   || allCriteria.group_9_11;
  if (!hasGroups) return allCriteria;
  const g = parseInt(grade) || 0;
  if (g <= 6) return allCriteria.group_5_6 ?? null;
  if (g <= 8) return allCriteria.group_7_8 ?? null;
  return allCriteria.group_9 ?? allCriteria.group_9_11 ?? null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ──────────────────────────────────────────────
// JSZip orqali .pptx XML tahlili
// FIX 1: titleCount — custom shape sarlavhalarni ham hisoblaydi
// FIX 2: hasTransitions / hasAnimations — har slayd alohida tekshiriladi
// ──────────────────────────────────────────────
async function analyzePptx(filePath) {
  const result = {
    slideCount:    0,
    totalText:     '',
    totalWords:    0,
    totalCharCount:0,
    titleCount:    0,       // <p:ph type="title"> bo'lgan slaydlar
    customTitleCount: 0,    // FIX: sarlavha placeholder ishlatmagan slaydlar
    bulletCount:   0,
    imageCount:    0,
    chartCount:    0,
    tableCount:    0,
    smartArtCount: 0,
    videoCount:    0,
    audioCount:    0,
    fonts:         [],
    fontSizes:     [],
    colors:        [],
    hasTransitions:false,
    hasAnimations: false,
    transitionCount: 0,     // FIX: nechtasida transition bor
    animationCount:  0,     // FIX: nechtasida animation bor
    hasNotes:      false,
    hasMaster:     false,
    layouts:       [],
  };

  try {
    const data     = fs.readFileSync(filePath);
    const zip      = await JSZip.loadAsync(data);
    const fileNames = Object.keys(zip.files);

    // ── Slaydlar ──
    const slideFiles = fileNames
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] ?? '0');
        const nb = parseInt(b.match(/\d+/)?.[0] ?? '0');
        return na - nb;
      });
    result.slideCount = slideFiles.length;

    // ── Notes ──
    result.hasNotes = fileNames.some(f => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(f));

    // ── Master / Layout ──
    result.hasMaster = fileNames.some(f => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(f));
    result.layouts   = fileNames.filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(f));

    // ── Media fayllar ──
    const mediaFiles = fileNames.filter(f => /^ppt\/media\//i.test(f));
    result.imageCount = mediaFiles.filter(f => /\.(jpe?g|png|gif|bmp|webp|svg)$/i.test(f)).length;
    result.videoCount = mediaFiles.filter(f => /\.(mp4|avi|mov|wmv|webm)$/i.test(f)).length;
    result.audioCount = mediaFiles.filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)).length;

    // ── Chartlar ──
    result.chartCount = fileNames.filter(
      f => /^ppt\/charts\//i.test(f) && /chart\d+\.xml$/i.test(f)
    ).length;

    const fontSet    = new Set();
    const sizeSet    = new Set();
    const colorSet   = new Set();
    let titleHits    = 0;
    let customTitleHits = 0;
    let bulletHits   = 0;
    let tableHits    = 0;
    let smartArtHits = 0;
    let transCount   = 0;
    let animCount    = 0;
    let allText      = '';

    for (const slidePath of slideFiles) {
      const xml = await zip.file(slidePath).async('string');

      // ── Sarlavha: standart placeholder ──
      const hasStdTitle = /<p:ph[^>]*type="(title|ctrTitle)"/i.test(xml);
      if (hasStdTitle) titleHits++;

      // FIX: Custom sarlavha — placeholder ishlatmagan, lekin
      // birinchi yirik matn bloki (>3 belgi, kichik hajmda) sarlavha sifatida
      // Birinchi <p:sp> ichidagi matn sarlavha hisobilanadi
      if (!hasStdTitle) {
        const firstSpMatch = xml.match(/<p:sp>([\s\S]*?)<\/p:sp>/);
        if (firstSpMatch) {
          const firstTexts = firstSpMatch[1].match(/<a:t>([^<]{2,})<\/a:t>/g) ?? [];
          if (firstTexts.length > 0) customTitleHits++;
        }
      }

      // ── Bullet ──
      bulletHits += (xml.match(/<a:buChar/g) ?? []).length;
      bulletHits += (xml.match(/<a:buAutoNum/g) ?? []).length;

      // ── Jadval ──
      tableHits += (xml.match(/<a:tbl>/g) ?? []).length;

      // ── SmartArt ──
      if (/diagrams\/diagram/i.test(xml) || /<dgm:/i.test(xml)) smartArtHits++;

      // FIX: Transition — har slayd alohida sanash
      if (/<p:transition/i.test(xml)) transCount++;

      // FIX: Animation — har slayd alohida sanash
      if (/<p:timing/i.test(xml) && /<p:par|<p:cTn/i.test(xml)) animCount++;

      // ── Shrift, o'lcham, rang ──
      [...xml.matchAll(/typeface="([^"]+)"/g)].forEach(m => {
        const f = m[1];
        // System fontlarni skip qilish
        if (!f.startsWith('+') && f !== '' && f !== 'nil') fontSet.add(f);
      });
      [...xml.matchAll(/sz="(\d+)"/g)].forEach(m => {
        const size = parseInt(m[1]);
        if (size >= 100) sizeSet.add(Math.round(size / 100)); // 100 = 1pt minimum
      });
      [...xml.matchAll(/srgbClr\s+val="([0-9A-Fa-f]{6})"/g)].forEach(m =>
        colorSet.add(m[1].toUpperCase())
      );

      // ── Matn ──
      const txt = (xml.match(/<a:t>[^<]*<\/a:t>/g) ?? [])
        .map(s => s.replace(/<\/?a:t>/g, '').trim())
        .filter(Boolean)
        .join(' ');
      allText += ' ' + txt;
    }

    result.titleCount      = titleHits;
    result.customTitleCount = customTitleHits;
    result.bulletCount     = bulletHits;
    result.tableCount      = tableHits;
    result.smartArtCount   = smartArtHits;
    result.transitionCount = transCount;
    result.animationCount  = animCount;
    result.hasTransitions  = transCount > 0;
    result.hasAnimations   = animCount > 0;
    result.fonts           = [...fontSet];
    result.fontSizes       = [...sizeSet].sort((a, b) => a - b);
    result.colors          = [...colorSet];

    const cleanText        = allText.trim().replace(/\s+/g, ' ');
    result.totalText       = cleanText;
    result.totalCharCount  = cleanText.length;
    result.totalWords      = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0;

  } catch (err) {
    console.error('analyzePptx error:', err.message);
  }

  return result;
}

// ──────────────────────────────────────────────
// Asosiy baholash (max 25)
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
        item:      mezon.nomi,
        passed:    ball >= maxBall * 0.5,
        points:    parseFloat(ball.toFixed(2)),
        maxPoints: maxBall,
        hint:      ball >= maxBall ? null : hint,
      });
    });
    return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_PPTX_SCORE), feedback };
  }

  // Mezon yo'q — default (max 25)
  const defaults = [
    { item: "Slaydlar soni (≥ 5)",  check: stats.slideCount >= 5,  partial: stats.slideCount >= 3,  full: 5, part: 2.5, hint: `${stats.slideCount} ta slayd` },
    { item: 'Sarlavha mavjudligi',  check: stats.titleCount + stats.customTitleCount >= 3, partial: stats.titleCount + stats.customTitleCount >= 1, full: 5, part: 2.5, hint: 'Sarlavhalar topilmadi' },
    { item: 'Rasmlar / multimedia', check: stats.imageCount >= 2,  partial: stats.imageCount >= 1,  full: 5, part: 2.5, hint: `${stats.imageCount} ta rasm` },
    { item: "Animatsiya / o'tish",  check: stats.hasAnimations || stats.hasTransitions, partial: false, full: 5, part: 0, hint: "Animatsiya yoki o'tish effektlari topilmadi" },
    { item: 'Matn / mazmun',        check: stats.totalWords >= 80, partial: stats.totalWords >= 30,  full: 5, part: 2.5, hint: `${stats.totalWords} ta so'z` },
  ];
  defaults.forEach(d => {
    const points = d.check ? d.full : d.partial ? d.part : 0;
    earned += points;
    feedback.push({ item: d.item, passed: d.check, points, hint: d.check ? null : d.hint });
  });
  return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_PPTX_SCORE), feedback };
}

// ──────────────────────────────────────────────
// Har bir mezon turini baholash
// FIX: sarlavha — custom shape fallback qo'shildi
// FIX: animatsiya — transitionCount/animationCount ishlatiladi
// ──────────────────────────────────────────────
function gradePptxMezon(nom, maxBall, stats) {

  // ── Slaydlar soni ──
  if (nom.includes('slayd') || nom.includes('slide')) {
    const c = stats.slideCount;
    let ball = c >= 8 ? maxBall
             : c >= 5 ? maxBall * 0.8
             : c >= 3 ? maxBall * 0.5
             : c >= 1 ? maxBall * 0.25
             : 0;
    return { ball, hint: `${c} ta slayd (tavsiya: ≥ 5)` };
  }

  // ── Sarlavha / Title ──
  // FIX: titleCount 0 bo'lsa customTitleCount ga qaraladi
  if (nom.includes('sarlavha') || nom.includes('title') || nom.includes('mavzu')) {
    const stdTitle    = stats.titleCount;
    const customTitle = stats.customTitleCount ?? 0;
    const s           = stats.slideCount;

    // Standart placeholder sarlavhalar bor
    if (stdTitle > 0) {
      let ball = stdTitle >= s * 0.7 ? maxBall
               : stdTitle >= s * 0.4 ? maxBall * 0.7
               : stdTitle >= 1       ? maxBall * 0.4
               : 0;
      return { ball, hint: `${stdTitle}/${s} ta slaydda sarlavha bor` };
    }

    // FIX: Custom shape sarlavhalar (placeholder ishlatmagan)
    // Slayd soniga qarab baholash
    if (customTitle > 0 || s > 0) {
      let ball = s >= 8 ? maxBall
               : s >= 5 ? maxBall * 0.8
               : s >= 3 ? maxBall * 0.6
               : s >= 1 ? maxBall * 0.3
               : 0;
      return { ball, hint: `${s} ta slayd mavjud (sarlavhalar custom shaklda yozilgan)` };
    }

    return { ball: 0, hint: 'Sarlavha topilmadi' };
  }

  // ── Rasm / multimedia / vizual ──
  if (nom.includes('rasm') || nom.includes('image') || nom.includes('vizual') || nom.includes('media')) {
    const total = stats.imageCount + stats.videoCount + stats.audioCount;
    let ball = total >= 4 ? maxBall
             : total >= 2 ? maxBall * 0.75
             : total >= 1 ? maxBall * 0.5
             : 0;
    return {
      ball,
      hint: `${stats.imageCount} ta rasm, ${stats.videoCount} ta video, ${stats.audioCount} ta audio`,
    };
  }

  // ── Diagramma / chart / grafik ──
  if (nom.includes('diagramma') || nom.includes('chart') || nom.includes('grafik')) {
    const c = stats.chartCount;
    let ball = c >= 2 ? maxBall : c >= 1 ? maxBall * 0.7 : 0;
    return { ball, hint: c === 0 ? 'Diagramma topilmadi' : `${c} ta diagramma` };
  }

  // ── Jadval ──
  if (nom.includes('jadval') || nom.includes('table')) {
    const t = stats.tableCount;
    let ball = t >= 2 ? maxBall : t >= 1 ? maxBall * 0.7 : 0;
    return { ball, hint: t === 0 ? 'Jadval topilmadi' : `${t} ta jadval` };
  }

  // ── SmartArt ──
  if (nom.includes('smartart') || nom.includes('sxema')) {
    const s = stats.smartArtCount;
    let ball = s >= 1 ? maxBall : 0;
    return { ball, hint: s === 0 ? 'SmartArt topilmadi' : `${s} ta SmartArt` };
  }

  // ── Animatsiya / o'tish / transition ──
  // FIX: transitionCount va animationCount — nechtasida bor hisoblanadi
  if (
    nom.includes('animatsiya') || nom.includes('animation') ||
    nom.includes("o'tish")     || nom.includes('transition') ||
    nom.includes('effekt')
  ) {
    const tc = stats.transitionCount ?? (stats.hasTransitions ? 1 : 0);
    const ac = stats.animationCount  ?? (stats.hasAnimations  ? 1 : 0);
    const s  = stats.slideCount;

    const transOk = tc >= Math.ceil(s * 0.5); // kamida yarmi slaydda transition
    const animOk  = ac >= 1;

    let ball = (transOk && animOk) ? maxBall
             : (transOk || animOk) ? maxBall * 0.6
             : (tc > 0  || ac > 0) ? maxBall * 0.3
             : 0;
    return {
      ball,
      hint: `Transition: ${tc}/${s} slayd, Animatsiya: ${ac} ta slayd`,
    };
  }

  // ── Shrift ──
  if (nom.includes('shrift') || nom.includes('font')) {
    const fonts = stats.fonts ?? [];
    // 1-3 xil shrift optimal
    let ball = fonts.length >= 1 && fonts.length <= 3 ? maxBall
             : fonts.length > 3                       ? maxBall * 0.7
             : maxBall * 0.2;
    return { ball, hint: `Shriftlar (${fonts.length}): ${fonts.slice(0, 3).join(', ') || 'aniqlanmadi'}` };
  }

  // ── Rang / dizayn ──
  if (
    nom.includes('rang')   || nom.includes('color') ||
    nom.includes('dizayn') || nom.includes('design')
  ) {
    const c = (stats.colors ?? []).length;
    let ball = c >= 2 && c <= 8 ? maxBall
             : c >= 1           ? maxBall * 0.6
             : maxBall * 0.2;
    return { ball, hint: `${c} ta rang ishlatilgan (tavsiya: 2–6)` };
  }

  // ── Matn / mazmun / kontent ──
  if (
    nom.includes('matn')    || nom.includes('kontent') ||
    nom.includes('mazmun')  || nom.includes('content') ||
    nom.includes("ma'lumot")
  ) {
    const w = stats.totalWords;
    let ball = w >= 100 ? maxBall
             : w >= 50  ? maxBall * 0.75
             : w >= 20  ? maxBall * 0.5
             : w >= 5   ? maxBall * 0.25
             : 0;
    return { ball, hint: `${w} ta so'z (tavsiya: ≥ 100)` };
  }

  // ── Eslatma / notes ──
  if (nom.includes('eslatma') || nom.includes('notes') || nom.includes("ma'ruzachi")) {
    let ball = stats.hasNotes ? maxBall : 0;
    return { ball, hint: stats.hasNotes ? 'Eslatmalar mavjud' : "Speaker notes topilmadi" };
  }

  // ── Master / layout ──
  if (
    nom.includes('master')   || nom.includes('layout') ||
    nom.includes("ko'rinish")
  ) {
    const layouts = (stats.layouts ?? []).length;
    let ball = stats.hasMaster && layouts >= 2 ? maxBall
             : stats.hasMaster                 ? maxBall * 0.7
             : maxBall * 0.3;
    return { ball, hint: `Master: ${stats.hasMaster ? 'bor' : "yo'q"}, layout: ${layouts} ta` };
  }

  // ── Bullet / ro'yxat ──
  if (
    nom.includes('bullet') || nom.includes("ro'yxat") ||
    nom.includes('list')   || nom.includes('punkt')
  ) {
    const b = stats.bulletCount;
    let ball = b >= 5 ? maxBall
             : b >= 2 ? maxBall * 0.7
             : b >= 1 ? maxBall * 0.4
             : 0;
    return { ball, hint: `${b} ta bullet/marker topildi` };
  }

  // ── Umumiy ko'rinish / format ──
  if (
    nom.includes('format') || nom.includes('umumiy') ||
    nom.includes('rasmiy') || nom.includes('estetik')
  ) {
    let parts = 0;
    if (stats.slideCount >= 3)                           parts += 0.2;
    if (stats.titleCount + (stats.customTitleCount ?? 0) >= 1) parts += 0.2;
    if (stats.imageCount >= 1)                           parts += 0.2;
    if ((stats.fonts ?? []).length > 0)                  parts += 0.2;
    if (stats.hasAnimations || stats.hasTransitions)     parts += 0.2;
    let ball = parseFloat((parts * maxBall).toFixed(2));
    return {
      ball,
      hint: `Slayd: ${stats.slideCount}, rasm: ${stats.imageCount}, transition: ${stats.transitionCount ?? 0}`,
    };
  }

  // ── Default fallback ──
  const s = stats.slideCount;
  const w = stats.totalWords;
  let ball = s >= 5 && w >= 50 ? maxBall * 0.8
           : s >= 3            ? maxBall * 0.5
           : maxBall * 0.2;
  return { ball, hint: `${s} ta slayd, ${w} ta so'z` };
}

module.exports = { uploadPptx, getPptxStatus, downloadStudentPptx };