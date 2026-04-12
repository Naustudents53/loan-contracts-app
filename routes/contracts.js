const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const db = require('../database/init');

const PROJECT_ROOT = path.join(__dirname, '..');
const UPLOADS_ROOT = path.join(PROJECT_ROOT, 'uploads');
const CONTRACT_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'contracts');
const MAX_CONTRACT_PDF_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONFIANZA = new Set(['Alta', 'Media', 'Baja']);
const PDF_MIME_TYPES = new Set([
  'application/pdf',
  'application/x-pdf',
  'application/octet-stream',
]);

fs.mkdirSync(CONTRACT_UPLOAD_DIR, { recursive: true });

const uploadContractPdf = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, CONTRACT_UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: MAX_CONTRACT_PDF_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const hasAllowedMime = PDF_MIME_TYPES.has(file.mimetype);

    if (extension !== '.pdf' || !hasAllowedMime) {
      cb(new Error('Solo se permiten archivos PDF validos.'));
      return;
    }

    cb(null, true);
  },
});

function runUploadMiddleware(req, res, middleware) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function buildContractPdfWebPath(fileName) {
  return `/uploads/contracts/${fileName}`;
}

function resolveStoredFilePath(storedPath, expectedPrefix) {
  if (!storedPath || typeof storedPath !== 'string') return null;

  const normalized = path.posix.normalize(storedPath);
  if (!normalized.startsWith(expectedPrefix)) return null;

  const absolute = path.join(PROJECT_ROOT, normalized.replace(/^\//, ''));
  if (!absolute.startsWith(UPLOADS_ROOT)) return null;

  return absolute;
}

function cleanupStoredFile(storedPath, expectedPrefix) {
  const absolutePath = resolveStoredFilePath(storedPath, expectedPrefix);
  if (!absolutePath || !fs.existsSync(absolutePath)) return;

  try {
    fs.unlinkSync(absolutePath);
  } catch (_err) {
    // Ignore cleanup failures to avoid blocking user flow.
  }
}

function hasValidPdfHeader(absolutePath) {
  try {
    const fd = fs.openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(5);
    fs.readSync(fd, buffer, 0, 5, 0);
    fs.closeSync(fd);
    return buffer.toString('utf8') === '%PDF-';
  } catch (_err) {
    return false;
  }
}

function parseUploadError(err) {
  if (!err) return null;

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return 'El PDF supera el tamano maximo de 10MB.';
    }
    return 'No se pudo procesar el archivo PDF.';
  }

  return 'No se pudo cargar el contrato en PDF. Verifique el archivo e intente nuevamente.';
}

function sanitizeDownloadName(fileName, fallback) {
  if (!fileName || typeof fileName !== 'string') return fallback;
  const normalized = fileName.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || fallback;
}

function validateContractInput(raw) {
  const clientName = raw.client_name ? String(raw.client_name).trim() : '';
  const clientCedula = raw.client_cedula ? String(raw.client_cedula).trim() : '';
  const clientPhone = raw.client_phone ? String(raw.client_phone).trim() : null;
  const clientAddress = raw.client_address ? String(raw.client_address).trim() : null;
  const confianza = raw.confianza ? String(raw.confianza).trim() : '';
  const notes = raw.notes ? String(raw.notes).trim() : null;

  const prestamo = Number.parseFloat(raw.prestamo);
  const cuota = Number.parseFloat(raw.cuota);
  const precio = Number.parseFloat(raw.precio);
  const deudaTotal = Number.parseFloat(raw.deuda_total);

  if (!clientName || !clientCedula) {
    return { error: 'Nombre y cedula son obligatorios.' };
  }

  if (!ALLOWED_CONFIANZA.has(confianza)) {
    return { error: 'Seleccione un nivel de confianza valido.' };
  }

  if (!Number.isFinite(prestamo) || prestamo <= 0) {
    return { error: 'El monto del prestamo debe ser un numero mayor que 0.' };
  }

  if (!Number.isFinite(cuota) || cuota <= 0) {
    return { error: 'La cuota debe ser un numero mayor que 0.' };
  }

  if (!Number.isFinite(precio) || precio < 0) {
    return { error: 'El precio/interes debe ser un numero valido.' };
  }

  if (!Number.isFinite(deudaTotal) || deudaTotal <= 0) {
    return { error: 'La deuda total debe ser un numero mayor que 0.' };
  }

  return {
    values: {
      clientName,
      clientCedula,
      clientPhone,
      clientAddress,
      prestamo,
      cuota,
      precio,
      deudaTotal,
      confianza,
      notes,
    },
  };
}

