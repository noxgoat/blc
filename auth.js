/**
 * auth.js — Login no BNMP via navegador headless (Playwright)
 * Abre o Chrome real, preenche CPF+senha, captura o token JWT e cookies de sessão.
 */

const { chromium } = require('playwright');

const PORTAL_URL = 'https://portalbnmp.cnj.jus.br';
const LOGIN_URL  = `${PORTAL_URL}/bnmpportal/`;

// Sessão em memória
let SESSION = {
  token: null,
  cookies: [],
  expiresAt: 0,
  credentials: { username: null, password: null }
};

function isValid() {
  return SESSION.token && Date.now() < SESSION.expiresAt;
}

function getSession() {
  return SESSION;
}

function setCredentials(username, password) {
  SESSION.credentials = { username, password };
  SESSION.token = null;
  SESSION.expiresAt = 0;
  SESSION.cookies = [];
}

/**
 * Faz login via navegador headless e captura o token JWT da resposta da API.
 */
async function login(username, password) {
  if (username && password) setCredentials(username, password);

  const u = SESSION.credentials.username;
  const p = SESSION.credentials.password;
  if (!u || !p) throw new Error('Credenciais não configuradas.');

  console.log('[auth] Iniciando login via navegador headless...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  let capturedToken = null;

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo'
    });

    const page = await context.newPage();

    // Intercepta respostas para capturar o token JWT
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/authenticate') || url.includes('/login') || url.includes('/auth')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const body = await response.json().catch(() => null);
            if (body && (body.id_token || body.token || body.access_token)) {
              capturedToken = body.id_token || body.token || body.access_token;
              console.log('[auth] Token capturado via interceptação!');
            }
          }
        } catch {}
      }
    });

    // Também intercepta requests para pegar o Authorization header que o JS envia
    page.on('request', (request) => {
      const auth = request.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && auth.length > 50) {
        capturedToken = auth.replace('Bearer ', '');
        console.log('[auth] Token capturado via header de request!');
      }
    });

    // Navega para o portal
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('[auth] Portal carregado:', page.url());

    // Aguarda o formulário de login aparecer
    await page.waitForSelector('input[type="text"], input[name="username"], input[id*="user"], input[placeholder*="CPF"], input[placeholder*="usuário"]', { timeout: 15000 });

    // Preenche usuário
    const userInput = await page.$('input[name="username"]') ||
                      await page.$('input[id*="user"]') ||
                      await page.$('input[placeholder*="CPF"]') ||
                      await page.$('input[type="text"]:first-of-type');

    if (!userInput) throw new Error('Campo de usuário não encontrado na página de login.');
    await userInput.click({ clickCount: 3 });
    await userInput.type(u, { delay: 80 });

    // Preenche senha
    const passInput = await page.$('input[type="password"]');
    if (!passInput) throw new Error('Campo de senha não encontrado.');
    await passInput.click();
    await passInput.type(p, { delay: 80 });

    // Clica em entrar
    const submitBtn = await page.$('button[type="submit"]') ||
                      await page.$('input[type="submit"]') ||
                      await page.$('button:has-text("Entrar")') ||
                      await page.$('button:has-text("Login")');

    if (!submitBtn) throw new Error('Botão de login não encontrado.');
    await submitBtn.click();

    // Aguarda navegação após login
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});

    // Verifica se apareceu mensagem de erro
    const errMsg = await page.$eval(
      '[class*="error"], [class*="erro"], [class*="alert"], [id*="error"]',
      el => el.textContent?.trim()
    ).catch(() => null);

    if (errMsg && errMsg.length > 3) {
      throw new Error(`Login rejeitado: ${errMsg}`);
    }

    // Tenta pegar o token do localStorage/sessionStorage
    if (!capturedToken) {
      capturedToken = await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          const v = localStorage.getItem(key);
          if (v && v.startsWith('ey') && v.split('.').length === 3) return v;
        }
        for (const key of Object.keys(sessionStorage)) {
          const v = sessionStorage.getItem(key);
          if (v && v.startsWith('ey') && v.split('.').length === 3) return v;
        }
        // Tenta pegar de alguma variável global
        return window.__token || window.authToken || window.jwtToken || null;
      });
      if (capturedToken) console.log('[auth] Token capturado via storage!');
    }

    // Captura cookies da sessão (fallback se não tiver JWT)
    const cookies = await context.cookies();
    SESSION.cookies = cookies;

    if (!capturedToken) {
      // Tenta chamar o endpoint de autenticação diretamente com os cookies já estabelecidos
      capturedToken = await page.evaluate(async (creds) => {
        try {
          const r = await fetch('/bnmpportal/api/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(creds)
          });
          const d = await r.json();
          return d.id_token || d.token || d.access_token || null;
        } catch { return null; }
      }, { username: u, password: p });
      if (capturedToken) console.log('[auth] Token capturado via fetch interno!');
    }

    if (!capturedToken) {
      // Última tentativa: verifica se está logado (page não tem mais login form)
      const stillOnLogin = await page.$('input[type="password"]');
      if (stillOnLogin) throw new Error('Login falhou — verifique usuário e senha.');
      throw new Error('Login realizado mas token não foi capturado. Tente novamente.');
    }

    SESSION.token = capturedToken;
    SESSION.expiresAt = Date.now() + 3_600_000; // 1 hora
    console.log('[auth] Login concluído com sucesso!');
    return capturedToken;

  } finally {
    await browser.close();
  }
}

/**
 * Retorna headers prontos para chamar a API do CNJ.
 */
async function getHeaders() {
  if (!isValid()) {
    await login();
  }
  return {
    'Authorization': `Bearer ${SESSION.token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://portalbnmp.cnj.jus.br',
    'Referer': 'https://portalbnmp.cnj.jus.br/'
  };
}

module.exports = { login, getHeaders, isValid, getSession, setCredentials };
