// src/controllers/docs.js
const prisma  = require('../db');
const mammoth = require('mammoth');
const path    = require('path');
const fs      = require('fs');
const JSZip   = require('jszip');

const MAX_DOCS_SCORE    = 25;
const DEFAULT_DOCS_TIME = 1500; // 25 daqiqa

// ──────────────────────────────────────────────
// Word fayl yuklash
// ──────────────────────────────────────────────
const uploadDoc = async (req, res) => {
  const { token } = req.body;
  if (!token)    return res.status(400).json({ error: 'Token majburiy' });
  if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { docsSubmission: true, testSession: true },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });

    // TYPING yoki TEST bosqichida bo'lsa bloklash
    if (student.status === 'TYPING' || student.status === 'TEST')
      return res.status(400).json({ error: 'Avval oldingi bosqichlarni yakunlang' });

    // Allaqachon yuklangan
    if (student.docsSubmission)
      return res.status(409).json({ error: 'Siz allaqachon Word fayl yuklagansiz' });

    const config      = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const allCriteria = config?.docsCriteria ? safeJson(config.docsCriteria) : null;
    const criteria    = pickCriteriaForGrade(allCriteria, student.grade);
    const filePath    = req.file.path;

    // mammoth — matn + HTML
    const [textResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ path: filePath }),
      mammoth.convertToHtml({ path: filePath }),
    ]);

    const formatStats = await analyzeDocxFormat(filePath);
    const rawText     = textResult.value.trim();
    const rawHtml     = htmlResult.value;

    const { score, feedback } = evaluateDoc(rawText, rawHtml, formatStats, criteria);

    await prisma.$transaction(async (tx) => {
      await tx.docsSubmission.create({
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
        data: { status: 'PPTX', docsScore: score, totalScore: { increment: score } },
      });
    });

    res.status(201).json({
      success: true,
      data: { score, feedback, fileName: req.file.originalname },
    });
  } catch (err) {
    console.error('Docs upload error:', err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Word fayl yuklab olish (admin)
// ──────────────────────────────────────────────
const downloadStudentDoc = async (req, res) => {
  const { studentId } = req.params;
  try {
    const submission = await prisma.docsSubmission.findFirst({
      where: { studentId: parseInt(studentId) },
      include: { student: true },
    });
    if (!submission) return res.status(404).json({ error: 'Fayl topilmadi' });

    const filePath = submission.filePath;
    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: 'Fayl serverda topilmadi' });

    const fileName = `${submission.student.lastName}_${submission.student.firstName}_${submission.fileName}`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    console.error('Download doc error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Docs holati
// FIX: vaqt tugab, fayl yuklanmagan bo'lsa — status PPTX ga o'tkaziladi
// ──────────────────────────────────────────────
const getDocsStatus = async (req, res) => {
  const { token } = req.params;
  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { docsSubmission: true, testSession: true },
    });
    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });

    const config       = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const timeLimitSec = config?.docsTimeLimitSec || DEFAULT_DOCS_TIME;

    let remainingSec = timeLimitSec;
    if (student.testSession?.finishedAt) {
      const elapsedSec = Math.floor(
        (Date.now() - new Date(student.testSession.finishedAt).getTime()) / 1000
      );
      remainingSec = Math.max(0, timeLimitSec - elapsedSec);
    }

    // ── FIX: Vaqt tugagan + fayl yuklanmagan + hali DOCS statusida ──
    // Statusni PPTX ga o'tkazib, keyingi bosqichga yo'l ochish
    if (remainingSec === 0 && !student.docsSubmission && student.status === 'DOCS') {
      await prisma.student.update({
        where: { id: student.id },
        data: { status: 'PPTX' },
      });
    }

    const allCriteria = config?.docsCriteria ? safeJson(config.docsCriteria) : null;
    const criteria    = pickCriteriaForGrade(allCriteria, student.grade);

    res.json({
      success: true,
      data: {
        status:       student.status,
        submission:   student.docsSubmission,
        timeLimitSec,
        remainingSec,
        criteria,
        maxScore:     MAX_DOCS_SCORE,
        timeExpired:  remainingSec === 0 && !student.docsSubmission,
      },
    });
  } catch (err) {
    console.error('Docs status error:', err);
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
  if (g <= 6) return allCriteria.group_5_6  ?? null;
  if (g <= 8) return allCriteria.group_7_8  ?? null;
  return allCriteria.group_9 ?? allCriteria.group_9_11 ?? null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ──────────────────────────────────────────────
// JSZip orqali .docx XML tahlili
// FIX: fonts — styles.xml fallback qo'shildi
// FIX: imageCount — rels.xml dan o'qiladi
// ──────────────────────────────────────────────
async function analyzeDocxFormat(filePath) {
  const result = {
    fonts: [], sizes: [], hasUniformFont: false, hasUniformSize: false,
    boldCount: 0, italicCount: 0, underlineCount: 0,
    alignments: [], colors: [], tableCount: 0,
    hasTitle: false, hasCenterAlign: false, hasJustifyAlign: false,
    paragraphSpacing: false, imageCount: 0,
  };

  try {
    const data      = fs.readFileSync(filePath);
    const zip       = await JSZip.loadAsync(data);
    const docXml    = await zip.file('word/document.xml')?.async('string') ?? '';
    const stylesXml = await zip.file('word/styles.xml')?.async('string')   ?? '';

    // ── Shrift oilasi ──
    const fontMatches = [...docXml.matchAll(/w:rFonts[^/]*?w:ascii="([^"]+)"/g)];
    const fontSet     = new Set(fontMatches.map(m => m[1]));

    // FIX: document.xml da font yo'q bo'lsa styles.xml dan olish
    if (fontSet.size === 0) {
      const stylesFonts = [...stylesXml.matchAll(/w:rFonts[^/]*?w:ascii="([^"]+)"/g)];
      stylesFonts.forEach(m => fontSet.add(m[1]));
    }

    result.fonts          = [...fontSet];
    result.hasUniformFont = fontSet.size <= 2;

    // ── Shrift o'lchami (pt = val/2) ──
    const sizeMatches = [...docXml.matchAll(/w:sz(?!Cs)\s+w:val="(\d+)"/g)];
    const sizeSet     = new Set(sizeMatches.map(m => parseInt(m[1]) / 2));
    result.sizes          = [...sizeSet].sort((a, b) => a - b);
    result.hasUniformSize = sizeSet.size <= 2;

    // ── Formatlashtirish ──
    result.boldCount      = (docXml.match(/<w:b\/>/g)      ?? []).length;
    result.italicCount    = (docXml.match(/<w:i\/>/g)      ?? []).length;
    result.underlineCount = (docXml.match(/<w:u\s+w:val/g) ?? []).length;

    // ── Tekislash ──
    const alignMatches = [...docXml.matchAll(/w:jc\s+w:val="([^"]+)"/g)];
    const alignSet     = new Set(alignMatches.map(m => m[1]));
    result.alignments      = [...alignSet];
    result.hasCenterAlign  = alignSet.has('center');
    result.hasJustifyAlign = alignSet.has('both');

    // ── Rang ──
    const colorMatches = [...docXml.matchAll(/w:color\s+w:val="([^"]+)"/g)];
    const colorSet     = new Set(colorMatches.map(m => m[1]).filter(c => c !== 'auto'));
    result.colors = [...colorSet];

    // FIX: Rasmlar soni — rels.xml dan
    const relXml      = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? '';
    result.imageCount = (relXml.match(/Type="[^"]*\/image"/g) ?? []).length;

    // ── Jadvallar ──
    result.tableCount = (docXml.match(/<w:tbl>/g) ?? []).length;

    // ── Sarlavha ──
    result.hasTitle =
      /<w:pStyle\s+w:val="Heading\d*"/.test(docXml) ||
      /<w:pStyle\s+w:val="[^"]*[Ss]arlavha[^"]*"/.test(docXml);

    result.paragraphSpacing = /<w:spacing\s+w:before="(\d+)"/.test(docXml);

  } catch (err) {
    console.error('analyzeDocxFormat error:', err.message);
  }

  return result;
}

// ──────────────────────────────────────────────
// Matn tahlili (mammoth)
// ──────────────────────────────────────────────
function analyzeDoc(rawText, rawHtml) {
  const words       = rawText.split(/\s+/).filter(Boolean);
  const sentences   = rawText.split(/[.!?]+/).filter(s => s.trim().length > 3);
  const paragraphs  = rawText.split(/\n\s*\n/).filter(p => p.trim().length > 10);
  const lines       = rawText.split('\n').filter(l => l.trim().length > 0);
  const allPunct    = (rawText.match(/[.,!?;:—–-]/g) ?? []).length;
  const uniqueWords = new Set(
    words.map(w => w.toLowerCase().replace(/[^a-zA-Zа-яёА-ЯЁ]/g, ''))
  );

  return {
    wordCount:           words.length,
    charCount:           rawText.length,
    sentenceCount:       sentences.length,
    paragraphCount:      paragraphs.length,
    lineCount:           lines.length,
    tableCount:          (rawHtml.match(/<table/gi)  ?? []).length,
    listCount:           (rawHtml.match(/<ul|<ol/gi) ?? []).length,
    boldCount:           (rawHtml.match(/<strong/gi) ?? []).length,
    headingCount:        (rawHtml.match(/<h[1-6]/gi) ?? []).length,
    allPunct,
    avgWordsPerSentence: sentences.length > 0
      ? Math.round(words.length / sentences.length) : 0,
    lexicalRatio: words.length > 0 ? uniqueWords.size / words.length : 0,
    hasTitle:
      (rawHtml.match(/<h[1-6]/gi) ?? []).length > 0 ||
      (lines[0]?.length ?? 0) < 60,
    hasConclusion: /xulosa|conclusion|yakun/i.test(rawText),
    hasIntro:      /kirish|muqaddima|introduction/i.test(rawText),
  };
}

// ──────────────────────────────────────────────
// Baholash
// ──────────────────────────────────────────────
function evaluateDoc(rawText, rawHtml, formatStats, criteria) {
  const stats    = analyzeDoc(rawText, rawHtml);
  const feedback = [];
  let earned     = 0;

  if (criteria?.baholash_mezonlari?.length) {
    criteria.baholash_mezonlari.forEach(mezon => {
      const maxBall = mezon.maksimal_ball ?? 5;
      const nom     = (mezon.nomi ?? '').toLowerCase();
      const { ball, hint } = gradeMezon(nom, maxBall, stats, formatStats, rawText);
      earned += ball;
      feedback.push({
        item:      mezon.nomi,
        passed:    ball >= maxBall * 0.5,
        points:    parseFloat(ball.toFixed(2)),
        maxPoints: maxBall,
        hint:      ball >= maxBall ? null : hint,
      });
    });
    return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_DOCS_SCORE), feedback };
  }

  // Eski items formati
  if (criteria?.items?.length) {
    const pointsPerItem = MAX_DOCS_SCORE / criteria.items.length;
    criteria.items.forEach(item => {
      const keyword  = item.keyword?.toLowerCase();
      const minWords = item.minWords;
      const passed   = keyword  ? rawText.toLowerCase().includes(keyword)
                     : minWords ? stats.wordCount >= minWords
                     : true;
      const points = passed ? parseFloat(pointsPerItem.toFixed(2)) : 0;
      earned += points;
      feedback.push({
        item:   item.label || keyword || 'Mezon',
        passed,
        points,
        hint:   passed ? null : item.hint || 'Ushbu talabni bajarmadingiz',
      });
    });
    return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_DOCS_SCORE), feedback };
  }

  // Mezon yo'q — default
  const defaults = [
    { item: "So'z soni (≥ 150)",   check: stats.wordCount >= 150,       partial: stats.wordCount >= 80,       full: 5, part: 2.5, hint: `${stats.wordCount} ta so'z` },
    { item: 'Matn tuzilishi',      check: stats.paragraphCount >= 3 && stats.hasTitle, partial: stats.paragraphCount >= 2, full: 5, part: 2.5, hint: `${stats.paragraphCount} ta abzat` },
    { item: 'Tinish belgilari',    check: stats.allPunct >= 10,          partial: stats.allPunct >= 3,          full: 5, part: 2.5, hint: `${stats.allPunct} ta tinish belgisi` },
    { item: 'Leksik xilma-xillik', check: stats.lexicalRatio >= 0.6,    partial: stats.lexicalRatio >= 0.4,    full: 5, part: 2.5, hint: `${(stats.lexicalRatio * 100).toFixed(0)}%` },
  ];
  defaults.forEach(d => {
    const points = d.check ? d.full : d.partial ? d.part : 0;
    earned += points;
    feedback.push({ item: d.item, passed: d.check, points, hint: d.check ? null : d.hint });
  });
  return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_DOCS_SCORE), feedback };
}

