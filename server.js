const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const path = require('path');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────
// URLs base da API oficial do CNJ/BNMP
// ──────────────────────────────────────────
const BNMP_BASE_URL  = 'https://portalbnmp.cnj.jus.br/scaservice/api';
const BNMP_PESQ_URL  = 'https://portalbnmp.cnj.jus.br/bnmpportal/api';

// ──────────────────────────────────────────
// Middlewares globais
// ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve o painel HTML estático
app.use(express.static(path.join(__dirname)));

// Prefixo /api para compatibilidade com o painel
const router = express.Router();
app.use('/api', router);

const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// ──────────────────────────────────────────
// Helper: fetch autenticado via auth.js (Playwright)
// ──────────────────────────────────────────
async function cnjFetch(url, opts = {}) {
  const headers = await auth.getHeaders();
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) }
  });
  // Se 401/403, tenta renovar o token uma vez
  if (res.status === 401 || res.status === 403) {
    console.log('[server] Token expirado, renovando...');
    await auth.login();
    const headers2 = await auth.getHeaders();
    return fetch(url, { ...opts, headers: { ...headers2, ...(opts.headers || {}) } });
  }
  return res;
}

// ──────────────────────────────────────────
// ROTAS
// ──────────────────────────────────────────

// --- Health check ---
router.get('/health', (req, res) => {
  const s = auth.getSession();
  res.json({ ok: true, tokenAtivo: auth.isValid(), credenciaisConfiguradas: !!(s.credentials.username), ts: new Date().toISOString() });
});

// --- Salvar credenciais ---
router.post('/config/credentials', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username e password são obrigatórios.' });
  auth.setCredentials(username, password);
  res.json({ ok: true, message: 'Credenciais salvas. Login será feito automaticamente na próxima busca.' });
});

// --- Status das credenciais ---
router.get('/config/credentials', (req, res) => {
  const s = auth.getSession();
  res.json({
    configured: !!(s.credentials.username && s.credentials.password),
    username: s.credentials.username || null,
    tokenAtivo: auth.isValid()
  });
});

