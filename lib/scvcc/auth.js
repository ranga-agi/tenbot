/**
 * SCVCC Clubessential Authentication & Session Cookie Management
 */

const courtsConfig = require('../courtsConfig');
const { resolveCourtConfigName, getScvccUrls } = require('./config');

// In-memory session cache
const sessionCookieMap = new Map();
let sessionToken = null;
let sessionExpiresAt = 0;
let authPromise = null;

/**
 * RC4 encryption utilities matching Clubessential client-side login encryption.
 */
function hexEncode(data) {
  const b16D = '0123456789abcdef';
  const b16M = [];
  for (let i = 0; i < 256; i++) b16M[i] = b16D.charAt(i >> 4) + b16D.charAt(i & 15);
  const result = [];
  for (let i = 0; i < data.length; i++) result[i] = b16M[data.charCodeAt(i)];
  return result.join('');
}

function rc4Encrypt(key, pt) {
  const s = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  let x;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    x = s[i];
    s[i] = s[j];
    s[j] = x;
  }
  let i = 0;
  j = 0;
  let ct = '';
  for (let y = 0; y < pt.length; y++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    x = s[i];
    s[i] = s[j];
    s[j] = x;
    ct += String.fromCharCode(pt.charCodeAt(y) ^ s[(s[i] + s[j]) % 256]);
  }
  return ct;
}

function rc4EncryptStr(str, key) {
  return hexEncode(rc4Encrypt(key, unescape(encodeURIComponent(str))));
}

function getCookieHeader() {
  return [...sessionCookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function updateCookiesFromResponse(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (k && v) sessionCookieMap.set(k.trim(), v.trim());
  }
}

/**
 * Authenticates with SCVCC member portal using credentials from config/courts.json (or .env fallback).
 */
async function authenticate(force = false, venue = 'SCVCC') {
  const configName = resolveCourtConfigName(venue);
  const courtConfig = courtsConfig.getCourtConfig(configName, 'scvcc');
  const username = courtConfig?.username || process.env.SCVCC_USERNAME;
  const password = courtConfig?.password || process.env.SCVCC_PASSWORD;
  const urls = getScvccUrls(venue);

  if (!username || !password) {
    throw new Error('SCVCC credentials (username/password) are not configured in config/courts.json or .env');
  }

  const now = Date.now();
  if (!force && sessionToken && sessionExpiresAt > now) {
    return { success: true, token: sessionToken };
  }

  if (authPromise) return authPromise;

  authPromise = (async () => {
    try {
      sessionCookieMap.clear();

      // 1. Initial page hit to establish session cookie
      const initRes = await fetch(urls.loginPageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      updateCookiesFromResponse(initRes);

      // 2. Step 1: obtain encryption key & CIP
      const step1Res = await fetch(`${urls.step1Url}?r=${Math.floor(Math.random() * 1000)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cookie': getCookieHeader(),
          'Referer': urls.loginPageUrl,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        body: JSON.stringify({ lstep: 1 })
      });

      if (!step1Res.ok) {
        throw new Error(`SCVCC login step 1 failed: HTTP ${step1Res.status}`);
      }

      const step1Json = await step1Res.json();
      const step1Data = JSON.parse(step1Json.d)[0];
      const key = decodeURIComponent(step1Data.key);
      const cip = decodeURIComponent(step1Data.cip);

      // 3. Step 2: send encrypted credentials
      const step2Res = await fetch(`${urls.step2Url}?r=${Math.floor(Math.random() * 1000)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cookie': getCookieHeader(),
          'Referer': urls.loginPageUrl,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        body: JSON.stringify({
          id: rc4EncryptStr(username, key),
          pw: rc4EncryptStr(password, key),
          url: '',
          cip: rc4EncryptStr(cip, key)
        })
      });

      if (!step2Res.ok) {
        throw new Error(`SCVCC login step 2 failed: HTTP ${step2Res.status}`);
      }

      const step2Json = await step2Res.json();
      const step2Parsed = JSON.parse(step2Json.d);
      if (!step2Parsed || !step2Parsed[0] || !step2Parsed[0].token) {
        throw new Error('SCVCC login returned invalid credentials or token');
      }

      sessionToken = decodeURIComponent(step2Parsed[0].token);
      sessionExpiresAt = Date.now() + 25 * 60 * 1000; // 25 min TTL

      // 4. Session exchange
      const defaultUrl = `${urls.host}/default.aspx?login=true&sessionToken=${encodeURIComponent(sessionToken)}&gotopage=${encodeURIComponent('p=MembersDefault')}`;
      const loginRes = await fetch(defaultUrl, {
        headers: {
          'Cookie': getCookieHeader(),
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        redirect: 'manual'
      });
      updateCookiesFromResponse(loginRes);

      return { success: true, token: sessionToken };
    } finally {
      authPromise = null;
    }
  })();

  return authPromise;
}

/**
 * Executes an authenticated fetch to SCVCC, automatically re-authenticating if expired.
 */
async function authFetch(url, options = {}, retries = 1, venueOrChatId = null) {
  await authenticate(false, venueOrChatId || 'SCVCC');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Cookie': getCookieHeader(),
    ...(options.headers || {})
  };

  let res = await fetch(url, { ...options, headers });
  updateCookiesFromResponse(res);

  // Check if session expired and redirected to login page
  const resUrl = res.url || '';
  let isExpired = resUrl.includes('member-login') || resUrl.includes('login=expired') || res.status === 401;

  if (!isExpired && (url.includes('dialog.aspx') || url.includes('Default.aspx'))) {
    const clone = res.clone();
    const text = await clone.text();
    if (text.includes('class="login-content"') || text.includes('member-login') || text.includes('login=expired')) {
      isExpired = true;
    }
  }

  if (isExpired && retries > 0) {
    console.log('[scvcc] Session expired, re-authenticating and retrying...');
    await authenticate(true, venueOrChatId || 'SCVCC');
    return authFetch(url, options, retries - 1, venueOrChatId);
  }

  return res;
}

module.exports = {
  authenticate,
  authFetch
};