// Prepared statements
const stmts = {
  getAll: db.prepare('SELECT * FROM contracts ORDER BY created_at DESC'),
  search: db.prepare(`SELECT * FROM contracts WHERE client_name LIKE ? ORDER BY created_at DESC`),
  searchStatus: db.prepare(`SELECT * FROM contracts WHERE client_name LIKE ? AND status = ? ORDER BY created_at DESC`),
  filterStatus: db.prepare(`SELECT * FROM contracts WHERE status = ? ORDER BY created_at DESC`),
  getById: db.prepare('SELECT * FROM contracts WHERE id = ?'),
  countByCedula: db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status = \'signed\' THEN 1 ELSE 0 END) as firmados, SUM(cuotas_realizadas) as pagos_totales FROM contracts WHERE client_cedula = ?'),
  create: db.prepare(`
    INSERT INTO contracts (client_name, client_cedula, client_phone, client_address,
      prestamo, cuota, precio, deuda_total, confianza, signing_token, notes,
      contract_pdf_path, contract_pdf_original_name, contract_pdf_uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
  `),
  update: db.prepare(`
    UPDATE contracts SET client_name = ?, client_cedula = ?, client_phone = ?,
      client_address = ?, prestamo = ?, cuota = ?, precio = ?, deuda_total = ?,
      confianza = ?, notes = ?,
      contract_pdf_path = COALESCE(?, contract_pdf_path),
      contract_pdf_original_name = COALESCE(?, contract_pdf_original_name),
      contract_pdf_uploaded_at = CASE WHEN ? IS NOT NULL THEN datetime('now', 'localtime') ELSE contract_pdf_uploaded_at END,
      signed_pdf_path = CASE WHEN ? IS NOT NULL THEN NULL ELSE signed_pdf_path END,
      signed_pdf_generated_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE signed_pdf_generated_at END,
      updated_at = datetime('now', 'localtime')
    WHERE id = ? AND status = 'pending'
  `),
  payCuota: db.prepare(`
    UPDATE contracts SET cuotas_realizadas = cuotas_realizadas + 1,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `),
  delete: db.prepare('DELETE FROM contracts WHERE id = ?'),
};

// Compute extra fields for a contract
function enrichContract(contract) {
  if (!contract) return null;
  const cuotas_totales = contract.cuota > 0 ? Math.ceil(contract.deuda_total / contract.cuota) : 0;
  const cuotas_restantes = Math.max(0, cuotas_totales - contract.cuotas_realizadas);
  const progreso = cuotas_totales > 0 ? Math.round((contract.cuotas_realizadas / cuotas_totales) * 100) : 0;
  const saldo_pendiente = Math.max(0, contract.deuda_total - (contract.cuotas_realizadas * contract.cuota));
  return { ...contract, cuotas_totales, cuotas_restantes, progreso, saldo_pendiente };
}

// Calculate nivel_prestamo based on client history
function getNivelPrestamo(cedula) {
  const stats = stmts.countByCedula.get(cedula);
  const total = stats.total || 0;
  const firmados = stats.firmados || 0;
  const pagos = stats.pagos_totales || 0;

  if (total === 0) return { nivel: 'Nuevo', color: 'muted', icon: 'star', desc: 'Primer prestamo' };
  if (total === 1 && pagos === 0) return { nivel: 'Nuevo', color: 'muted', icon: 'star', desc: 'Sin historial de pagos' };
  if (pagos >= 20 && firmados >= 3) return { nivel: 'VIP', color: 'accent', icon: 'gem', desc: `${total} contratos, ${pagos} pagos realizados` };
  if (pagos >= 10 || firmados >= 2) return { nivel: 'Frecuente', color: 'success', icon: 'award', desc: `${total} contratos, ${pagos} pagos realizados` };
  if (pagos >= 3) return { nivel: 'Regular', color: 'warning', icon: 'person-check', desc: `${total} contratos, ${pagos} pagos realizados` };
  return { nivel: 'Inicial', color: 'muted', icon: 'person', desc: `${total} contratos, ${pagos} pagos realizados` };
}

// LIST
router.get('/', (req, res) => {
  const { search, status } = req.query;
  let contracts;

  if (search && status) {
    contracts = stmts.searchStatus.all(`%${search}%`, status);
  } else if (search) {
    contracts = stmts.search.all(`%${search}%`);
  } else if (status) {
    contracts = stmts.filterStatus.all(status);
  } else {
    contracts = stmts.getAll.all();
  }

  contracts = contracts.map(enrichContract);
  res.render('contracts/index', { contracts, search, filterStatus: status });
});

// NEW FORM
router.get('/new', (req, res) => {
  res.render('contracts/new', { title: 'Nuevo Contrato' });
});

