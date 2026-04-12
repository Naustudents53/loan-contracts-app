const express = require('express');
const fs = require('fs');
const router = express.Router();
const db = require('../database/init');
const { generateSignedContractPdf, resolveStoredFilePath } = require('../utils/pdf-signature');

const stmts = {
  getByToken: db.prepare('SELECT * FROM contracts WHERE signing_token = ?'),
  refreshSignedPdf: db.prepare(`
    UPDATE contracts SET signed_pdf_path = ?,
      signed_pdf_generated_at = datetime('now', 'localtime'),
      updated_at = datetime('now', 'localtime')
    WHERE id = ? AND status = 'signed'
  `),
  sign: db.prepare(`
    UPDATE contracts SET signature_data = ?, status = 'signed',
      signed_pdf_path = ?,
      signed_pdf_generated_at = datetime('now', 'localtime'),
      signed_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime')
    WHERE id = ? AND status = 'pending'
  `),
};

function cleanupStoredSignedPdf(storedPath) {
  const absolute = resolveStoredFilePath(storedPath, '/uploads/signed/');
  if (!absolute || !fs.existsSync(absolute)) return;

  try {
    fs.unlinkSync(absolute);
  } catch (_err) {
    // Ignore cleanup errors.
  }
}

async function remapSignedPdf(contract) {
  const oldSignedPdfPath = contract.signed_pdf_path;
  const newSignedPdfPath = await generateSignedContractPdf({
    basePdfPath: contract.contract_pdf_path,
    signatureDataUrl: contract.signature_data,
    contractId: contract.id,
  });

  const updateResult = stmts.refreshSignedPdf.run(newSignedPdfPath, contract.id);
  if (!updateResult.changes) {
    cleanupStoredSignedPdf(newSignedPdfPath);
    return oldSignedPdfPath;
  }

  if (oldSignedPdfPath && oldSignedPdfPath !== newSignedPdfPath) {
    cleanupStoredSignedPdf(oldSignedPdfPath);
  }

  return newSignedPdfPath;
}

function sendPdfOr404(res, filePath, message) {
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).render('signing/expired', { message });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  return res.sendFile(filePath);
}

// SIGN PAGE
router.get('/:token', (req, res) => {
  const contract = stmts.getByToken.get(req.params.token);

  if (!contract) {
    return res.status(404).render('signing/expired', { message: 'Este link de firma no es valido.' });
  }

  if (contract.status === 'signed') {
    return res.render('signing/expired', { message: 'Este contrato ya ha sido firmado.' });
  }

  res.render('signing/sign', { contract });
});

router.get('/:token/pdf/base', (req, res) => {
  const contract = stmts.getByToken.get(req.params.token);

  if (!contract) {
    return res.status(404).render('signing/expired', { message: 'Este link de firma no es valido.' });
  }

  const basePdfAbsolutePath = resolveStoredFilePath(contract.contract_pdf_path, '/uploads/contracts/');
  return sendPdfOr404(res, basePdfAbsolutePath, 'No se encontro el contrato base en PDF.');
});

router.get('/:token/pdf', async (req, res) => {
  const contract = stmts.getByToken.get(req.params.token);

  if (!contract) {
    return res.status(404).render('signing/expired', { message: 'Este link de firma no es valido.' });
  }

  let signedPdfPath = contract.signed_pdf_path;
  const canRemap = contract.status === 'signed' && contract.signature_data && contract.contract_pdf_path;

  if (canRemap) {
    try {
      signedPdfPath = await remapSignedPdf(contract);
    } catch (err) {
      console.error('No se pudo remapear el PDF firmado:', err);
    }
  }

  const signedPdfAbsolutePath = resolveStoredFilePath(signedPdfPath, '/uploads/signed/');
  return sendPdfOr404(res, signedPdfAbsolutePath, 'El contrato firmado aun no esta disponible.');
});

// SUBMIT SIGNATURE
router.post('/:token', async (req, res) => {
  const contract = stmts.getByToken.get(req.params.token);

  if (!contract) {
    return res.status(404).render('signing/expired', { message: 'Este link de firma no es valido.' });
  }

  if (contract.status === 'signed') {
    return res.render('signing/expired', { message: 'Este contrato ya ha sido firmado.' });
  }

  const { signature_data } = req.body;

  if (!signature_data || !signature_data.startsWith('data:image/')) {
    return res.render('signing/sign', {
      contract,
      error: 'Por favor dibuje su firma antes de enviar.'
    });
  }

  const basePdfAbsolutePath = resolveStoredFilePath(contract.contract_pdf_path, '/uploads/contracts/');
  if (!basePdfAbsolutePath || !fs.existsSync(basePdfAbsolutePath)) {
    return res.render('signing/sign', {
      contract,
      error: 'Este prestamo no tiene un contrato PDF cargado para firmar.'
    });
  }

  let signedPdfPath;
  try {
    signedPdfPath = await generateSignedContractPdf({
      basePdfPath: contract.contract_pdf_path,
      signatureDataUrl: signature_data,
      contractId: contract.id,
    });
  } catch (err) {
    console.error('Error firmando PDF de contrato:', err);
    return res.render('signing/sign', {
      contract,
      error: 'No se pudo completar la firma del PDF. Intente de nuevo.'
    });
  }

  const result = stmts.sign.run(signature_data, signedPdfPath, contract.id);
  if (!result.changes) {
    const signedPdfAbsolutePath = resolveStoredFilePath(signedPdfPath, '/uploads/signed/');
    if (signedPdfAbsolutePath && fs.existsSync(signedPdfAbsolutePath)) {
      try {
        fs.unlinkSync(signedPdfAbsolutePath);
      } catch (_err) {
        // Ignore cleanup errors when race conditions happen.
      }
    }

    return res.render('signing/expired', { message: 'Este contrato ya ha sido firmado.' });
  }

  const updated = stmts.getByToken.get(req.params.token);
  res.render('signing/success', { contract: updated });
});

module.exports = router;
