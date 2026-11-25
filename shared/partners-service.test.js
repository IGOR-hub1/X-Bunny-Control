'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createService}=require('./partners-service');

function memory(initial={}){
  const values=new Map(Object.entries(initial)),calls=[];
  return {calls,values,async request(path,method='GET',value,etag,query){
    calls.push({path,method,query});
    if(method==='GET'){
      let result=values.get(path)??null;
      if(query&&result){let rows=Object.entries(result).sort(([a],[b])=>a<b?-1:a>b?1:0);
        if(query.startAt)rows=rows.filter(([key])=>key>=query.startAt);
        if(query.endAt)rows=rows.filter(([key])=>key<=query.endAt);
        rows=query.limitToLast?rows.slice(-query.limitToLast):rows.slice(0,query.limitToFirst);
        result=Object.fromEntries(rows);}
      return {value:result,etag:'"v1"'};
    }
    if(method==='PUT'){
      if(etag==='null_etag'&&values.has(path))return {conflict:true};
      values.set(path,value);return {value};
    }
    if(method==='PATCH'){
      for(const [key,item] of Object.entries(value))values.set(key,item);
      return {value};
    }
    throw new Error('Método inesperado.');
  }};
}
function setup(role='partners',extra={}){
  const main=memory({'admins/root':true,'users/alice':{plan:'Free'}});
  const partners=memory({'partners/alice':{uid:'alice',label:'Alice',status:'approved',createdAt:1,
      permissions:{canCreateLinks:true,canViewFinancials:true}},
    'partners/bob':{uid:'bob',label:'Bob',status:'approved',createdAt:2},
    'controlAdmins/root':true,
    'partners':{alice:{uid:'alice',label:'Alice',status:'approved'},bob:{uid:'bob',label:'Bob',status:'approved'}},
    'byPartner/links/alice':{ALICE01:{code:'ALICE01',partnerUid:'alice',status:'draft'}},
    'byPartner/links/bob':{BOB00001:{code:'BOB00001',partnerUid:'bob',status:'draft'}}});
  let sequence=0;
  const service=createService({stores:{main,partners},role,verify:async req=>({sub:req.uid,firebase:req.firebase}),
    now:()=>1000,random:()=> 'id'+String(++sequence).padStart(8,'0'),...extra});
  return {main,partners,service};
}
test('divulgador não lê relatório de outro UID e consultas ficam no seu índice',async()=>{
  const {partners,service}=setup();
  await assert.rejects(service.report({uid:'alice'},{uid:'bob'}),error=>error.statusCode===403);
  const result=await service.report({uid:'alice'},{limit:20});
  assert.equal(result.partner.uid,'alice');
  assert.equal(result.links[0].code,'ALICE01');
  assert.ok(partners.calls.every(call=>!call.path.includes('/bob')));
  assert.ok(partners.calls.filter(call=>call.query).every(call=>call.query.limitToFirst<=21));
});
test('dashboard lê agregados, plano principal e saldo apenas do próprio UID',async()=>{
  const {partners,service}=setup();
  partners.values.set('reports/partners/alice/totals',{clicks:12,uniqueVisitorsEstimated:9,
    confirmedPurchases:2,couponRedemptions:3,freeDaysRedemptions:1,
    commissionPendingCents:1500,commissionApprovedCents:500});
  partners.values.set('settings/program',{currency:'BRL',payoutsEnabled:true});
  partners.values.set('financeState/alice',{ledgerVerified:true,currency:'BRL',approvedCents:500,reservedCents:100});
  const result=await service.report({uid:'alice'},{});
  assert.equal(result.totals.uniqueVisitorsEstimated,9);
  assert.equal(result.totals.confirmedPurchases,2);
  assert.equal(result.accountBenefits.plan,'Free');
  assert.equal(result.finance.availableCents,400);
  assert.equal(result.finance.canRequestPayout,true);
  assert.ok(!partners.calls.some(call=>call.path.includes('/bob')));
});
test('admin depende do marcador no Firebase principal e lista paginada',async()=>{
  const {main,partners,service}=setup('control');
  await assert.rejects(service.adminData({uid:'alice'},{}),error=>error.statusCode===403);
  const data=await service.adminData({uid:'root'},{limit:1});
  assert.equal(data.partners.length,1);
  assert.equal(data.nextCursor,'alice');
  assert.equal(partners.calls.find(call=>call.path==='partners').query.limitToFirst,2);
  assert.equal(main.calls.at(-1).path,'admins/root');
});
test('mutação administrativa é recusada antes de escrever no Partners',async()=>{
  const {partners,service}=setup('control');
  await assert.rejects(service.create({uid:'alice'},{uid:'bob',label:'Bob'}),error=>error.statusCode===403);
  assert.equal(partners.calls.length,0);
});
test('cadastro consulta conta principal e grava só no Firebase Partners',async()=>{
  const {main,partners,service}=setup('control');
  const result=await service.create({uid:'root'},{uid:'new',label:'Nova'}).catch(error=>error);
  assert.equal(result.statusCode,404);
  assert.ok(main.calls.some(call=>call.path==='users/new'));
  assert.ok(!main.calls.some(call=>call.method!=='GET'));
  assert.ok(!partners.calls.some(call=>call.path.startsWith('commissions')||call.path.startsWith('payouts')));
});
test('saques exigem habilitação administrativa',async()=>{
  const {partners,service}=setup();
  await assert.rejects(service.payout({uid:'alice'},{amountCents:1000,requestId:'pedido_123456'}),error=>error.statusCode===403);
  assert.ok(!partners.calls.some(call=>call.method!=='GET'));
});
test('saque reserva apenas saldo verificado, respeita UID e é idempotente',async()=>{
  const {partners,service}=setup();
  partners.values.set('settings/program',{payoutsEnabled:true,currency:'BRL'});
  await assert.rejects(service.payout({uid:'alice'},{amountCents:1000,requestId:'pedido_123456'}),error=>error.statusCode===409);
  partners.values.set('financeState/alice',{ledgerVerified:true,currency:'BRL',approvedCents:3000,reservedCents:0});
  const first=await service.payout({uid:'alice'},{amountCents:1000,requestId:'pedido_123456'});
  assert.equal(first.payout.status,'requested');
  assert.equal(partners.values.get('financeState/alice').reservedCents,1000);
  const again=await service.payout({uid:'alice'},{amountCents:1000,requestId:'pedido_123456'});
  assert.equal(again.payout.id,first.payout.id);
  assert.equal(partners.values.get('financeState/alice').reservedCents,1000);
  await assert.rejects(service.payout({uid:'alice'},{amountCents:2500,requestId:'pedido_999999'}),error=>error.statusCode===409);
  assert.ok(!partners.calls.some(call=>call.path.includes('/bob')));
});
test('criação de cupons pelo divulgador exige permissão e permanece inativa',async()=>{
  const {partners,service}=setup();
  partners.values.set('byPartner/campaigns/alice/c1',{id:'c1',name:'Campanha',status:'active',expiresAt:1000+20*86400000});
  const body={campaignId:'c1',discountPercent:5,maxUses:3,expiresAt:1000+10*86400000};
  await assert.rejects(service.myCoupon({uid:'alice'},body),error=>error.statusCode===403);
  partners.values.get('partners/alice').permissions.canIssueCoupons=true;
  const result=await service.myCoupon({uid:'alice'},body);
  assert.equal(result.coupon.partnerUid,'alice');
  assert.equal(result.coupon.active,false);
  assert.equal(result.coupon.status,'draft');
});
test('dias grátis exigem permissão e limite do benefício',async()=>{
  const {partners,service}=setup();
  partners.values.set('byPartner/campaigns/alice/c1',{id:'c1',name:'Campanha',status:'active',expiresAt:1000+20*86400000});
  const body={campaignId:'c1',freeDays:3,maxUses:2,expiresAt:1000+10*86400000,uid:'bob'};
  partners.values.get('partners/alice').permissions.canIssueFreeDaysCodes=true;
  await assert.rejects(service.myFreeDaysCode({uid:'alice'},body),error=>error.statusCode===403);
  partners.values.get('partners/alice').benefits={freeDaysCodeLimit:1};
  const result=await service.myFreeDaysCode({uid:'alice'},body);
  assert.equal(result.freeDaysCode.partnerUid,'alice');
  assert.equal(result.freeDaysCode.active,false);
  assert.ok(!partners.calls.some(call=>call.path.includes('/bob')));
});
test('link do divulgador fica em rascunho e só usa seu UID',async()=>{
  const {partners,service}=setup();
  partners.values.set('settings/program',{allowPartnerLinks:true});
  const result=await service.myLink({uid:'alice'},{});
  assert.equal(result.link.partnerUid,'alice');
  assert.equal(result.link.active,false);
  assert.equal(result.link.status,'draft');
  assert.ok(partners.values.has(`byPartner/links/alice/${result.link.code}`));
  assert.ok(!partners.calls.some(call=>call.path.includes('/bob')));
});
test('Admin Supremo exige autorização explícita no Partners',async()=>{
  const {partners,service}=setup('control');
  partners.values.delete('controlAdmins/root');
  await assert.rejects(service.adminData({uid:'root'},{}),error=>error.statusCode===403);
});
test('admin não altera as próprias permissões e mudanças de terceiros são auditadas',async()=>{
  const {partners,service}=setup('control');
  await assert.rejects(service.partnerAccess({uid:'root'},{uid:'root'}),error=>error.statusCode===403);
  const result=await service.partnerAccess({uid:'root'},{uid:'alice',permissions:{canCreateLinks:true,
    canViewFinancials:true},benefits:{commissionBoostPercent:5,freeDaysCodeLimit:2}});
  assert.equal(result.partner.benefits.freeDaysCodeLimit,2);
  assert.ok(partners.calls.some(call=>call.path.startsWith('audit/')&&call.value===undefined));
});
test('cupom e dias grátis têm validade, limite e permanecem inativos',async()=>{
  const {partners,service}=setup('control');
  const campaign=(await service.createCampaign({uid:'root'},{uid:'alice',name:'Lançamento',
    expiresAt:1000+20*86400000,commissionPercent:12,maxUses:50})).campaign;
  const coupon=(await service.couponCreate({uid:'root'},{uid:'alice',campaignId:campaign.id,
    discountPercent:15,maxUses:10,expiresAt:1000+10*86400000})).coupon;
  const days=(await service.freeDaysCodeCreate({uid:'root'},{uid:'alice',campaignId:campaign.id,
    freeDays:7,maxUses:5,expiresAt:1000+10*86400000})).freeDaysCode;
  assert.equal(coupon.firstPurchaseOnly,true);
  assert.equal(days.freeDays,7);
  assert.equal(coupon.active,false);
  assert.equal(days.active,false);
  assert.ok(partners.values.has('codeRegistry/'+coupon.code));
  assert.ok(partners.values.has('codeRegistry/'+days.code));
});
test('somente Admin Supremo ativa cupom com plano e campanha permitidos',async()=>{
  const {service,partners}=setup('control');
  const campaign=(await service.createCampaign({uid:'root'},{uid:'alice',name:'Primeira compra',
    allowedPlans:'plus',expiresAt:1000+20*86400000,maxUses:10,commissionPercent:12})).campaign;
  const coupon=(await service.couponCreate({uid:'root'},{uid:'alice',campaignId:campaign.id,
    discountPercent:10,allowedPlans:'plus',maxUses:5,expiresAt:1000+10*86400000})).coupon;
  await assert.rejects(service.codeUpdate({uid:'alice'},{kind:'coupon',code:coupon.code,status:'active',
    expiresAt:coupon.expiresAt,maxUses:5}),error=>error.statusCode===403);
  const active=(await service.codeUpdate({uid:'root'},{kind:'coupon',code:coupon.code,status:'active',
    allowedPlans:'plus',expiresAt:coupon.expiresAt,maxUses:5})).code;
  assert.equal(active.active,true);
  assert.deepEqual(active.allowedPlans,['plus']);
  assert.equal(partners.values.get('coupons/'+coupon.code).status,'active');
});
test('Admin Supremo ativa código de dias grátis apenas em campanha VIP',async()=>{
  const {service,partners}=setup('control');
  const campaign=(await service.createCampaign({uid:'root'},{uid:'alice',name:'VIP promocional',
    allowedPlans:'vip',expiresAt:1000+20*86400000,maxUses:10})).campaign;
  const days=(await service.freeDaysCodeCreate({uid:'root'},{uid:'alice',campaignId:campaign.id,
    freeDays:3,maxUses:5,expiresAt:1000+10*86400000})).freeDaysCode;
  await assert.rejects(service.codeUpdate({uid:'alice'},{kind:'freeDays',code:days.code,
    status:'active',expiresAt:days.expiresAt,maxUses:5}),{statusCode:403});
  const active=(await service.codeUpdate({uid:'root'},{kind:'freeDays',code:days.code,
    status:'active',expiresAt:days.expiresAt,maxUses:5})).code;
  assert.equal(active.active,true);
  assert.equal(partners.values.get('freeDaysCodes/'+days.code).freeDays,3);
});
test('aprovação financeira exige origem ou reserva verificada e grava autor',async()=>{
  const {partners,service}=setup('control');
  partners.values.set('commissions/c1',{id:'c1',partnerUid:'alice',status:'pending',amount:10,
    currency:'BRL',sourceId:'purchase_1',sourceVerified:false});
  await assert.rejects(service.financialAction({uid:'root'},{kind:'commission',id:'c1',decision:'approved'}),
    error=>error.statusCode===409);
  partners.values.set('commissions/c1',{id:'c1',partnerUid:'alice',status:'pending',amount:10,
    currency:'BRL',sourceId:'purchase_1',sourceVerified:true});
  const result=await service.financialAction({uid:'root'},{kind:'commission',id:'c1',decision:'approved'});
  assert.equal(result.record.status,'approved');
  assert.equal(partners.values.get('commissions/c1').decisionBy,'root');
  await assert.rejects(service.financialAction({uid:'root'},{kind:'commission',id:'c1',decision:'approved'}),
    error=>error.statusCode===409);
});
test('decisão de comissão Pix move agregados uma vez',async()=>{
  const {partners,service}=setup('control');
  partners.values.set('commissions/c1',{id:'c1',partnerUid:'alice',status:'pending',amount:3.58,
    amountCents:358,currency:'BRL',sourceId:'order1',sourceVerified:true,createdBy:'mercado-pago-verified'});
  partners.values.set('reports/partners/alice/totals',{commissionPendingCents:358});
  partners.values.set('reports/global/totals',{commissionPendingCents:358});
  await service.financialAction({uid:'root'},{kind:'commission',id:'c1',decision:'approved'});
  await service.financialAction({uid:'root'},{kind:'commission',id:'c1',decision:'approved'});
  assert.equal(partners.values.get('reports/partners/alice/totals').commissionPendingCents,0);
  assert.equal(partners.values.get('reports/partners/alice/totals').commissionApprovedCents,358);
  assert.equal(partners.values.get('reports/global/totals').commissionApprovedCents,358);
});
test('MFA pode ser exigido no backend do Admin Supremo',async()=>{
  const {service}=setup('control',{requireMfa:true});
  await assert.rejects(service.adminData({uid:'root'},{}),error=>error.statusCode===403);
  const result=await service.adminData({uid:'root',firebase:{sign_in_second_factor:'phone'}},{});
  assert.ok(Array.isArray(result.partners));
});
test('campanha altera comissão com versão e código pode ser pausado',async()=>{
  const {partners,service}=setup('control');
  const campaign=(await service.createCampaign({uid:'root'},{uid:'alice',name:'Campanha',
    expiresAt:1000+20*86400000,commissionPercent:10,maxUses:30})).campaign;
  const updated=(await service.campaignUpdate({uid:'root'},{id:campaign.id,commissionPercent:12,
    expiresAt:campaign.expiresAt,maxUses:30})).campaign;
  assert.equal(updated.rulesVersion,2);
  const coupon=(await service.couponCreate({uid:'root'},{uid:'alice',campaignId:campaign.id,
    discountPercent:10,maxUses:5,expiresAt:1000+10*86400000})).coupon;
  const paused=(await service.codeUpdate({uid:'root'},{kind:'coupon',code:coupon.code,status:'paused',
    expiresAt:coupon.expiresAt,maxUses:5})).code;
  assert.equal(paused.active,false);
  assert.equal(paused.status,'paused');
  assert.equal(partners.values.get('byPartner/coupons/alice/'+coupon.code).status,'paused');
});
test('saque aprovado exige reserva e rejeição registra conciliação pendente',async()=>{
  const {partners,service}=setup('control');
  partners.values.set('payouts/p1',{id:'p1',partnerUid:'alice',status:'requested',amount:25,
    currency:'BRL',reservationId:'reserve_1',balanceReserved:false});
  await assert.rejects(service.financialAction({uid:'root'},{kind:'payout',id:'p1',decision:'approved'}),
    error=>error.statusCode===409);
  partners.values.set('payouts/p1',{id:'p1',partnerUid:'alice',status:'requested',amount:25,
    currency:'BRL',reservationId:'reserve_1',balanceReserved:true});
  const result=await service.financialAction({uid:'root'},{kind:'payout',id:'p1',decision:'rejected'});
  assert.equal(result.record.reservationReleasePending,true);
  assert.equal(partners.values.get('payouts/p1').decisionBy,'root');
});
test('saque pago exige confirmação externa vinculada e move saldo uma vez',async()=>{
  let checks=0;
  const {partners,service}=setup('control',{verifyPayout:async(record,reference)=>{
    checks++;assert.equal(record.id,'payout1');assert.equal(reference,'transfer123');
    return {paymentId:'transfer123',confirmedAt:2000000000000,provider:'teste'};
  }});
  partners.values.set('payouts/payout1',{id:'payout1',partnerUid:'alice',status:'approved',
    amount:3,amountCents:300,currency:'BRL',balanceReserved:true,reservationId:'payout1'});
  partners.values.set('financeState/alice',{ledgerVerified:true,currency:'BRL',approvedCents:500,
    reservedCents:300,ledgerEntries:{payout1:{id:'payout1',kind:'reserve',amountCents:300}}});
  const first=await service.confirmPayout({uid:'root'},{id:'payout1',externalReference:'transfer123'});
  assert.equal(first.payout.status,'paid');
  assert.equal(partners.values.get('financeState/alice').paidCents,300);
  assert.equal(partners.values.get('financeState/alice').approvedCents,200);
  const again=await service.confirmPayout({uid:'root'},{id:'payout1',externalReference:'transfer123'});
  assert.equal(again.payout.duplicate,true);assert.equal(checks,1);
  partners.values.set('commissions/commission1',{id:'commission1',partnerUid:'alice',status:'approved',
    amount:2,amountCents:200,currency:'BRL'});
  partners.values.set('commissions/commission2',{id:'commission2',partnerUid:'alice',status:'approved',
    amount:2,amountCents:200,currency:'BRL'});
  const paid=await service.allocateCommission({uid:'root'},{payoutId:'payout1',commissionId:'commission1'});
  assert.equal(paid.commission.status,'paid');
  assert.equal(partners.values.get('commissions/commission1').externalPaymentId,'transfer123');
  assert.equal((await service.allocateCommission({uid:'root'},{payoutId:'payout1',commissionId:'commission1'})).commission.duplicate,true);
  await assert.rejects(service.allocateCommission({uid:'root'},{payoutId:'payout1',commissionId:'commission2'}),
    {statusCode:409});
  await assert.rejects(service.confirmPayout({uid:'root'},{id:'payout1',externalReference:'different999'}),
    {statusCode:409});
});
test('Admin Supremo concede VIP ao divulgador uma vez com registro auditável',async()=>{
  const {main,partners,service}=setup('control');
  main.values.set('users/alice',{uid:'alice',plan:'Free',premium:false});
  const first=await service.grantPartnerVip({uid:'root'},{uid:'alice',days:3,requestId:'request_123456'});
  const again=await service.grantPartnerVip({uid:'root'},{uid:'alice',days:3,requestId:'request_123456'});
  assert.equal(first.benefit.days,3);assert.equal(again.benefit.duplicate,true);
  assert.equal(main.values.get('users/alice').premium,true);
  assert.ok(partners.values.has('byPartner/vipBenefits/alice/'+first.benefit.id));
  assert.ok([...partners.values.values()].some(value=>value?.action==='partner.vip.grant'));
});
test('histórico administrativo retorna eventos recentes de forma paginada',async()=>{
  const {partners,service}=setup('control');
  partners.values.set('audit',{
    '0000000001000_a':{actorUid:'root',action:'one',target:'a',at:1000},
    '0000000001001_b':{actorUid:'root',action:'two',target:'b',at:1001},
    '0000000001002_c':{actorUid:'root',action:'three',target:'c',at:1002}
  });
  const first=await service.auditList({uid:'root'},{limit:2});
  assert.deepEqual(first.events.map(event=>event.action),['three','two']);
  assert.equal(first.nextCursor,'0000000001001_b');
  const second=await service.auditList({uid:'root'},{limit:2,cursor:first.nextCursor});
  assert.deepEqual(second.events.map(event=>event.action),['one']);
});
test('limites e validade são validados antes de criar benefícios',async()=>{
  const {service}=setup('control');
  const campaign=(await service.createCampaign({uid:'root'},{uid:'alice',name:'Teste',
    expiresAt:1000+20*86400000})).campaign;
  await assert.rejects(service.couponCreate({uid:'root'},{uid:'alice',campaignId:campaign.id,
    discountPercent:10,maxUses:0,expiresAt:1000+10*86400000}),error=>error.statusCode===400);
  await assert.rejects(service.freeDaysCodeCreate({uid:'root'},{uid:'alice',campaignId:campaign.id,
    freeDays:31,maxUses:1,expiresAt:1000+10*86400000}),error=>error.statusCode===400);
  await assert.rejects(service.createCampaign({uid:'root'},{uid:'alice',name:'Vencida',expiresAt:999}),
    error=>error.statusCode===400);
});
test('administrador não decide lançamento da própria parceria',async()=>{
  const {partners,service}=setup('control');
  partners.values.set('commissions/own',{id:'own',partnerUid:'root',status:'pending',
    amount:10,currency:'BRL',sourceId:'purchase_self',sourceVerified:true});
  await assert.rejects(service.financialAction({uid:'root'},
    {kind:'commission',id:'own',decision:'approved'}),error=>error.statusCode===403);
});
