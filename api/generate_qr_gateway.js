// Vercel Serverless Function — cria cobrança PIX na FlevoPay.
// A Secret Key é lida apenas do ambiente do servidor.

const { randomUUID } = require('node:crypto');

const DEFAULT_BASE_URL = 'https://app.flevopay.com.br';

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(status).json(body);
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseTracking(input) {
  let params;
  if (typeof input === 'string') {
    params = new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
  } else if (input && typeof input === 'object') {
    params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null && String(value).trim()) {
        params.set(key, String(value));
      }
    }
  } else {
    params = new URLSearchParams();
  }

  const allowed = [
    'utm_source', 'utm_medium', 'utm_campaign',
    'utm_content', 'utm_term', 'src', 'sck'
  ];
  const tracking = {};
  for (const key of allowed) {
    const value = params.get(key);
    if (value && value.trim()) tracking[key] = value.trim().slice(0, 500);
  }
  return tracking;
}

async function readJson(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return { message: raw.slice(0, 500) || 'Resposta inválida da FlevoPay.' }; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { success: false, error: 'Método não permitido.' });
  }

  const apiKey = process.env.FLEVOPAY_API_KEY;
  if (!apiKey) {
    return send(res, 500, {
      success: false,
      error: 'Falta configurar FLEVOPAY_API_KEY nas variáveis de ambiente do Vercel.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return send(res, 400, { success: false, error: 'Corpo JSON inválido.' }); }
  }
  body = body && typeof body === 'object' ? body : {};

  const amount = Number(body.amount);
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const document = onlyDigits(body.document);
  const phone = onlyDigits(body.phone);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return send(res, 400, { success: false, error: 'Valor da cobrança inválido.' });
  }
  if (!name || !email || !email.includes('@') || !document || !phone) {
    return send(res, 400, {
      success: false,
      error: 'Preencha nome, e-mail, CPF/CNPJ e telefone com DDD antes de gerar o Pix.'
    });
  }

  const description = String(
    body.description || body.offer || body.itemTitle || 'Compra online'
  ).trim().slice(0, 180);
  const reference = `TTK-${randomUUID()}`;
  const payload = {
    amount,
    description: description || 'Compra online',
    reference,
    source: 'api_externa',
    customer: { name, email, document, phone }
  };

  const tracking = parseTracking(body.utm);
  if (Object.keys(tracking).length) payload.tracking = tracking;

  const baseUrl = (process.env.FLEVOPAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let providerResponse;
  let providerData;

  try {
    providerResponse = await fetch(`${baseUrl}/api/v1/transaction`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    providerData = await readJson(providerResponse);
  } catch (error) {
    console.error('FlevoPay create transaction failed:', error.message);
    return send(res, 502, {
      success: false,
      error: 'Não foi possível conectar à FlevoPay. Tente novamente.'
    });
  }

  if (!providerResponse.ok) {
    console.error('FlevoPay create transaction error:', providerResponse.status, providerData);
    const message = providerResponse.status === 401
      ? 'A FlevoPay recusou a autenticação. Confira a FLEVOPAY_API_KEY no Vercel.'
      : (providerData.message || providerData.error || 'A FlevoPay não conseguiu gerar a cobrança.');
    return send(res, 502, { success: false, error: String(message).slice(0, 300) });
  }

  const transaction = providerData && providerData.data && typeof providerData.data === 'object'
    ? providerData.data
    : providerData;
  const transactionId = transaction.transaction_id ?? transaction.id;
  const pixCode = transaction.qr_code || transaction.pix_code || transaction.qrCodeText;

  if (!transactionId || !pixCode) {
    console.error('Unexpected FlevoPay create response:', providerData);
    return send(res, 502, {
      success: false,
      error: 'A FlevoPay respondeu, mas não retornou o ID da transação e o código Pix.'
    });
  }

  // Mantém o formato esperado pelo checkout já existente.
  return send(res, 200, {
    success: true,
    transactionId: String(transactionId),
    payment_code: String(transactionId),
    pixCode: String(pixCode),
    pix_code: String(pixCode),
    expires_at: transaction.expires_at || null,
    reference
  });
};
