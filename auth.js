/**
 * auth.js — Login no BNMP via Playwright (Chrome headless)
 * Estratégias em cascata para capturar o token JWT.
 */

const { chromium } = require('playwright-core');

const PORTAL_URL = 'https://portalbnmp.cnj.jus.br';

let SESSION = {
  token: null,
  cookies: [],
  expiresAt: 0,
  credentials: { username: null, password: null }
};

function isValid() {
  return !!(SESSION.token && Date.now() < SESSION.expiresAt);
}

function getSession() { return SESSION; }

function setCredentials(username, password) {
  SESSION.credentials = { username, password };
  SESSION.token = null;
  SESSION.expiresAt = 0;
  SESSION.cookies = [];
}

/**
 * Login via Chrome headless com múltiplas estratégias de captura de token.
 */
async function login(username, password) {
  if (username !== undefined) SESSION.credentials.username = username || SESSION.credentials.username;
  if (password !== undefined) SESSION.credentials.password = password || SESSION.credentials.password;

  const u = SESSION.credentials.username;
  const p = SESSION.credentials.password;
  if (!u || !p) throw new Error('Credenciais não configuradas. Configure na aba Configurações.');

  console.log('[auth] Iniciando login via Playwright...');

  const fs = require('fs');

  // Prioridade: env var > sistema (apt) > fallback Playwright
  const systemPaths = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ].filter(Boolean);

  const executablePath = systemPaths.find(p => fs.existsSync(p)) || undefined;
  console.log('[auth] Chromium:', executablePath || 'padrão do Playwright');

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--single-process',
      '--window-size=1280,800'
    ]
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      viewport: { width: 1280, height: 800 }
    });

    let capturedToken = null;

    // Estratégia 1: intercepta responses da API de auth
    context.on('response', async (response) => {
      if (capturedToken) return;
      const url = response.url();
      if (url.includes('authenticate') || url.includes('/auth') || url.includes('/login') || url.includes('/token')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const body = await response.json().catch(() => null);
            const t = body && (body.id_token || body.token || body.access_token || body.jwt);
            if (t && t.startsWith('ey')) { capturedToken = t; console.log('[auth] ✅ Token via response interceptado'); }
          }
        } catch {}
      }
    });

    // Estratégia 2: intercepta requests com Authorization header
    context.on('request', (req) => {
      if (capturedToken) return;
      const auth = req.headers()['authorization'] || '';
      if (auth.startsWith('Bearer ey') && auth.length > 60) {
        capturedToken = auth.slice(7);
        console.log('[auth] ✅ Token via request header interceptado');
      }
    });

    const page = await context.newPage();

    // Navega para o portal
    console.log('[auth] Navegando para o portal...');
    await page.goto(`${PORTAL_URL}/bnmpportal/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => {});

    await page.waitForTimeout(2000);
    console.log('[auth] URL atual:', page.url());

    // Aguarda campo de login aparecer
    const userSelectors = [
      'input[name="username"]',
      'input[name="login"]',
      'input[id="username"]',
      'input[type="text"]',
      'input[placeholder*="CPF"]',
      'input[placeholder*="usuário"]',
      'input[placeholder*="usuario"]',
      'input[placeholder*="login"]'
    ];

    let userInput = null;
    for (const sel of userSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        userInput = await page.$(sel);
        if (userInput) { console.log('[auth] Campo usuário encontrado:', sel); break; }
      } catch {}
    }

    if (!userInput) {
      // Tira screenshot para debug
      const ss = await page.screenshot({ fullPage: false }).catch(() => null);
      throw new Error(`Campo de usuário não encontrado. URL: ${page.url()}. Verifique se o portal está acessível.`);
    }

    // Preenche usuário (CPF)
    await userInput.click({ clickCount: 3 });
    await userInput.fill('');
    await userInput.type(u, { delay: 60 });
    console.log('[auth] Usuário preenchido');

    // Aguarda campo de senha
    const passSelectors = ['input[type="password"]', 'input[name="password"]', 'input[name="senha"]'];
    let passInput = null;
    for (const sel of passSelectors) {
      passInput = await page.$(sel);
      if (passInput) break;
    }
    if (!passInput) throw new Error('Campo de senha não encontrado.');

    await passInput.click();
    await passInput.fill('');
    await passInput.type(p, { delay: 60 });
    console.log('[auth] Senha preenchida');

    // Clica em entrar
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Acessar")',
      '[class*="login"] button',
      '[class*="btn-login"]',
      '[class*="btn-entrar"]'
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          submitted = true;
          console.log('[auth] Botão clicado:', sel);
          break;
        }
      } catch {}
    }

    if (!submitted) {
      // Tenta Enter no campo senha
      await passInput.press('Enter');
      console.log('[auth] Enter pressionado no campo senha');
    }

    // Aguarda resultado do login
    await page.waitForTimeout(5000);

    // Verifica erros de login
    const errorSelectors = [
      '.error', '.erro', '.alert-danger', '[class*="error"]',
      '[class*="invalid"]', '[class*="wrong"]', '[id*="error"]'
    ];
    for (const sel of errorSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const txt = await el.textContent();
          if (txt && txt.trim().length > 3) {
            throw new Error(`Login rejeitado pelo CNJ: "${txt.trim()}"`);
          }
        }
      } catch (e) {
        if (e.message.includes('Login rejeitado')) throw e;
      }
    }

    // Estratégia 3: busca token no localStorage/sessionStorage
    if (!capturedToken) {
      capturedToken = await page.evaluate(() => {
        const stores = [localStorage, sessionStorage];
        for (const store of stores) {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            const val = store.getItem(key);
            if (val && val.startsWith('ey') && val.split('.').length === 3 && val.length > 100) {
              console.log('Token encontrado no storage, chave:', key);
              return val;
            }
            // Tenta parsear JSON
            try {
              const obj = JSON.parse(val);
              const t = obj && (obj.id_token || obj.token || obj.access_token || obj.jwt);
              if (t && typeof t === 'string' && t.startsWith('ey')) return t;
            } catch {}
          }
        }
        return null;
      });
      if (capturedToken) console.log('[auth] ✅ Token via localStorage/sessionStorage');
    }

    // Estratégia 4: chama o endpoint de auth direto da página (com os cookies já estabelecidos)
    if (!capturedToken) {
      console.log('[auth] Tentando chamar authenticate via page.evaluate...');
      capturedToken = await page.evaluate(async ([user, pass]) => {
        try {
          const r = await fetch('/bnmpportal/api/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username: user, password: pass })
          });
          if (!r.ok) return null;
          const d = await r.json();
          return d.id_token || d.token || d.access_token || null;
        } catch { return null; }
      }, [u, p]);
      if (capturedToken) console.log('[auth] ✅ Token via fetch interno com cookies de sessão');
    }

    // Estratégia 5: verifica se está logado buscando variável global de auth
    if (!capturedToken) {
      capturedToken = await page.evaluate(() => {
        return (
          window.__auth_token || window.authToken || window.jwtToken ||
          window.__token || window.TOKEN || window._token ||
          (window.angular && angular.element(document.body)?.injector()?.get?.('AuthService')?.getToken?.()) ||
          null
        );
      }).catch(() => null);
      if (capturedToken) console.log('[auth] ✅ Token via variável global');
    }

    // Captura os cookies da sessão (para uso como fallback)
    SESSION.cookies = await context.cookies();

    if (!capturedToken) {
      // Verifica se saiu da tela de login (indica sucesso mesmo sem token capturado)
      const stillLogin = await page.$('input[type="password"]');
      if (stillLogin) {
        throw new Error('Login falhou — usuário ou senha incorretos.');
      }
      throw new Error('Login realizado mas token não capturado. Tente novamente ou entre em contato com o suporte.');
    }

    SESSION.token = capturedToken;
    SESSION.expiresAt = Date.now() + 3_600_000; // 1 hora
    console.log('[auth] ✅ Login concluído com sucesso!');
    return capturedToken;

  } finally {
    await browser.close();
  }
}

/**
 * Retorna headers autenticados, renovando o token se necessário.
 */
async function getHeaders() {
  if (!isValid()) {
    const u = SESSION.credentials.username;
    const p = SESSION.credentials.password;
    if (!u || !p) throw new Error('Credenciais não configuradas. Configure na aba Configurações do painel.');
    await login(u, p);
  }
  return {
    'Authorization': `Bearer ${SESSION.token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': PORTAL_URL,
    'Referer': `${PORTAL_URL}/bnmpportal/`
  };
}

module.exports = { login, getHeaders, isValid, getSession, setCredentials };