// --- Login manual via navegador headless ---
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    res.json({ ok: true, message: 'Login iniciado via navegador headless. Isso pode levar até 30 segundos...' });
    // Login em background para não travar o response
    auth.login(username, password).then(() => {
      console.log('[login] Login concluído com sucesso!');
    }).catch(e => {
      console.error('[login] Erro:', e.message);
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// --- Login síncrono (aguarda completar) ---
router.post('/login/sync', async (req, res) => {
  try {
    const { username, password } = req.body;
    await auth.login(username, password);
    res.json({ ok: true, message: 'Autenticado com sucesso no BNMP/CNJ via navegador real.' });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// --- Logout ---
router.post('/logout', (req, res) => {
  auth.setCredentials(null, null);
  res.json({ ok: true });
});

// --- Pesquisa por CPF ---
router.get('/pesquisa/cpf/:cpf', async (req, res) => {
  try {
    const { cpf } = req.params;
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) return res.status(400).json({ error: 'CPF inválido.' });

    const r = await cnjFetch(`${BNMP_PESQ_URL}/pesquisa/pessoas/cpf/${encodeURIComponent(cpfLimpo)}`);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Pesquisa por nome ---
router.get('/pesquisa/nome', async (req, res) => {
  try {
    const { nome, page = 0, size = 10 } = req.query;
    if (!nome || nome.length < 3) return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres.' });

    const url = `${BNMP_PESQ_URL}/pesquisa/pessoas?nome=${encodeURIComponent(nome)}&page=${page}&size=${size}`;
    const r = await cnjFetch(url);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Detalhes de uma pessoa ---
router.get('/pesquisa/pessoa/:id', async (req, res) => {
  try {
    const r = await cnjFetch(`${BNMP_PESQ_URL}/pesquisa/pessoas/${req.params.id}`);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Mandados de uma pessoa ---
router.get('/pesquisa/pessoa/:id/mandados', async (req, res) => {
  try {
    const r = await cnjFetch(`${BNMP_PESQ_URL}/pesquisa/pessoas/${req.params.id}/mandados`);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Detalhes de um mandado específico ---
router.get('/mandado/:id', async (req, res) => {
  try {
    const r = await cnjFetch(`${BNMP_BASE_URL}/pecas/${req.params.id}`);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Efetuar / Cumprir um mandado ---
router.post('/mandado/:id/efetuar', async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const r = await cnjFetch(`${BNMP_BASE_URL}/pecas/${id}/situacao`, {
      method: 'PUT',
      body: JSON.stringify({
        situacao: 'CUMPRIDO',
        dataHoraCumprimento: body.dataHoraCumprimento || new Date().toISOString(),
        observacao: body.observacao || '',
        ...body
      })
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ error: data.message || data.error || `Erro ${r.status}`, detalhes: data });
    }

    res.json({ ok: true, message: 'Mandado efetivado com sucesso.', mandadoId: id, dados: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- PDF / Documento de um mandado ---
router.get('/mandado/:id/pdf', async (req, res) => {
  try {
    const headers = await auth.getHeaders();
    const r = await fetch(`${BNMP_BASE_URL}/pecas/${req.params.id}/pdf`, {
      headers: { ...headers, 'Accept': 'application/pdf,application/octet-stream,*/*' }
    });

    if (!r.ok) return res.status(r.status).json({ error: `Erro ao buscar PDF: ${r.status}` });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="mandado-${req.params.id}.pdf"`);
    r.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Rota /me (compatibilidade com o painel) ---
router.get('/me', (req, res) => {
  const s = auth.getSession();
  res.json({
    user: {
      id: 'u1',
      name: s.credentials.username || 'Operador',
      role: 'owner',
      credits: 999
    },
    defaultCreditLimit: 999
  });
});

// --- Settings BNMP (credenciais salvas pelo painel) ---
router.get('/settings/bnmp', (req, res) => {
  const s = auth.getSession();
  res.json({
    username: s.credentials.username || '',
    password: s.credentials.password ? '••••••' : '',
    proxyUrl: process.env.PROXY_URL || ''
  });
});

router.put('/settings/bnmp', (req, res) => {
  const { username, password } = req.body || {};
  const s = auth.getSession();
  const newUser = username || s.credentials.username;
  const newPass = (password && password !== '••••••') ? password : s.credentials.password;
  auth.setCredentials(newUser, newPass);
  res.json({ ok: true });
});

// --- Rota /buscar (compatibilidade com o painel) ---
router.post('/buscar', async (req, res) => {
  try {
    const { query: q } = req.body || {};
    if (!q) return res.status(400).json({ error: 'Query vazia.' });

    const digits = q.replace(/\D/g, '');
    const isCpf = digits.length >= 8;

    let pessoaData, mandados = [];

    if (isCpf) {
      const r = await cnjFetch(`${BNMP_PESQ_URL}/pesquisa/pessoas/cpf/${encodeURIComponent(digits)}`);
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(r.status).json({ error: `Erro CNJ ${r.status}: ${t.slice(0, 200)}` });
      }
      pessoaData = await r.json();
    } else {
      const r = await cnjFetch(`${BNMP_PESQ_URL}/pesquisa/pessoas?nome=${encodeURIComponent(q)}&page=0&size=10`);
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(r.status).json({ error: `Erro CNJ ${r.status}: ${t.slice(0, 200)}` });
      }
      pessoaData = await r.json();
    }

    // Tenta buscar mandados se tiver ID de pessoa
    const pessoaId = pessoaData?.id || (Array.isArray(pessoaData?.content) && pessoaData.content[0]?.id);
    if (pessoaId) {
      try {
        const rm = await cnjFetch(`${BNMP_PESQ_URL}/pesquisa/pessoas/${pessoaId}/mandados`);
        if (rm.ok) mandados = (await rm.json()) || [];
      } catch {}
    }

    res.json({ pessoa: pessoaData, mandados, query: q });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Cumprir mandado (compatibilidade com o painel: POST /cumprimentos) ---
router.post('/cumprimentos', async (req, res) => {
  try {
    const { mandadoId, observacao } = req.body || {};
    if (!mandadoId) return res.status(400).json({ error: 'mandadoId é obrigatório.' });

    const r = await cnjFetch(`${BNMP_BASE_URL}/pecas/${mandadoId}/situacao`, {
      method: 'PUT',
      body: JSON.stringify({
        situacao: 'CUMPRIDO',
        dataHoraCumprimento: new Date().toISOString(),
        observacao: observacao || ''
      })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data.message || `Erro ${r.status}`, detalhes: data });

    res.json({ ok: true, message: 'Mandado efetivado.', mandadoId, dados: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Proxy genérico para rotas não mapeadas da API CNJ ---
router.all('/proxy/*', async (req, res) => {
  try {
    const path = req.params[0];
    const query = new URLSearchParams(req.query).toString();
    const url = `${BNMP_PESQ_URL}/${path}${query ? '?' + query : ''}`;

    const r = await cnjFetch(url, {
      method: req.method,
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined
    });

    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await r.json().catch(() => ({}));
      res.status(r.status).json(data);
    } else {
      const txt = await r.text().catch(() => '');
      res.status(r.status).send(txt);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// Start
// ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ BNMP Backend rodando na porta ${PORT}`);
  console.log(`   POST /login                    → autentica no CNJ`);
  console.log(`   POST /config/credentials       → salva credenciais`);
  console.log(`   GET  /pesquisa/cpf/:cpf        → busca por CPF`);
  console.log(`   GET  /pesquisa/nome?nome=...   → busca por nome`);
  console.log(`   GET  /mandado/:id              → detalhes do mandado`);
  console.log(`   POST /mandado/:id/efetuar      → efetua/cumpre mandado`);
  console.log(`   GET  /mandado/:id/pdf          → PDF do mandado`);
});
