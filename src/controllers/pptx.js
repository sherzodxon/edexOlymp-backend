// src/controllers/pptx.js
const prisma = require('../db');
const path   = require('path');
const fs     = require('fs');
const JSZip  = require('jszip');

const MAX_PPTX_SCORE    = 25;
const DEFAULT_PPTX_TIME = 1200;

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

    // FIX: DOCS statusini ham ruxsat etish
    // Word vaqti tugab o'ta olmagan o'quvchilar uchun
    const allowedStatuses = ['PPTX', 'COMPLETED', 'DOCS'];
    if (!allowedStatuses.includes(student.status))
      return res.status(400).json({ error: 'Avval oldingi bosqichlarni yakunlang' });

    if (student.pptxSubmission)
      return res.status(409).json({ error: 'Siz allaqachon PPTX fayl yuklagansiz' });

    const config      = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const allCriteria = config?.pptxCriteria ? safeJson(config.pptxCriteria) : null;
    const criteria    = pickCriteriaForGrade(allCriteria, student.grade);
    const filePath    = req.file.path;

    const stats               = await analyzePptx(filePath);
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

    res.status(201).json({
      success: true,
      data: { score, feedback, fileName: req.file.originalname },
    });
  } catch (err) {
    console.error('Pptx upload error:', err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

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

function pickCriteriaForGrade(allCriteria, grade) {
  if (!allCriteria) return null;
  const hasGroups = allCriteria.group_5_6 || allCriteria.group_7_8 || allCriteria.group_9 || allCriteria.group_9_11;
  if (!hasGroups) return allCriteria;
  const g = parseInt(grade) || 0;
  if (g <= 6) return allCriteria.group_5_6 ?? null;
  if (g <= 8) return allCriteria.group_7_8 ?? null;
  return allCriteria.group_9 ?? allCriteria.group_9_11 ?? null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function analyzePptx(filePath) {
  const result = {
    slideCount: 0, totalText: '', totalWords: 0, totalCharCount: 0,
    titleCount: 0, customTitleCount: 0, bulletCount: 0,
    imageCount: 0, chartCount: 0, tableCount: 0, smartArtCount: 0,
    videoCount: 0, audioCount: 0, fonts: [], fontSizes: [], colors: [],
    hasTransitions: false, hasAnimations: false,
    transitionCount: 0, animationCount: 0,
    hasNotes: false, hasMaster: false, layouts: [],
  };

  try {
    const data      = fs.readFileSync(filePath);
    const zip       = await JSZip.loadAsync(data);
    const fileNames = Object.keys(zip.files);

    const slideFiles = fileNames
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)?.[0] ?? '0') - parseInt(b.match(/\d+/)?.[0] ?? '0'));
    result.slideCount = slideFiles.length;

    result.hasNotes  = fileNames.some(f => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(f));
    result.hasMaster = fileNames.some(f => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(f));
    result.layouts   = fileNames.filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(f));

    const mediaFiles  = fileNames.filter(f => /^ppt\/media\//i.test(f));
    result.imageCount = mediaFiles.filter(f => /\.(jpe?g|png|gif|bmp|webp|svg)$/i.test(f)).length;
    result.videoCount = mediaFiles.filter(f => /\.(mp4|avi|mov|wmv|webm)$/i.test(f)).length;
    result.audioCount = mediaFiles.filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)).length;
    result.chartCount = fileNames.filter(f => /^ppt\/charts\//i.test(f) && /chart\d+\.xml$/i.test(f)).length;

    const fontSet = new Set(), sizeSet = new Set(), colorSet = new Set();
    let titleHits = 0, customTitleHits = 0, bulletHits = 0, tableHits = 0;
    let smartArtHits = 0, transCount = 0, animCount = 0, allText = '';

    for (const slidePath of slideFiles) {
      const xml = await zip.file(slidePath).async('string');

      const hasStdTitle = /<p:ph[^>]*type="(title|ctrTitle)"/i.test(xml);
      if (hasStdTitle) titleHits++;
      else {
        const firstSp = xml.match(/<p:sp>([\s\S]*?)<\/p:sp>/);
        if (firstSp && (firstSp[1].match(/<a:t>([^<]{2,})<\/a:t>/g) ?? []).length > 0)
          customTitleHits++;
      }

      bulletHits  += (xml.match(/<a:buChar/g)   ?? []).length;
      bulletHits  += (xml.match(/<a:buAutoNum/g) ?? []).length;
      tableHits   += (xml.match(/<a:tbl>/g)      ?? []).length;
      if (/diagrams\/diagram/i.test(xml) || /<dgm:/i.test(xml)) smartArtHits++;
      if (/<p:transition/i.test(xml)) transCount++;
      if (/<p:timing/i.test(xml) && /<p:par|<p:cTn/i.test(xml)) animCount++;

      [...xml.matchAll(/typeface="([^"]+)"/g)].forEach(m => {
        const f = m[1];
        if (!f.startsWith('+') && f !== '' && f !== 'nil') fontSet.add(f);
      });
      [...xml.matchAll(/sz="(\d+)"/g)].forEach(m => {
        const size = parseInt(m[1]);
        if (size >= 100) sizeSet.add(Math.round(size / 100));
      });
      [...xml.matchAll(/srgbClr\s+val="([0-9A-Fa-f]{6})"/g)].forEach(m =>
        colorSet.add(m[1].toUpperCase())
      );

      allText += ' ' + (xml.match(/<a:t>[^<]*<\/a:t>/g) ?? [])
        .map(s => s.replace(/<\/?a:t>/g, '').trim()).filter(Boolean).join(' ');
    }

    result.titleCount = titleHits; result.customTitleCount = customTitleHits;
    result.bulletCount = bulletHits; result.tableCount = tableHits;
    result.smartArtCount = smartArtHits;
    result.transitionCount = transCount; result.animationCount = animCount;
    result.hasTransitions = transCount > 0; result.hasAnimations = animCount > 0;
    result.fonts     = [...fontSet];
    result.fontSizes = [...sizeSet].sort((a, b) => a - b);
    result.colors    = [...colorSet];

    const cleanText       = allText.trim().replace(/\s+/g, ' ');
    result.totalText      = cleanText;
    result.totalCharCount = cleanText.length;
    result.totalWords     = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0;

  } catch (err) {
    console.error('analyzePptx error:', err.message);
  }
  return result;
}

