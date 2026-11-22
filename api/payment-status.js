// Vercel Serverless Function — consulta o status real da cobrança na FlevoPay.

const DEFAULT_BASE_URL = 'https://app.flevopay.com.br';

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(status).json(body);
}

async function readJson(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return { message: raw.slice(0, 500) || 'Resposta inválida da FlevoPay.' }; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { paid: false, error: 'Método não permitido.' });
  }

  const apiKey = process.env.FLEVOPAY_API_KEY;
  if (!apiKey) {
    return send(res, 500, { paid: false, error: 'FLEVOPAY_API_KEY não configurada no Vercel.' });
  }

  const transactionId = String(
    (req.query && (req.query.transactionId || req.query.tx)) || ''
  ).trim();

  if (!transactionId || transactionId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(transactionId)) {
    return send(res, 400, { paid: false, error: 'ID da transação inválido.' });
  }

  const baseUrl = (process.env.FLEVOPAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/api/v1/query`);
  url.searchParams.set('action', 'get_transaction');
  url.searchParams.set('id', transactionId);

  let providerResponse;
  let providerData;
  try {
    providerResponse = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json'
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000)
    });
    providerData = await readJson(providerResponse);
  } catch (error) {
    console.error('FlevoPay transaction query failed:', error.message);
    return send(res, 502, { paid: false, error: 'Falha ao consultar a FlevoPay.' });
  }

  if (!providerResponse.ok) {
    console.error('FlevoPay transaction query error:', providerResponse.status, providerData);
    return send(res, providerResponse.status === 404 ? 404 : 502, {
      paid: false,
      error: providerData.message || providerData.error || 'Não foi possível consultar a transação.'
    });
  }

  let transaction = providerData;
  if (Array.isArray(transaction)) transaction = transaction[0] || {};
  if (transaction && transaction.data && typeof transaction.data === 'object') {
    transaction = transaction.data;
  }

  const status = String(transaction.status || transaction.raw_status || 'unknown').toLowerCase();
  return send(res, 200, {
    paid: status === 'approved',
    status,
    transactionId: String(transaction.id || transactionId)
  });
};
