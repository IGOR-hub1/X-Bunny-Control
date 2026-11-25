'use strict';
const crypto=require('node:crypto');
const DAY=86400000;
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});

function createGranter({main,partners,now=Date.now}){
  async function grant(uid,days,requestId,actorUid){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(uid||'')||!Number.isSafeInteger(days)||days<1||days>365||
      !/^[A-Za-z0-9_-]{12,80}$/.test(requestId||''))throw fail('Benefício VIP inválido.',400);
    const id='v_'+crypto.createHash('sha256').update(uid+'\0'+requestId).digest('hex').slice(0,40);
    const path=`partnerVipGrants/${id}`;
    const existing=(await partners.request(path)).value;
    if(existing&&(existing.uid!==uid||existing.days!==days||existing.actorUid!==actorUid))
      throw fail('Identificador de benefício conflitante.');
    if(existing?.state==='complete'){
      await partners.request(`byPartner/vipBenefits/${uid}/${id}`,'PUT',existing);
      return {id,uid,days,expiresAt:existing.expiresAt,duplicate:true};
    }
    if(!existing){
      const created=await partners.request(path,'PUT',{id,uid,days,actorUid,state:'reserved',createdAt:now()},'null_etag');
      if(created.conflict)return grant(uid,days,requestId,actorUid);
    }
    let applied;
    for(let attempt=0;attempt<8;attempt++){
      const accountPath=`users/${uid}`,version=await main.request(accountPath,'GET',undefined,true),account=version.value;
      if(!account||account.uid!==uid||account.banned===true||account.blocked===true)
        throw fail('Conta principal indisponível.',403);
      const ledger=account.appliedPaymentOrders||{},prior=ledger[id];
      if(prior){
        if(prior.kind!=='partnerVip'||prior.days!==days)throw fail('Benefício já aplicado com outra regra.');
        applied={expiresAt:prior.expiresAt,activatedAt:prior.activatedAt,duplicate:true};break;
      }
      const at=now(),expiry=Number(account.premiumUntil??account.vipUntil??0);
      if(!Number.isSafeInteger(expiry)||expiry<0)throw fail('Validade VIP atual inválida.');
      const vip=(account.premium===true||account.vip===true||account.isPremium===true)&&
        (expiry===0||expiry>at);
      const plus=[account.plan,account.currentPlan].some(value=>String(value||'').toLowerCase()==='plus');
      if(vip&&(plus||expiry===0))throw fail('Plus ativo ou VIP permanente não aceita dias adicionais.');
      const expiresAt=(vip?expiry:at)+days*DAY;
      if(!Number.isSafeInteger(expiresAt)||expiresAt>at+2*365*DAY)
        throw fail('Validade VIP excede o limite permitido.');
      const next={...account,plan:'VIP',currentPlan:'VIP',premium:true,vip:true,isPremium:true,
        premiumUntil:expiresAt,vipUntil:expiresAt,planExpiresAt:expiresAt,
        subscriptionStatus:'active',planUpdatedAt:at,planActivatedAt:at,
        appliedPaymentOrders:{...ledger,[id]:{kind:'partnerVip',days,actorUid,activatedAt:at,expiresAt}}};
      const saved=await main.request(accountPath,'PUT',next,version.etag||'null_etag');
      if(!saved.conflict){applied={expiresAt,activatedAt:at,duplicate:false};break;}
    }
    if(!applied)throw fail('Conta alterada simultaneamente. Tente novamente.',503);
    const record={id,uid,days,actorUid,state:'complete',createdAt:existing?.createdAt||now(),
      completedAt:now(),activatedAt:applied.activatedAt,expiresAt:applied.expiresAt};
    for(let attempt=0;attempt<8;attempt++){
      const version=await partners.request(path,'GET',undefined,true),current=version.value;
      if(current?.state==='complete')break;
      const saved=await partners.request(path,'PUT',{...current,...record},version.etag||'null_etag');
      if(!saved.conflict)break;
      if(attempt===7)throw fail('Benefício aplicado; conciliação pendente.',503);
    }
    await partners.request(`byPartner/vipBenefits/${uid}/${id}`,'PUT',record);
    return {id,uid,days,expiresAt:applied.expiresAt,duplicate:applied.duplicate};
  }
  return {grant};
}
module.exports={createGranter};