function evaluatePptx(stats, criteria) {
  const feedback = [];
  let earned = 0;

  if (criteria?.baholash_mezonlari?.length) {
    criteria.baholash_mezonlari.forEach(mezon => {
      const maxBall = mezon.maksimal_ball ?? 5;
      const nom     = (mezon.nomi ?? '').toLowerCase();
      const { ball, hint } = gradePptxMezon(nom, maxBall, stats);
      earned += ball;
      feedback.push({ item: mezon.nomi, passed: ball >= maxBall * 0.5,
        points: parseFloat(ball.toFixed(2)), maxPoints: maxBall,
        hint: ball >= maxBall ? null : hint });
    });
    return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_PPTX_SCORE), feedback };
  }

  const totalTitle = stats.titleCount + (stats.customTitleCount ?? 0);
  const defaults = [
    { item: "Slaydlar soni (≥ 5)",  check: stats.slideCount >= 5,  partial: stats.slideCount >= 3,  full: 5, part: 2.5, hint: `${stats.slideCount} ta slayd` },
    { item: 'Sarlavha mavjudligi',  check: totalTitle >= 3,        partial: totalTitle >= 1,        full: 5, part: 2.5, hint: 'Sarlavhalar topilmadi' },
    { item: 'Rasmlar / multimedia', check: stats.imageCount >= 2,  partial: stats.imageCount >= 1,  full: 5, part: 2.5, hint: `${stats.imageCount} ta rasm` },
    { item: "Animatsiya / o'tish",  check: stats.hasAnimations || stats.hasTransitions, partial: false, full: 5, part: 0, hint: "Animatsiya topilmadi" },
    { item: 'Matn / mazmun',        check: stats.totalWords >= 80, partial: stats.totalWords >= 30,  full: 5, part: 2.5, hint: `${stats.totalWords} ta so'z` },
  ];
  defaults.forEach(d => {
    const points = d.check ? d.full : d.partial ? d.part : 0;
    earned += points;
    feedback.push({ item: d.item, passed: d.check, points, hint: d.check ? null : d.hint });
  });
  return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_PPTX_SCORE), feedback };
}

