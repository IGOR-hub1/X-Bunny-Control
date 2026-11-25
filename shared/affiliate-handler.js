'use strict';

// Shared, affiliate-only Vercel handler. No site server, scraper, or Pix routes.
const {createService}=require('./partners-service');
const methods={
  list:'GET',adminData:'POST',create:'POST',status:'POST',createCampaign:'POST',
  partnerAccess:'POST',grantPartnerVip:'POST',campaignUpdate:'POST',link:'POST',myLink:'POST',myCoupon:'POST',myFreeDaysCode:'POST',couponCreate:'POST',
  freeDaysCodeCreate:'POST',codeUpdate:'POST',report:'POST',payout:'POST',settings:'POST',
  financialAction:'POST',confirmPayout:'POST',allocateCommission:'POST',auditList:'POST'
};
const controlActions=new Set(Object.keys(methods));
const partnerActions=new Set(['report','myLink','myCoupon','myFreeDaysCode','payout']);

function send(response,status,payload){
  response.statusCode=status;
  response.setHeader('Content-Type','application/json; charset=utf-8');
  response.setHeader('Cache-Control','no-store');
  response.setHeader('X-Content-Type-Options','nosniff');
  response.end(JSON.stringify(payload));
}

async function readJson(request){
  if(request.body!==undefined){
    const raw=Buffer.isBuffer(request.body)?request.body.toString('utf8'):
      typeof request.body==='string'?request.body:JSON.stringify(request.body);
    if(Buffer.byteLength(raw)>4096)throw Object.assign(new Error('Solicitação muito grande.'),{statusCode:413});
    return JSON.parse(raw||'{}');
  }
  let size=0,parts=[];
  for await(const part of request){
    size+=part.length;
    if(size>4096)throw Object.assign(new Error('Solicitação muito grande.'),{statusCode:413});
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
}

function createHandler(role){
  const allowed=role==='control'?controlActions:role==='partners'?partnerActions:null;
  if(!allowed)throw new Error('Painel desconhecido.');
  let service;
  return async function handler(request,response){
    const action=new URL(request.url||'/', 'http://localhost').searchParams.get('action')||'';
    if(!allowed.has(action))return send(response,404,{ok:false,error:'Rota não encontrada.'});
    if(request.method!==methods[action]){
      response.setHeader('Allow',methods[action]);
      return send(response,405,{ok:false,error:'Método não permitido.'});
    }
    if(!/^Bearer\s+\S+/i.test(String(request.headers.authorization||'')))
      return send(response,401,{ok:false,error:'Autenticação obrigatória.'});
    try{
      const body=request.method==='POST'?await readJson(request):{};
      if(!body||Array.isArray(body)||typeof body!=='object')
        return send(response,400,{ok:false,error:'JSON inválido.'});
      if(!service)service=createService({role});
      const result=await service[action](request,body);
      return send(response,200,{ok:true,...(Array.isArray(result)?{partners:result}:result)});
    }catch(error){
      const status=Number(error.statusCode)||(error instanceof SyntaxError?400:500);
      return send(response,status,{ok:false,error:status===500?'Falha interna.':error.message});
    }
  };
}
module.exports={createHandler};
