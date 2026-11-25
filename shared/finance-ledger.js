'use strict';

const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const cents=value=>Number.isSafeInteger(value)&&value>=0&&value<=100000000000?value:0;
const idPattern=/^[A-Za-z0-9_-]{1,160}$/;

function purchaseCommission(amountCents,percent,fixedCents){
  if(!Number.isSafeInteger(amountCents)||amountCents<0||
    !Number.isFinite(percent)||percent<0||percent>100||
    !Number.isSafeInteger(Math.round(percent*100))||Math.abs(percent*100-Math.round(percent*100))>1e-7||
    !Number.isSafeInteger(fixedCents)||fixedCents<0||fixedCents>2000000)
    throw fail('Regra de comissão inválida.');
  return Math.round(amountCents*Math.round(percent*100)/10000)+fixedCents;
}

async function budget(db,campaignId,id,amountCents,mode='reserve'){
  if(!idPattern.test(campaignId)||!idPattern.test(id)||!Number.isSafeInteger(amountCents)||amountCents<0)
    throw fail('Reserva financeira inválida.');
  for(let attempt=0;attempt<8;attempt++){
    const path='campaigns/'+campaignId,version=await db.request(path,'GET',undefined,true),campaign=version.value;
    if(!campaign)throw fail('Campanha financeira não encontrada.',404);
    if(['budgetCents','budgetUsedCents'].some(field=>campaign[field]!==undefined&&
      (!Number.isSafeInteger(campaign[field])||campaign[field]<0||campaign[field]>100000000000)))
      throw fail('Orçamento financeiro inconsistente.',409);
    const awards=campaign.financeAwards||{},prior=awards[id];
    if(mode==='reserve'&&prior?.status==='reserved'){
      if(prior.amountCents!==amountCents)throw fail('Valor da reserva financeira divergente.');
      return {reserved:true,campaign};
    }
    if(mode==='release'&&(!prior||prior.status==='released'))return {reserved:false,campaign};
    if(mode==='reserve'){
      const limit=cents(campaign.budgetCents),used=cents(campaign.budgetUsedCents);
      if(limit>0&&used+amountCents>limit)return {reserved:false,campaign};
      if(Object.keys(awards).length>=2000)throw fail('Campanha exige conciliação de lançamentos.',409);
      const next={...campaign,budgetUsedCents:used+amountCents,
        financeAwards:{...awards,[id]:{amountCents,status:'reserved'}}};
      const saved=await db.request(path,'PUT',next,version.etag||'null_etag');
      if(!saved.conflict){await db.request(`byPartner/campaigns/${campaign.partnerUid}/${campaignId}/budgetUsedCents`,'PUT',next.budgetUsedCents);return {reserved:true,campaign:next};}
    }else{
      if(prior.amountCents!==amountCents)throw fail('Valor da reserva financeira divergente.');
      if(cents(campaign.budgetUsedCents)<amountCents)throw fail('Orçamento financeiro inconsistente.',409);
      const next={...campaign,budgetUsedCents:cents(campaign.budgetUsedCents)-amountCents,
        financeAwards:{...awards,[id]:{...prior,status:'released'}}};
      const saved=await db.request(path,'PUT',next,version.etag||'null_etag');
      if(!saved.conflict){await db.request(`byPartner/campaigns/${campaign.partnerUid}/${campaignId}/budgetUsedCents`,'PUT',next.budgetUsedCents);return {reserved:false,campaign:next};}
    }
  }
  throw fail('Campanha alterada simultaneamente. Reenvie a operação.',503);
}

async function entry(db,uid,id,kind,amountCents,meta={}){
  if(!idPattern.test(uid)||!idPattern.test(id)||!Number.isSafeInteger(amountCents)||amountCents<0)
    throw fail('Movimento financeiro inválido.');
  const deltas={pending:{pendingCents:amountCents},approved:{pendingCents:-amountCents,approvedCents:amountCents},
    rejected:{pendingCents:-amountCents},reversePending:{pendingCents:-amountCents},
    reverseApproved:{approvedCents:-amountCents},reversePaid:{recoveryCents:amountCents},
    reserve:{reservedCents:amountCents},
    release:{reservedCents:-amountCents},paid:{reservedCents:-amountCents,approvedCents:-amountCents,paidCents:amountCents}};
  if(!deltas[kind])throw fail('Tipo de movimento financeiro inválido.');
  const path='financeState/'+uid;
  for(let attempt=0;attempt<8;attempt++){
    const version=await db.request(path,'GET',undefined,true),state=version.value||{};
    const ledger=state.ledgerEntries||{};
    if(ledger[id]){
      if(ledger[id].kind!==kind||ledger[id].amountCents!==amountCents||
        meta.sourceId&&ledger[id].sourceId!==meta.sourceId)
        throw fail('Movimento financeiro repetido com valor diferente.');
      await db.request(`byPartner/financeLedger/${uid}/${id}`,'PUT',ledger[id]);
      return {duplicate:true,state};
    }
    if(state.currency&&state.currency!=='BRL'||state.ledgerVerified===false)
      throw fail('Saldo financeiro requer conciliação em BRL.',409);
    if(['pendingCents','approvedCents','reservedCents','paidCents','recoveryCents'].some(field=>
      state[field]!==undefined&&(!Number.isSafeInteger(state[field])||state[field]<0||state[field]>100000000000)))
      throw fail('Saldo financeiro inconsistente.',409);
    if(Object.keys(ledger).length>=10000)throw fail('Histórico financeiro requer arquivamento.',409);
    const next={...state,currency:'BRL',ledgerVerified:true,ledgerEntries:{...ledger,
      [id]:{id,kind,amountCents,sourceId:meta.sourceId||null,actorUid:meta.actorUid||null,at:meta.at||Date.now()}}};
    for(const [field,delta] of Object.entries(deltas[kind])){
      const value=cents(state[field])+delta;
      if((kind==='paid'||kind==='reverseApproved')&&field==='approvedCents'&&value<0){
        next.approvedCents=0;
        next.recoveryCents=cents(state.recoveryCents)-value;
        continue;
      }
      if(value<0||!Number.isSafeInteger(value))throw fail('Saldo financeiro insuficiente ou inconsistente.',409);
      next[field]=value;
    }
    if(kind==='reserve'){
      const available=cents(state.approvedCents)-cents(state.reservedCents)-cents(state.recoveryCents);
      if(amountCents>available)throw fail('Saldo disponível insuficiente.',409);
      next.requests={...(state.requests||{}),[id]:{amountCents,at:meta.at||Date.now()}};
    }
    const saved=await db.request(path,'PUT',next,version.etag||'null_etag');
    if(!saved.conflict){
      // O registro canônico já foi confirmado no mesmo CAS do saldo. Este índice é somente leitura paginada.
      await db.request(`byPartner/financeLedger/${uid}/${id}`,'PUT',next.ledgerEntries[id]);
      return {duplicate:false,state:next};
    }
  }
  throw fail('Saldo alterado simultaneamente. Reenvie a operação.',503);
}

module.exports={purchaseCommission,budget,entry};