function gradePptxMezon(nom, maxBall, stats) {
  if (nom.includes('slayd') || nom.includes('slide')) {
    const c = stats.slideCount;
    let ball = c >= 8 ? maxBall : c >= 5 ? maxBall * 0.8 : c >= 3 ? maxBall * 0.5 : c >= 1 ? maxBall * 0.25 : 0;
    return { ball, hint: `${c} ta slayd (tavsiya: ≥ 5)` };
  }

  if (nom.includes('sarlavha') || nom.includes('title') || nom.includes('mavzu')) {
    const std = stats.titleCount, custom = stats.customTitleCount ?? 0, s = stats.slideCount;
    if (std > 0) {
      let ball = std >= s * 0.7 ? maxBall : std >= s * 0.4 ? maxBall * 0.7 : std >= 1 ? maxBall * 0.4 : 0;
      return { ball, hint: `${std}/${s} ta slaydda sarlavha bor` };
    }
    if (custom > 0 || s > 0) {
      let ball = s >= 8 ? maxBall : s >= 5 ? maxBall * 0.8 : s >= 3 ? maxBall * 0.6 : s >= 1 ? maxBall * 0.3 : 0;
      return { ball, hint: `${s} ta slayd mavjud (sarlavhalar custom shaklda)` };
    }
    return { ball: 0, hint: 'Sarlavha topilmadi' };
  }

  if (nom.includes('rasm') || nom.includes('image') || nom.includes('vizual') || nom.includes('media')) {
    const total = stats.imageCount + stats.videoCount + stats.audioCount;
    let ball = total >= 4 ? maxBall : total >= 2 ? maxBall * 0.75 : total >= 1 ? maxBall * 0.5 : 0;
    return { ball, hint: `${stats.imageCount} ta rasm, ${stats.videoCount} ta video, ${stats.audioCount} ta audio` };
  }

  if (nom.includes('diagramma') || nom.includes('chart') || nom.includes('grafik')) {
    const c = stats.chartCount;
    let ball = c >= 2 ? maxBall : c >= 1 ? maxBall * 0.7 : 0;
    return { ball, hint: c === 0 ? 'Diagramma topilmadi' : `${c} ta diagramma` };
  }

  if (nom.includes('jadval') || nom.includes('table')) {
    const t = stats.tableCount;
    let ball = t >= 2 ? maxBall : t >= 1 ? maxBall * 0.7 : 0;
    return { ball, hint: t === 0 ? 'Jadval topilmadi' : `${t} ta jadval` };
  }

  if (nom.includes('smartart') || nom.includes('sxema')) {
    const s = stats.smartArtCount;
    return { ball: s >= 1 ? maxBall : 0, hint: s === 0 ? 'SmartArt topilmadi' : `${s} ta SmartArt` };
  }

  if (nom.includes('animatsiya') || nom.includes('animation') || nom.includes("o'tish") || nom.includes('transition') || nom.includes('effekt')) {
    const tc = stats.transitionCount ?? (stats.hasTransitions ? 1 : 0);
    const ac = stats.animationCount  ?? (stats.hasAnimations  ? 1 : 0);
    const s  = stats.slideCount;
    const transOk = tc >= Math.ceil(s * 0.5);
    const animOk  = ac >= 1;
    let ball = (transOk && animOk) ? maxBall : (transOk || animOk) ? maxBall * 0.6 : (tc > 0 || ac > 0) ? maxBall * 0.3 : 0;
    return { ball, hint: `Transition: ${tc}/${s} slayd, Animatsiya: ${ac} ta slayd` };
  }

  if (nom.includes('shrift') || nom.includes('font')) {
    const fonts = stats.fonts ?? [];
    let ball = fonts.length >= 1 && fonts.length <= 3 ? maxBall : fonts.length > 3 ? maxBall * 0.7 : maxBall * 0.2;
    return { ball, hint: `Shriftlar (${fonts.length}): ${fonts.slice(0, 3).join(', ') || 'aniqlanmadi'}` };
  }

  if (nom.includes('rang') || nom.includes('color') || nom.includes('dizayn') || nom.includes('design')) {
    const c = (stats.colors ?? []).length;
    let ball = c >= 2 && c <= 8 ? maxBall : c >= 1 ? maxBall * 0.6 : maxBall * 0.2;
    return { ball, hint: `${c} ta rang (tavsiya: 2–6)` };
  }

  if (nom.includes('matn') || nom.includes('kontent') || nom.includes('mazmun') || nom.includes('content') || nom.includes("ma'lumot")) {
    const w = stats.totalWords;
    let ball = w >= 100 ? maxBall : w >= 50 ? maxBall * 0.75 : w >= 20 ? maxBall * 0.5 : w >= 5 ? maxBall * 0.25 : 0;
    return { ball, hint: `${w} ta so'z (tavsiya: ≥ 100)` };
  }

  if (nom.includes('eslatma') || nom.includes('notes') || nom.includes("ma'ruzachi")) {
    return { ball: stats.hasNotes ? maxBall : 0, hint: stats.hasNotes ? 'Eslatmalar mavjud' : 'Speaker notes topilmadi' };
  }

  if (nom.includes('master') || nom.includes('layout') || nom.includes("ko'rinish")) {
    const layouts = (stats.layouts ?? []).length;
    let ball = stats.hasMaster && layouts >= 2 ? maxBall : stats.hasMaster ? maxBall * 0.7 : maxBall * 0.3;
    return { ball, hint: `Master: ${stats.hasMaster ? 'bor' : "yo'q"}, layout: ${layouts} ta` };
  }

  if (nom.includes('bullet') || nom.includes("ro'yxat") || nom.includes('list') || nom.includes('punkt')) {
    const b = stats.bulletCount;
    let ball = b >= 5 ? maxBall : b >= 2 ? maxBall * 0.7 : b >= 1 ? maxBall * 0.4 : 0;
    return { ball, hint: `${b} ta bullet/marker topildi` };
  }

  if (nom.includes('format') || nom.includes('umumiy') || nom.includes('rasmiy') || nom.includes('estetik')) {
    let parts = 0;
    if (stats.slideCount >= 3)                                  parts += 0.2;
    if (stats.titleCount + (stats.customTitleCount ?? 0) >= 1) parts += 0.2;
    if (stats.imageCount >= 1)                                  parts += 0.2;
    if ((stats.fonts ?? []).length > 0)                         parts += 0.2;
    if (stats.hasAnimations || stats.hasTransitions)            parts += 0.2;
    return { ball: parseFloat((parts * maxBall).toFixed(2)),
      hint: `Slayd: ${stats.slideCount}, rasm: ${stats.imageCount}, transition: ${stats.transitionCount ?? 0}` };
  }

  const s = stats.slideCount, w = stats.totalWords;
  let ball = s >= 5 && w >= 50 ? maxBall * 0.8 : s >= 3 ? maxBall * 0.5 : maxBall * 0.2;
  return { ball, hint: `${s} ta slayd, ${w} ta so'z` };
}

module.exports = { uploadPptx, getPptxStatus, downloadStudentPptx };