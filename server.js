require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const methodOverride = require('method-override');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const uploadsRoot = path.join(__dirname, 'uploads');
const uploadsContracts = path.join(uploadsRoot, 'contracts');
const uploadsSigned = path.join(uploadsRoot, 'signed');

fs.mkdirSync(uploadsContracts, { recursive: true });
fs.mkdirSync(uploadsSigned, { recursive: true });

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Make BASE_URL available to all views
app.use((req, res, next) => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = (forwardedProto ? String(forwardedProto).split(',')[0] : req.protocol) || 'http';
  const host = req.get('host');
  res.locals.baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
  next();
});

// Routes
const contractsRouter = require('./routes/contracts');
const signingRouter = require('./routes/signing');

app.get('/', (req, res) => res.redirect('/contracts'));
app.use('/contracts', contractsRouter);
app.use('/sign', signingRouter);

// 404
app.use((req, res) => {
  res.status(404).render('error', { title: 'No encontrado', message: 'La pagina que buscas no existe.' });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
