'use strict';
const net=require('node:net');
const fail=(message,statusCode=503)=>Object.assign(new Error(message),{statusCode});

async function verifyPayout(payout,externalReference,options={}){
  const endpoint=options.url||process.env.PARTNERS_PAYOUT_VERIFY_URL;
  const token=options.token||process.env.PARTNERS_PAYOUT_VERIFY_TOKEN;
  if(!endpoint||!token)throw fail('Verificação externa de saques não configurada.');
  let url;try{url=new URL(endpoint);}catch{throw fail('URL de verificação de saques inválida.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||
    net.isIP(url.hostname.replace(/^\[|\]$/g,''))||
    /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname))
    throw fail('Verificador de saques deve usar HTTPS público.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  let response;
  try{response=await (options.fetch||fetch)(url.href,{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({payoutId:payout.id,partnerUid:payout.partnerUid,
      amountCents:payout.amountCents,currency:payout.currency,externalReference}),
    signal:controller.signal});}
  catch{throw fail('Verificação externa do saque indisponível.');}
  finally{clearTimeout(timer);}
  if(!response.ok)throw fail('Provedor não confirmou o saque.',409);
  let result;try{result=await response.json();}catch{throw fail('Resposta inválida do verificador de saques.');}
  if(result?.status!=='confirmed'||result.payoutId!==payout.id||
    result.partnerUid!==payout.partnerUid||result.amountCents!==payout.amountCents||
    result.currency!==payout.currency||result.paymentId!==externalReference||
    !/^[A-Za-z0-9_-]{8,160}$/.test(result.paymentId||'')||
    !Number.isSafeInteger(result.confirmedAt)||result.confirmedAt<=0)
    throw fail('Confirmação externa não corresponde ao saque.',409);
  return {paymentId:result.paymentId,confirmedAt:result.confirmedAt,
    provider:String(result.provider||'').slice(0,80)};
}
module.exports={verifyPayout};