// CREATE
router.post('/', async (req, res) => {
  try {
    await runUploadMiddleware(req, res, uploadContractPdf.single('loan_contract_pdf'));
  } catch (uploadErr) {
    return res.render('contracts/new', {
      title: 'Nuevo Contrato',
      error: parseUploadError(uploadErr),
      formData: req.body,
    });
  }

  const validation = validateContractInput(req.body);

  const uploadedContractPdfPath = req.file ? buildContractPdfWebPath(req.file.filename) : null;
  const uploadedAbsolutePath = uploadedContractPdfPath
    ? resolveStoredFilePath(uploadedContractPdfPath, '/uploads/contracts/')
    : null;

  if (!uploadedContractPdfPath || !uploadedAbsolutePath) {
    return res.render('contracts/new', {
      title: 'Nuevo Contrato',
      error: 'Debe subir el contrato del prestamo en formato PDF.',
      formData: req.body,
    });
  }

  if (!hasValidPdfHeader(uploadedAbsolutePath)) {
    cleanupStoredFile(uploadedContractPdfPath, '/uploads/contracts/');
    return res.render('contracts/new', {
      title: 'Nuevo Contrato',
      error: 'El archivo cargado no es un PDF valido.',
      formData: req.body,
    });
  }

  if (validation.error) {
    cleanupStoredFile(uploadedContractPdfPath, '/uploads/contracts/');
    return res.render('contracts/new', {
      title: 'Nuevo Contrato',
      error: validation.error,
      formData: req.body
    });
  }

  const {
    clientName,
    clientCedula,
    clientPhone,
    clientAddress,
    prestamo,
    cuota,
    precio,
    deudaTotal,
    confianza,
    notes,
  } = validation.values;

  const signing_token = crypto.randomUUID();
  const originalPdfName = req.file.originalname ? req.file.originalname.trim() : 'contrato.pdf';

  try {
    const result = stmts.create.run(
      clientName, clientCedula, clientPhone,
      clientAddress, prestamo, cuota,
      precio, deudaTotal, confianza, signing_token,
      notes, uploadedContractPdfPath, originalPdfName
    );
    res.redirect(`/contracts/${result.lastInsertRowid}`);
  } catch (err) {
    cleanupStoredFile(uploadedContractPdfPath, '/uploads/contracts/');
    res.render('contracts/new', {
      title: 'Nuevo Contrato',
      error: 'No se pudo crear el contrato. Intente de nuevo.',
      formData: req.body
    });
  }
});

// SHOW
router.get('/:id/pdf/base', (req, res) => {
  const contract = stmts.getById.get(req.params.id);
  if (!contract || !contract.contract_pdf_path) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'No hay PDF base disponible para este contrato.' });
  }

  if (!req.query.token || req.query.token !== contract.signing_token) {
    return res.status(403).render('error', { title: 'Acceso denegado', message: 'No tiene permisos para abrir este PDF.' });
  }

  const absolutePath = resolveStoredFilePath(contract.contract_pdf_path, '/uploads/contracts/');
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'El PDF base no existe en el servidor.' });
  }

  const downloadName = sanitizeDownloadName(contract.contract_pdf_original_name, `contrato-${contract.id}.pdf`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
  return res.sendFile(absolutePath);
});

router.get('/:id/pdf/signed', (req, res) => {
  const contract = stmts.getById.get(req.params.id);
  if (!contract || !contract.signed_pdf_path) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'No hay PDF firmado disponible para este contrato.' });
  }

  if (!req.query.token || req.query.token !== contract.signing_token) {
    return res.status(403).render('error', { title: 'Acceso denegado', message: 'No tiene permisos para abrir este PDF.' });
  }

  const absolutePath = resolveStoredFilePath(contract.signed_pdf_path, '/uploads/signed/');
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'El PDF firmado no existe en el servidor.' });
  }

  const downloadName = sanitizeDownloadName(`contrato-${contract.id}-firmado.pdf`, `contrato-${contract.id}-firmado.pdf`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
  return res.sendFile(absolutePath);
});

router.get('/:id', (req, res) => {
  const raw = stmts.getById.get(req.params.id);
  if (!raw) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Contrato no encontrado.' });
  }
  const contract = enrichContract(raw);
  const nivelPrestamo = getNivelPrestamo(contract.client_cedula);
  res.render('contracts/show', { title: `Contrato #${contract.id}`, contract, nivelPrestamo, success: req.query.success });
});

