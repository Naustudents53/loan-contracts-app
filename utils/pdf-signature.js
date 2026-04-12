const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const PROJECT_ROOT = path.join(__dirname, '..');
const UPLOADS_ROOT = path.join(PROJECT_ROOT, 'uploads');
const SIGNED_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'signed');

function normalizeRatio(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback;
  }
  return parsed;
}

const SIGNATURE_MAP = Object.freeze({
  page: process.env.PDF_SIGNATURE_PAGE || 'last',
  // Defaults tuned for the signature line above "Cliente." in the base template.
  xRatio: normalizeRatio(process.env.PDF_SIGNATURE_X_RATIO, 0.21),
  yRatio: normalizeRatio(process.env.PDF_SIGNATURE_Y_RATIO, 0.39),
  widthRatio: normalizeRatio(process.env.PDF_SIGNATURE_WIDTH_RATIO, 0.24),
  maxHeightRatio: normalizeRatio(process.env.PDF_SIGNATURE_MAX_HEIGHT_RATIO, 0.07),
  padding: 10,
});

fs.mkdirSync(SIGNED_UPLOAD_DIR, { recursive: true });

function resolveStoredFilePath(storedPath, expectedPrefix) {
  if (!storedPath || typeof storedPath !== 'string') return null;

  const normalized = path.posix.normalize(storedPath);
  if (!normalized.startsWith(expectedPrefix)) return null;

  const absolute = path.join(PROJECT_ROOT, normalized.replace(/^\//, ''));
  if (!absolute.startsWith(UPLOADS_ROOT)) return null;

  return absolute;
}

function parseSignatureDataUrl(signatureDataUrl) {
  const match = /^data:image\/(png|jpeg|jpg);base64,(.+)$/i.exec(signatureDataUrl || '');
  if (!match) return null;

  return {
    format: match[1].toLowerCase(),
    imageBytes: Buffer.from(match[2], 'base64'),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function resolveTargetPageIndex(pageCount) {
  if (pageCount <= 1) return 0;

  if (SIGNATURE_MAP.page === 'first') return 0;
  if (SIGNATURE_MAP.page === 'last') return pageCount - 1;

  const configuredPage = Number(SIGNATURE_MAP.page);
  if (Number.isFinite(configuredPage) && configuredPage >= 1 && configuredPage <= pageCount) {
    return Math.floor(configuredPage) - 1;
  }

  return pageCount - 1;
}

async function generateSignedContractPdf({ basePdfPath, signatureDataUrl, contractId }) {
  const basePdfAbsolutePath = resolveStoredFilePath(basePdfPath, '/uploads/contracts/');

  if (!basePdfAbsolutePath || !fs.existsSync(basePdfAbsolutePath)) {
    throw new Error('No se encontro el PDF base del contrato.');
  }

  const parsedSignature = parseSignatureDataUrl(signatureDataUrl);
  if (!parsedSignature) {
    throw new Error('La firma enviada no tiene un formato valido.');
  }

  const basePdfBytes = fs.readFileSync(basePdfAbsolutePath);
  const pdfDoc = await PDFDocument.load(basePdfBytes);
  const pages = pdfDoc.getPages();

  if (!pages.length) {
    throw new Error('El PDF base no contiene paginas.');
  }

  const pageIndex = resolveTargetPageIndex(pages.length);
  const page = pages[pageIndex];

  const signatureImage = (parsedSignature.format === 'png')
    ? await pdfDoc.embedPng(parsedSignature.imageBytes)
    : await pdfDoc.embedJpg(parsedSignature.imageBytes);

  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const imageAspect = signatureImage.height / signatureImage.width;

  let drawWidth = pageWidth * SIGNATURE_MAP.widthRatio;
  let drawHeight = drawWidth * imageAspect;

  const maxHeight = pageHeight * SIGNATURE_MAP.maxHeightRatio;
  if (drawHeight > maxHeight) {
    drawHeight = maxHeight;
    drawWidth = drawHeight / imageAspect;
  }

  const maxX = pageWidth - drawWidth - SIGNATURE_MAP.padding;
  const maxY = pageHeight - drawHeight - SIGNATURE_MAP.padding;
  const x = clamp(pageWidth * SIGNATURE_MAP.xRatio, SIGNATURE_MAP.padding, maxX);
  const y = clamp(pageHeight * SIGNATURE_MAP.yRatio, SIGNATURE_MAP.padding, maxY);

  page.drawImage(signatureImage, {
    x,
    y,
    width: drawWidth,
    height: drawHeight,
  });

  const signedFileName = `contract-${contractId}-${Date.now()}-signed.pdf`;
  const signedWebPath = `/uploads/signed/${signedFileName}`;
  const signedAbsolutePath = path.join(SIGNED_UPLOAD_DIR, signedFileName);

  const signedPdfBytes = await pdfDoc.save();
  fs.writeFileSync(signedAbsolutePath, signedPdfBytes);

  return signedWebPath;
}

module.exports = {
  generateSignedContractPdf,
  resolveStoredFilePath,
};
