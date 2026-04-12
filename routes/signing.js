const express = require('express');
const fs = require('fs');
const router = express.Router();
const db = require('../database/init');
const { generateSignedContractPdf, resolveStoredFilePath } = require('../utils/pdf-signature');

const stmts = {
  getByToken: db.prepare('SELECT * FROM contracts WHERE signing_token = ?'),
  sign: db.prepare(`
    UPDATE contracts SET signature_data = ?, status = 'signed',
      signed_pdf_path = ?,
      signed_pdf_generated_at = datetime('now', 'localtime'),
      signed_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime')
    WHERE id = ? AND status = 'pending'
  `),
};

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
    return res.render('signing/sign', {
      contract,
      error: `No se pudo firmar el PDF: ${err.message}`
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