// PAY CUOTA
router.post('/:id/pay', (req, res) => {
  const contract = stmts.getById.get(req.params.id);
  if (!contract) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Contrato no encontrado.' });
  }
  const enriched = enrichContract(contract);
  if (enriched.cuotas_restantes <= 0) {
    return res.redirect(`/contracts/${contract.id}`);
  }
  stmts.payCuota.run(req.params.id);
  res.redirect(`/contracts/${req.params.id}`);
});

// EDIT FORM
router.get('/:id/edit', (req, res) => {
  const contract = stmts.getById.get(req.params.id);
  if (!contract) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Contrato no encontrado.' });
  }
  if (contract.status === 'signed') {
    return res.redirect(`/contracts/${contract.id}`);
  }
  res.render('contracts/edit', { title: `Editar Contrato #${contract.id}`, contract });
});

// UPDATE
router.put('/:id', async (req, res) => {
  const contract = stmts.getById.get(req.params.id);
  if (!contract) {
    return res.status(404).render('error', { title: 'No encontrado', message: 'Contrato no encontrado.' });
  }
  if (contract.status === 'signed') {
    return res.redirect(`/contracts/${contract.id}`);
  }

  try {
    await runUploadMiddleware(req, res, uploadContractPdf.single('loan_contract_pdf'));
  } catch (uploadErr) {
    return res.render('contracts/edit', {
      title: `Editar Contrato #${contract.id}`,
      contract: { ...contract, ...req.body },
      error: parseUploadError(uploadErr),
    });
  }

  const validation = validateContractInput(req.body);

  const replacementPdfPath = req.file ? buildContractPdfWebPath(req.file.filename) : null;
  const replacementAbsolutePath = replacementPdfPath
    ? resolveStoredFilePath(replacementPdfPath, '/uploads/contracts/')
    : null;

  if (replacementPdfPath && (!replacementAbsolutePath || !hasValidPdfHeader(replacementAbsolutePath))) {
    cleanupStoredFile(replacementPdfPath, '/uploads/contracts/');
    return res.render('contracts/edit', {
      title: `Editar Contrato #${contract.id}`,
      contract: { ...contract, ...req.body },
      error: 'El archivo cargado no es un PDF valido.',
    });
  }

  if (validation.error) {
    if (replacementPdfPath) {
      cleanupStoredFile(replacementPdfPath, '/uploads/contracts/');
    }

    return res.render('contracts/edit', {
      title: `Editar Contrato #${contract.id}`,
      contract: { ...contract, ...req.body },
      error: validation.error,
    });
  }

  const {
    clientName,
    clientCedula,
    clientPhone,
    clientAddress,
    prestamo,
    cuota,
    precio,
    deudaTotal,
    confianza,
    notes,
  } = validation.values;

  const replacementOriginalName = replacementPdfPath
    ? (req.file.originalname ? req.file.originalname.trim() : 'contrato.pdf')
    : null;

  try {
    const updateResult = stmts.update.run(
      clientName, clientCedula, clientPhone,
      clientAddress, prestamo, cuota,
      precio, deudaTotal, confianza,
      notes,
      replacementPdfPath,
      replacementOriginalName,
      replacementPdfPath,
      replacementPdfPath,
      replacementPdfPath,
      req.params.id
    );

    if (!updateResult.changes) {
      if (replacementPdfPath) {
        cleanupStoredFile(replacementPdfPath, '/uploads/contracts/');
      }

      const latest = stmts.getById.get(req.params.id);
      if (latest && latest.status === 'signed') {
        return res.redirect(`/contracts/${req.params.id}`);
      }

      return res.render('contracts/edit', {
        title: `Editar Contrato #${contract.id}`,
        contract: { ...contract, ...req.body },
        error: 'No se pudo actualizar el contrato. Intente de nuevo.',
      });
    }

    if (replacementPdfPath) {
      cleanupStoredFile(contract.contract_pdf_path, '/uploads/contracts/');
      cleanupStoredFile(contract.signed_pdf_path, '/uploads/signed/');
    }

    res.redirect(`/contracts/${req.params.id}`);
  } catch (err) {
    if (replacementPdfPath) {
      cleanupStoredFile(replacementPdfPath, '/uploads/contracts/');
    }

    res.render('contracts/edit', {
      title: `Editar Contrato #${contract.id}`,
      contract: { ...contract, ...req.body },
      error: 'No se pudo actualizar el contrato. Intente de nuevo.'
    });
  }
});

// DELETE
router.delete('/:id', (req, res) => {
  const contract = stmts.getById.get(req.params.id);

  if (contract) {
    cleanupStoredFile(contract.contract_pdf_path, '/uploads/contracts/');
    cleanupStoredFile(contract.signed_pdf_path, '/uploads/signed/');
  }

  stmts.delete.run(req.params.id);
  res.redirect('/contracts');
});

module.exports = router;
