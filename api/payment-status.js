// Vercel Serverless Function — consulta o status real da cobrança na FlevoPay.
const DOCUMENTED_API_BASE = 'https://pagamento-processador.org.ua';
function send(res,status,body){res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, max-age=0');return res.status(status).json(body);}
async function readJson(response){const raw=await response.text();try{return raw?JSON.parse(raw):{};}catch{return {message:raw.slice(0,500)||'Resposta inválida da FlevoPay.'};}}
function resolveBaseUrl(){
  if(process.env.FLEVOPAY_TEST_MODE==='true'){
    const sandbox=String(process.env.FLEVOPAY_SANDBOX_BASE_URL||'').trim().replace(/\/+$/,'');
    if(!sandbox)throw new Error('TEST_MODE ativo, mas FLEVOPAY_SANDBOX_BASE_URL não foi configurada.');
    if(sandbox===DOCUMENTED_API_BASE)throw new Error('Modo de teste bloqueado: configure a URL sandbox fornecida pela FlevoPay.');
    return sandbox;
  }
  return String(process.env.FLEVOPAY_BASE_URL||DOCUMENTED_API_BASE).trim().replace(/\/+$/,'');
}
module.exports=async function handler(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return send(res,405,{paid:false,error:'Método não permitido.'});}
  const apiKey=process.env.FLEVOPAY_API_KEY;
  if(!apiKey)return send(res,500,{paid:false,error:'FLEVOPAY_API_KEY não configurada no Vercel.'});
  const transactionId=String((req.query&&(req.query.transactionId||req.query.tx||req.query.id))||'').trim();
  if(!transactionId||transactionId.length>128||!/^[a-zA-Z0-9_-]+$/.test(transactionId))return send(res,400,{paid:false,error:'ID da transação inválido.'});
  let baseUrl;try{baseUrl=resolveBaseUrl();}catch(error){return send(res,500,{paid:false,error:error.message});}
  if(!/^https:\/\//i.test(baseUrl))return send(res,500,{paid:false,error:'A URL da API deve usar HTTPS.'});
  const url=new URL(`${baseUrl}/api/v1/query`);url.searchParams.set('action','get_transaction');url.searchParams.set('id',transactionId);
  let providerResponse,providerData;
  try{providerResponse=await fetch(url.toString(),{method:'GET',headers:{'X-API-Key':apiKey,'Accept':'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});providerData=await readJson(providerResponse);}
  catch(error){console.error('FlevoPay query failed:',error.message);return send(res,502,{paid:false,error:'Falha ao consultar a FlevoPay.'});}
  if(!providerResponse.ok){console.error('FlevoPay query error:',providerResponse.status,providerData);return send(res,providerResponse.status===404?404:502,{paid:false,error:providerData.message||providerData.error||'Não foi possível consultar a transação.'});}
  let transaction=providerData;if(Array.isArray(transaction))transaction=transaction[0]||{};if(transaction&&transaction.data&&typeof transaction.data==='object')transaction=transaction.data;
  const status=String(transaction.status||transaction.raw_status||'unknown').toLowerCase();
  return send(res,200,{paid:status==='approved'||status==='paid',status,transactionId:String(transaction.id||transaction.transaction_id||transactionId)});
};