// ──────────────────────────────────────────────
// Har bir mezon turini baholash
// ──────────────────────────────────────────────
function gradeMezon(nom, maxBall, stats, fmt, rawText) {

  // ── So'z soni / hajm ──
  if (nom.includes("so'z") || nom.includes('word') || nom.includes('hajm')) {
    const w = stats.wordCount;
    let ball = w >= 200 ? maxBall
             : w >= 150 ? maxBall * 0.8
             : w >= 100 ? maxBall * 0.5
             : maxBall * 0.2;
    return { ball, hint: `${w} ta so'z` };
  }

  // ── Rasm ──
  if (nom.includes('rasm') || nom.includes('image')) {
    const count = fmt.imageCount ?? 0;
    let ball = count >= 2 ? maxBall
             : count === 1 ? maxBall * 0.6
             : 0;
    return { ball, hint: count === 0 ? 'Rasm topilmadi' : `${count} ta rasm mavjud` };
  }

  // ── Imlo / spelling ──
  if (nom.includes('imlo') || nom.includes('spelling')) {
    const ratio  = stats.lexicalRatio;
    const avgLen = stats.charCount / Math.max(stats.wordCount, 1);
    let ball = ratio >= 0.70 && avgLen >= 4 ? maxBall
             : ratio >= 0.55 ? maxBall * 0.8
             : ratio >= 0.40 ? maxBall * 0.6
             : ratio >= 0.25 ? maxBall * 0.4
             : maxBall * 0.2;
    return { ball, hint: `Leksik xilma-xillik ${(ratio * 100).toFixed(0)}% (yaxshi: ≥70%)` };
  }

  // ── Grammatika ──
  if (nom.includes('grammatik') || nom.includes('grammar')) {
    const avg = stats.avgWordsPerSentence;
    let ball = avg >= 6 && avg <= 20 && stats.sentenceCount >= 5 ? maxBall
             : avg >= 4 && avg <= 25 && stats.sentenceCount >= 3 ? maxBall * 0.8
             : stats.sentenceCount >= 2 ? maxBall * 0.5
             : maxBall * 0.2;
    return { ball, hint: `Gaplar: ${stats.sentenceCount} ta, o'rtacha ${avg} so'z` };
  }

  // ── Punktuatsiya / tinish ──
  if (nom.includes('punktuatsiya') || nom.includes('tinish')) {
    const p     = stats.allPunct;
    const ratio = stats.wordCount > 0 ? p / stats.wordCount : 0;
    let ball = p >= 15 && ratio >= 0.05 ? maxBall
             : p >= 8  ? maxBall * 0.8
             : p >= 4  ? maxBall * 0.6
             : p >= 1  ? maxBall * 0.3
             : 0;
    return { ball, hint: `${p} ta tinish belgisi` };
  }

  // ── Abzat / tuzilish / matn / paragraph ──
  if (
    nom.includes('abzat')    || nom.includes('tuzilish') ||
    nom.includes('matn')     || nom.includes('paragraph')
  ) {
    const p = stats.paragraphCount;
    let ball = p >= 4 && stats.hasTitle ? maxBall
             : p >= 3                   ? maxBall * 0.8
             : p >= 2                   ? maxBall * 0.6
             : p >= 1                   ? maxBall * 0.3
             : 0;
    return { ball, hint: `${p} ta abzat, sarlavha: ${stats.hasTitle ? 'bor' : "yo'q"}` };
  }

  // ── Jadval ──
  if (nom.includes('jadval') || nom.includes('table')) {
    const t = fmt.tableCount || stats.tableCount;
    let ball = t >= 2 ? maxBall : t === 1 ? maxBall * 0.7 : 0;
    return { ball, hint: t === 0 ? 'Jadval topilmadi' : `${t} ta jadval` };
  }

  // ── Shrift / font ──
  if (nom.includes('shrift') || nom.includes('font')) {
    const acceptable = ['Times New Roman', 'Arial', 'Calibri', 'Georgia', 'Tahoma', 'Verdana'];
    const foundFonts = fmt.fonts ?? [];
    const hasAcceptable = foundFonts.some(f =>
      acceptable.some(a => f.toLowerCase().includes(a.toLowerCase()))
    );
    const isUniform = fmt.hasUniformFont || foundFonts.length <= 2;
    let ball = hasAcceptable && isUniform ? maxBall
             : hasAcceptable || isUniform ? maxBall * 0.7
             : foundFonts.length > 0     ? maxBall * 0.4
             : maxBall * 0.2;
    const fontList = foundFonts.length > 0 ? foundFonts.join(', ') : 'aniqlanmadi';
    return { ball, hint: `Ishlatilgan shrift: ${fontList}. ${isUniform ? 'Bir xil' : 'Har xil'} shrift.` };
  }

  // ── Shrift o'lchami / size / kegel ──
  if (nom.includes("o'lcham") || nom.includes('size') || nom.includes('kegel')) {
    const sizes         = fmt.sizes ?? [];
    const hasStandardSize = sizes.some(s => s >= 11 && s <= 14);
    const isUniform     = fmt.hasUniformSize;
    let ball = hasStandardSize && isUniform ? maxBall
             : hasStandardSize             ? maxBall * 0.7
             : sizes.length > 0            ? maxBall * 0.4
             : maxBall * 0.2;
    const sizeList = sizes.length > 0 ? sizes.join(', ') + ' pt' : 'aniqlanmadi';
    return { ball, hint: `Shrift o'lchamlari: ${sizeList}. Standart: 12pt.` };
  }

  // ── Tekislash / align ──
  if (nom.includes('tekislash') || nom.includes('align') || nom.includes('joylash')) {
    const hasJustify = fmt.hasJustifyAlign;
    const hasCenter  = fmt.hasCenterAlign;
    let ball = hasJustify                ? maxBall
             : hasCenter                 ? maxBall * 0.6
             : fmt.alignments.length > 0 ? maxBall * 0.4
             : maxBall * 0.2;
    return {
      ball,
      hint: `Tekislash: ${fmt.alignments.join(', ') || 'aniqlanmadi'}. Asosiy matn uchun "Kengligi bo\'yicha" tavsiya etiladi.`,
    };
  }

  // ── Format / ko'rinish / rasmiy ──
  if (nom.includes('format') || nom.includes("ko'rinish") || nom.includes('rasmiy')) {
    const hasFont    = (fmt.fonts ?? []).length > 0;
    const hasSize    = (fmt.sizes ?? []).some(s => s >= 11 && s <= 16);
    const hasAlign   = fmt.hasJustifyAlign || fmt.hasCenterAlign;
    const goodLength = stats.wordCount >= 100;
    let score = 0;
    if (hasFont  && goodLength) score += 0.25;
    if (hasSize)                score += 0.25;
    if (hasAlign)               score += 0.25;
    if (fmt.hasUniformFont)     score += 0.25;
    let ball = parseFloat((score * maxBall).toFixed(2));
    return {
      ball,
      hint: [
        !hasFont         && 'Shrift aniqlanmadi',
        !hasSize         && "O'lcham standart emas",
        !hasAlign        && 'Tekislash aniqlanmadi',
        !fmt.hasUniformFont && 'Har xil shrift ishlatilgan',
      ].filter(Boolean).join('. ') || null,
    };
  }

  // ── Default fallback ──
  const ball = stats.wordCount >= 100 ? maxBall * 0.8
             : stats.wordCount >= 50  ? maxBall * 0.5
             : maxBall * 0.2;
  return { ball, hint: `So'zlar: ${stats.wordCount}` };
}

module.exports = { uploadDoc, getDocsStatus, downloadStudentDoc };