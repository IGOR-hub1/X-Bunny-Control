'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const finance=require('./finance-ledger');
const {createGranter}=require('./partner-vip');
const {verifyPayout}=require('./payout-verifier');

function memory(initial={}){
  const rows=new Map(Object.entries(initial).map(([key,value])=>[key,structuredClone(value)]));
  const versions=new Map();
  return {rows,async request(path,method='GET',value,etag){
    if(method==='GET')return {value:structuredClone(rows.get(path)??null),etag:'v'+(versions.get(path)||0)};
    if(method==='PUT'){
      if(etag==='null_etag'&&rows.has(path)||etag&&etag!=='null_etag'&&etag!=='v'+(versions.get(path)||0))
        return {conflict:true};
      rows.set(path,structuredClone(value));versions.set(path,(versions.get(path)||0)+1);return {value};
    }
    throw new Error('Método inesperado');
  }};
}
test('percentual e fixo de compra usam centavos inteiros',()=>{
  assert.equal(finance.purchaseCommission(1790,12.5,75),299);
  assert.equal(finance.purchaseCommission(100,0,0),0);
  assert.throws(()=>finance.purchaseCommission(100,5,0.5));
});
test('orçamento por campanha impede duas comissões além do limite',async()=>{
  const db=memory({'campaigns/c1':{id:'c1',partnerUid:'alice',budgetCents:300,budgetUsedCents:0}});
  const results=await Promise.all([finance.budget(db,'c1','commission1',200),
    finance.budget(db,'c1','commission2',200)]);
  assert.equal(results.filter(item=>item.reserved).length,1);
  assert.equal(db.rows.get('campaigns/c1').budgetUsedCents,200);
  const winner=results[0].reserved?'commission1':'commission2';
  await finance.budget(db,'c1',winner,200,'release');
  await finance.budget(db,'c1',winner,200,'release');
  assert.equal(db.rows.get('campaigns/c1').budgetUsedCents,0);
});
test('lançamentos de saldo são idempotentes e saque não paga automaticamente',async()=>{
  const db=memory();
  await finance.entry(db,'alice','c1_pending','pending',500,{sourceId:'order1'});
  await finance.entry(db,'alice','c1_pending','pending',500,{sourceId:'order1'});
  await finance.entry(db,'alice','c1_approved','approved',500,{actorUid:'root'});
  await finance.entry(db,'alice','payout1','reserve',300,{actorUid:'alice'});
  const state=db.rows.get('financeState/alice');
  assert.equal(state.pendingCents,0);assert.equal(state.approvedCents,500);
  assert.equal(state.reservedCents,300);assert.equal(state.paidCents,undefined);
  await assert.rejects(finance.entry(db,'alice','payout2','reserve',201),{statusCode:409});
  await finance.entry(db,'alice','payout1_paid','paid',300,{sourceId:'external123'});
  assert.equal(db.rows.get('financeState/alice').paidCents,300);
  assert.equal(db.rows.get('financeState/alice').approvedCents,200);
});
test('VIP de parceiro aplica uma vez e preserva prazo anterior',async()=>{
  const at=2000000000000,main=memory({'users/alice':{uid:'alice',plan:'VIP',premium:true,premiumUntil:at+86400000}});
  const partners=memory();
  const granter=createGranter({main,partners,now:()=>at});
  const first=await granter.grant('alice',3,'request_123456','root');
  const again=await granter.grant('alice',3,'request_123456','root');
  assert.equal(first.expiresAt,at+4*86400000);assert.equal(again.duplicate,true);
  assert.equal(main.rows.get('users/alice').premiumUntil,first.expiresAt);
  assert.equal(partners.rows.get('partnerVipGrants/'+first.id).state,'complete');
});
test('pago exige verificador externo e correspondência exata',async()=>{
  const payout={id:'payout1',partnerUid:'alice',amountCents:300,currency:'BRL'};
  await assert.rejects(verifyPayout(payout,'external123',{url:'',token:''}),{statusCode:503});
  const response={ok:true,async json(){return {status:'confirmed',payoutId:'payout1',partnerUid:'alice',
    amountCents:300,currency:'BRL',paymentId:'external123',confirmedAt:2000000000000,provider:'verified'}}};
  const proof=await verifyPayout(payout,'external123',{url:'https://payments.example.com/verify',
    token:'private-test-token',fetch:async()=>response});
  assert.equal(proof.paymentId,'external123');
  await assert.rejects(verifyPayout(payout,'external999',{url:'https://payments.example.com/verify',
    token:'private-test-token',fetch:async()=>response}),{statusCode:409});
});
