'use strict';
const crypto=require('node:crypto');
const {createProjectStores}=require('./firebase-projects');
const {verifyFirebaseRequest}=require('./firebase-auth');
const finance=require('./finance-ledger');
const {createGranter}=require('./partner-vip');
const {verifyPayout}=require('./payout-verifier');

const uidPattern=/^[A-Za-z0-9_-]{1,128}$/;
const keyPattern=/^[A-Za-z0-9_-]{1,160}$/;
const codePattern=/^[A-Z0-9]{6,20}$/;
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const clean=value=>String(value??'').trim();
const bounded=(value,max)=>clean(value).slice(0,max);
const amount=(value,max=100)=>{
  const number=Number(value);
  if(!Number.isFinite(number)||number<0||number>max||Math.abs(Math.round(number*100)-number*100)>1e-7)
    throw fail('Valor numérico inválido.');
  return number;
};
const integer=(value,min,max)=>{
  const number=Number(value);
  if(!Number.isInteger(number)||number<min||number>max)throw fail('Limite inválido.');
  return number;
};
function planList(value,fallback=['vip','plus']){
  const plans=value===undefined?fallback:Array.isArray(value)?value:
    clean(value)==='vip'?['vip']:clean(value)==='plus'?['plus']:
    clean(value)==='both'?['vip','plus']:[];
  if(!plans.length||plans.some(plan=>!['vip','plus'].includes(plan))||new Set(plans).size!==plans.length)
    throw fail('Planos permitidos inválidos.');
  return plans;
}

function createService(options={}){
  const stores=options.stores||createProjectStores();
  const main=stores.main,db=stores.partners;
  const verify=options.verify||verifyFirebaseRequest;
  const now=options.now||Date.now;
  const random=options.random||(()=>crypto.randomBytes(12).toString('base64url'));
  const requireMfa=options.requireMfa===undefined?process.env.CONTROL_REQUIRE_MFA==='true':options.requireMfa===true;
  const payoutVerifier=options.verifyPayout||verifyPayout;
  const read=async(store,path)=>(await store.request(path)).value;
  const role=options.role||'partners';

  async function identity(req){
    const user=await verify(req);
    if(!uidPattern.test(user.sub))throw fail('UID inválido.',401);
    return user;
  }
  async function admin(req){
    const user=await identity(req);
    if(await read(main,'admins/'+user.sub)!==true)throw fail('Admin Supremo obrigatório.',403);
    if(await read(db,'controlAdmins/'+user.sub)!==true)throw fail('Acesso ao X-Bunny Control não autorizado.',403);
    if(requireMfa&&!user.firebase?.sign_in_second_factor)
      throw fail('Autenticação multifator obrigatória para este painel.',403);
    return user;
  }
  async function audit(actor,action,target,before,after){
    const at=now(),id=String(at).padStart(13,'0')+'_'+random();
    const record={id,actorUid:actor.sub,action,target,at,before:before||null,after:after||null};
    await db.request('audit/'+id,'PUT',record,'null_etag');
    return record;
  }
  async function ownPartner(req,active=false){
    const user=await identity(req);
    const partner=await read(db,'partners/'+user.sub);
    if(!partner||!['approved','suspended'].includes(partner.status))throw fail('Parceria não autorizada.',403);
    if(active&&partner.status!=='approved')throw fail('Parceria suspensa.',403);
    return {user,partner};
  }
  function pageSize(value){
    const number=Number(value??20);
    if(!Number.isInteger(number)||number<1||number>50)throw fail('Limite deve estar entre 1 e 50.');
    return number;
  }
  async function page(path,cursor,requested=20){
    const limit=pageSize(requested);
    const after=clean(cursor);
    if(after&&!keyPattern.test(after))throw fail('Cursor inválido.');
    const query={orderBy:'$key',limitToFirst:limit+(after?2:1)};
    if(after)query.startAt=after;
    const value=(await db.request(path,'GET',undefined,undefined,query)).value||{};
    const sorted=Object.entries(value).filter(([id])=>!after||id>after).sort(([a],[b])=>a<b?-1:a>b?1:0);
    const entries=sorted.slice(0,limit).map(([id,record])=>({id,...record}));
    return {items:entries,nextCursor:sorted.length>limit?entries.at(-1).id:null};
  }
  async function recentPage(path,cursor,requested=20){
    const limit=pageSize(requested),before=clean(cursor);
    if(before&&!keyPattern.test(before))throw fail('Cursor inválido.');
    const query={orderBy:'$key',limitToLast:limit+(before?2:1)};
    if(before)query.endAt=before;
    const value=(await db.request(path,'GET',undefined,undefined,query)).value||{};
    const sorted=Object.entries(value).filter(([id])=>!before||id<before).sort(([a],[b])=>a>b?-1:a<b?1:0);
    const entries=sorted.slice(0,limit).map(([id,record])=>({id,...record}));
    return {items:entries,nextCursor:sorted.length>limit?entries.at(-1).id:null};
  }
  function ownerPage(name,uid,cursor,limit){return page(`byPartner/${name}/${uid}`,cursor,limit);}
  function assertOwner(partner){
    if(!partner||partner.status!=='approved')throw fail('Divulgador não aprovado.',403);
  }
  async function settingsRead(){return await read(db,'settings/program')||{};}
  function validity(body,defaults={},allowExpired=false){
    const start=body.startsAt===undefined?Number(defaults.startsAt)||now():Number(body.startsAt);
    const end=body.expiresAt===undefined?Number(defaults.expiresAt)||now()+30*86400000:Number(body.expiresAt);
    const maxUses=body.maxUses===undefined?Number(defaults.maxUses)||0:integer(body.maxUses,0,100000);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||
      body.startsAt!==undefined&&start<now()-86400000||
      !allowExpired&&end<=now()||end<=start||end>now()+2*365*86400000)throw fail('Validade inválida.');
    return {startsAt:start,expiresAt:end,maxUses};
  }
  async function adminData(req,body={}){
    await admin(req);
    const [partners,totals,settings]=await Promise.all([
      page('partners',body.cursor,body.limit),read(db,'reports/global/totals'),settingsRead()
    ]);
    return {partners:partners.items,nextCursor:partners.nextCursor,totals:safeTotals(totals),settings:{
      allowPartnerLinks:settings.allowPartnerLinks===true,
      commissionDescription:bounded(settings.commissionDescription,300),
      currency:/^[A-Z]{3}$/.test(settings.currency||'')?settings.currency:'BRL',
      payoutsEnabled:settings.payoutsEnabled===true
    },financialOperationsAvailable:true};
  }
  async function list(req){return adminData(req,{});}
  async function create(req,body){
    const actor=await admin(req),uid=clean(body.uid),label=bounded(body.label,80);
    if(!uidPattern.test(uid)||!label)throw fail('Informe UID e nome válidos.');
    if(!await read(main,'users/'+uid))throw fail('Conta principal não encontrada.',404);
    const record={uid,label,status:'pending',createdAt:now(),updatedAt:now(),createdBy:actor.sub,
      permissions:{canCreateLinks:false,canViewFinancials:true,canIssueCoupons:false,canIssueFreeDaysCodes:false},
      benefits:{commissionBoostPercent:0,freeDaysCodeLimit:0}};
    const result=await db.request('partners/'+uid,'PUT',record,'null_etag');
    if(result.conflict)throw fail('Parceiro já cadastrado.',409);
    await audit(actor,'partner.create',uid,null,{status:'pending',label});
    return {partner:record};
  }
  async function status(req,body){
    const actor=await admin(req);
    const uid=clean(body.uid),next=clean(body.status);
    if(!uidPattern.test(uid)||!['approved','suspended','removed'].includes(next))throw fail('Status inválido.');
    const versioned=await db.request('partners/'+uid,'GET',undefined,true);
    const current=versioned.value;
    if(!current)throw fail('Parceiro não encontrado.',404);
    if(current.status==='removed')throw fail('Parceiro removido não pode ser reativado.',409);
    const updated={...current,status:next,updatedAt:now(),updatedBy:actor.sub};
    const saved=await db.request('partners/'+uid,'PUT',updated,versioned.etag||'null_etag');
    if(saved.conflict)throw fail('Parceiro alterado por outra operação. Atualize e tente novamente.',409);
    await audit(actor,'partner.status',uid,{status:current.status},{status:next});
    return {partner:updated};
  }
  async function partnerAccess(req,body){
    const actor=await admin(req),uid=clean(body.uid);
    if(!uidPattern.test(uid))throw fail('UID inválido.');
    if(uid===actor.sub)throw fail('Não é permitido alterar o próprio nível de acesso.',403);
    const versioned=await db.request('partners/'+uid,'GET',undefined,true),current=versioned.value;
    if(!current||current.status==='removed')throw fail('Divulgador indisponível.',404);
    const input=body.permissions||{},benefits=body.benefits||{};
    if(typeof input!=='object'||Array.isArray(input)||typeof benefits!=='object'||Array.isArray(benefits))throw fail('Permissões inválidas.');
    const permissions={canCreateLinks:input.canCreateLinks===true,canViewFinancials:input.canViewFinancials===true,
      canIssueCoupons:input.canIssueCoupons===true,canIssueFreeDaysCodes:input.canIssueFreeDaysCodes===true};
    const safeBenefits={commissionBoostPercent:amount(benefits.commissionBoostPercent??0,100),
      fixedPurchaseCents:integer(benefits.fixedPurchaseCents??0,0,1000000),
      freeDaysRewardCents:integer(benefits.freeDaysRewardCents??0,0,1000000),
      freeDaysCodeLimit:integer(benefits.freeDaysCodeLimit??0,0,1000)};
    const updated={...current,permissions,benefits:safeBenefits,updatedAt:now(),updatedBy:actor.sub};
    const saved=await db.request('partners/'+uid,'PUT',updated,versioned.etag||'null_etag');
    if(saved.conflict)throw fail('Divulgador alterado por outra operação. Atualize e tente novamente.',409);
    await audit(actor,'partner.access',uid,{permissions:current.permissions||{},benefits:current.benefits||{}},
      {permissions,benefits:safeBenefits});
    return {partner:updated};
  }
  async function grantPartnerVip(req,body){
    const actor=await admin(req),uid=clean(body.uid),days=integer(body.days,1,365);
    if(!uidPattern.test(uid)||uid===actor.sub)throw fail('Divulgador inválido.',403);
    const partner=await read(db,`partners/${uid}`);
    const requestId=clean(body.requestId);
    if(partner?.status!=='approved'){
      const id='v_'+crypto.createHash('sha256').update(uid+'\0'+requestId).digest('hex').slice(0,40);
      const previous=await read(db,`partnerVipGrants/${id}`);
      if(!previous||previous.uid!==uid||previous.days!==days||previous.actorUid!==actor.sub)
        throw fail('Divulgador não aprovado.',409);
    }
    const result=await createGranter({main,partners:db,now}).grant(uid,days,requestId,actor.sub);
    await audit(actor,'partner.vip.grant',result.id,null,{uid,days,expiresAt:result.expiresAt,duplicate:result.duplicate});
    return {benefit:result};
  }
  async function createCampaign(req,body){
    const actor=await admin(req),uid=clean(body.uid),name=bounded(body.name,80);
    if(!uidPattern.test(uid)||!name)throw fail('Divulgador e campanha obrigatórios.');
    assertOwner(await read(db,'partners/'+uid));
    const dates=validity(body),commissionPercent=amount(body.commissionPercent??0,100),
      fixedSignup=amount(body.fixedSignup??0,10000),
      fixedPurchaseCents=integer(body.fixedPurchaseCents??0,0,1000000),
      freeDaysRewardCents=integer(body.freeDaysRewardCents??0,0,1000000),
      budgetCents=integer(body.budgetCents??0,0,1000000000);
    const id=random(),record={id,partnerUid:uid,name,status:'active',...dates,used:0,
      allowedPlans:planList(body.allowedPlans),
      commissionPercent,fixedSignup,fixedPurchaseCents,freeDaysRewardCents,budgetCents,budgetUsedCents:0,
      rulesVersion:1,createdAt:now(),createdBy:actor.sub,updatedBy:actor.sub};
    await db.request('', 'PATCH',{[`campaigns/${id}`]:record,[`byPartner/campaigns/${uid}/${id}`]:record});
    await audit(actor,'campaign.create',id,null,{partnerUid:uid,name,commissionPercent,fixedSignup,
      fixedPurchaseCents,freeDaysRewardCents,budgetCents,...dates});
    return {campaign:record};
  }
  async function campaignUpdate(req,body){
    const actor=await admin(req),id=clean(body.id);
    if(!keyPattern.test(id))throw fail('Campanha inválida.');
    const versioned=await db.request('campaigns/'+id,'GET',undefined,true),current=versioned.value;
    if(!current)throw fail('Campanha não encontrada.',404);
    const status=clean(body.status||current.status);
    if(!['active','paused','ended'].includes(status)||current.status==='ended'&&status!=='ended')throw fail('Transição inválida.');
    const dates=validity(body,current,status==='ended');
    if(dates.maxUses>0&&dates.maxUses<Number(current.used||0))throw fail('Limite menor que os usos existentes.');
    const reserved=Object.values(current.reservations||{}).filter(value=>value==='reserved').length;
    if(dates.maxUses>0&&dates.maxUses<Number(current.used||0)+reserved)
      throw fail('Limite menor que os usos ou reservas existentes.');
    const commissionPercent=amount(body.commissionPercent??current.commissionPercent??0,100);
    const fixedSignup=amount(body.fixedSignup??current.fixedSignup??0,10000);
    const fixedPurchaseCents=integer(body.fixedPurchaseCents??current.fixedPurchaseCents??0,0,1000000);
    const freeDaysRewardCents=integer(body.freeDaysRewardCents??current.freeDaysRewardCents??0,0,1000000);
    const budgetCents=integer(body.budgetCents??current.budgetCents??0,0,1000000000);
    if(budgetCents>0&&budgetCents<Number(current.budgetUsedCents||0))throw fail('Orçamento menor que o comprometido.');
    const ruleChanged=commissionPercent!==Number(current.commissionPercent||0)||fixedSignup!==Number(current.fixedSignup||0)||
      fixedPurchaseCents!==Number(current.fixedPurchaseCents||0)||freeDaysRewardCents!==Number(current.freeDaysRewardCents||0);
    const updated={...current,name:bounded(body.name??current.name,80),status,...dates,
      allowedPlans:planList(body.allowedPlans,current.allowedPlans||['vip','plus']),
      commissionPercent,fixedSignup,fixedPurchaseCents,freeDaysRewardCents,budgetCents,
      rulesVersion:Number(current.rulesVersion||1)+(ruleChanged?1:0),
      updatedAt:now(),updatedBy:actor.sub};
    if(!updated.name)throw fail('Nome obrigatório.');
    const saved=await db.request('campaigns/'+id,'PUT',updated,versioned.etag||'null_etag');
    if(saved.conflict)throw fail('Campanha alterada por outra operação.',409);
    await db.request(`byPartner/campaigns/${current.partnerUid}/${id}`,'PUT',updated);
    await audit(actor,'campaign.update',id,{status:current.status,commissionPercent:current.commissionPercent,
      fixedSignup:current.fixedSignup,fixedPurchaseCents:current.fixedPurchaseCents,
      freeDaysRewardCents:current.freeDaysRewardCents,budgetCents:current.budgetCents,
      expiresAt:current.expiresAt,maxUses:current.maxUses},
      {status,commissionPercent,fixedSignup,fixedPurchaseCents,freeDaysRewardCents,budgetCents,
        expiresAt:dates.expiresAt,maxUses:dates.maxUses});
    return {campaign:updated};
  }
  async function issueCode(req,body,kind,self=false){
    const actor=self?(await ownPartner(req,true)).user:await admin(req);
    const uid=self?actor.sub:clean(body.uid);
    if(!uidPattern.test(uid))throw fail('UID inválido.');
    const partner=await read(db,'partners/'+uid);
    assertOwner(partner);
    const root={link:'links',coupon:'coupons',freeDays:'freeDaysCodes'}[kind];
    if(!root)throw fail('Tipo de código inválido.');
    const settings=await settingsRead();
    if(self&&kind==='link'&&settings.allowPartnerLinks!==true)throw fail('Criação de links desabilitada.',403);
    const permission={link:'canCreateLinks',coupon:'canIssueCoupons',freeDays:'canIssueFreeDaysCodes'}[kind];
    if(self&&partner.permissions?.[permission]!==true)throw fail('Permissão para criar este código não concedida.',403);
    if(self){
      const limit=kind==='freeDays'?Math.min(20,integer(partner.benefits?.freeDaysCodeLimit??0,0,1000)):20;
      if(limit===0)throw fail('Limite de códigos não concedido.',403);
      const existing=await ownerPage(root,uid,null,Math.min(limit,50));
      if(existing.items.length>=limit)throw fail('Limite de códigos do divulgador atingido.',409);
    }
    const campaignId=clean(body.campaignId);
    let campaign=null;
    if(campaignId){
      if(!keyPattern.test(campaignId))throw fail('Campanha inválida.');
      campaign=await read(db,`byPartner/campaigns/${uid}/${campaignId}`);
      if(!campaign||campaign.status!=='active')throw fail('Campanha indisponível.',404);
    }
    if(kind!=='link'&&!campaign)throw fail('Campanha obrigatória para benefícios.',400);
    const custom=clean(body.code).toUpperCase();
    if(self&&custom)throw fail('Código personalizado exige aprovação administrativa.',403);
    if(custom&&!codePattern.test(custom))throw fail('Código inválido.');
    const code=custom||crypto.randomBytes(6).toString('hex').toUpperCase();
    const dates=validity(body,{expiresAt:campaign?.expiresAt||now()+30*86400000});
    if(campaign&&dates.expiresAt>Number(campaign.expiresAt))throw fail('Código não pode vencer depois da campanha.');
    if(kind!=='link'&&dates.maxUses===0)throw fail('Defina um limite de usos para o benefício.');
    const allowedPlans=kind==='coupon'?planList(body.allowedPlans,
      Array.isArray(campaign?.allowedPlans)?campaign.allowedPlans:['vip','plus']):undefined;
    if(kind==='coupon'&&campaign?.allowedPlans&&allowedPlans.some(plan=>!campaign.allowedPlans.includes(plan)))
      throw fail('Plano não permitido pela campanha.');
    const extra=kind==='coupon'?{firstPurchaseOnly:true,perUserLimit:1,allowedPlans,
      discountPercent:amount(body.discountPercent,100)}:
      kind==='freeDays'?{perUserLimit:1,freeDays:integer(body.freeDays,1,30)}:{};
    if(kind==='coupon'&&extra.discountPercent===0)throw fail('Desconto deve ser maior que zero.');
    const record={code,kind,partnerUid:uid,campaignId:campaignId||null,campaign:campaign?.name||'Geral',
      status:'draft',active:false,...dates,used:0,...extra,createdAt:now(),createdBy:actor.sub};
    const reservation=await db.request(`codeRegistry/${code}`,'PUT',{kind,partnerUid:uid,createdAt:now()},'null_etag');
    if(reservation.conflict)throw fail('Código já utilizado.',409);
    await db.request('','PATCH',{[`${root}/${code}`]:record,[`byPartner/${root}/${uid}/${code}`]:record});
    await audit(actor,`${kind}.create`,code,null,{partnerUid:uid,campaignId,expiresAt:dates.expiresAt,
      maxUses:dates.maxUses,...extra});
    return kind==='coupon'?{coupon:record}:kind==='freeDays'?{freeDaysCode:record}:{link:record};
  }
  async function link(req,body){return issueCode(req,body,'link');}
  async function myLink(req,body){return issueCode(req,body,'link',true);}
  async function myCoupon(req,body){return issueCode(req,body,'coupon',true);}
  async function myFreeDaysCode(req,body){return issueCode(req,body,'freeDays',true);}
  async function couponCreate(req,body){return issueCode(req,body,'coupon');}
  async function freeDaysCodeCreate(req,body){return issueCode(req,body,'freeDays');}
  async function codeUpdate(req,body){
    const actor=await admin(req),kind=clean(body.kind),code=clean(body.code).toUpperCase();
    const root={link:'links',coupon:'coupons',freeDays:'freeDaysCodes'}[kind];
    if(!root||!codePattern.test(code))throw fail('Código inválido.');
    const versioned=await db.request(`${root}/${code}`,'GET',undefined,true),current=versioned.value;
    if(!current)throw fail('Código não encontrado.',404);
    const status=clean(body.status||current.status);
    const allowedPlans=kind==='coupon'?planList(body.allowedPlans,current.allowedPlans||['vip','plus']):undefined;
    if(!['draft','active','paused','retired'].includes(status)||
      status==='active'&&!['coupon','freeDays'].includes(kind)||current.status==='retired'&&status!=='retired')
      throw fail('Transição de código inválida.');
    const dates=validity(body,current,status==='retired');
    if(dates.maxUses>0&&dates.maxUses<Number(current.used||0))throw fail('Limite menor que os usos existentes.');
    const reserved=Object.values(current.reservations||{}).filter(value=>value==='reserved').length;
    if(dates.maxUses>0&&dates.maxUses<Number(current.used||0)+reserved)
      throw fail('Limite menor que os usos ou reservas existentes.');
    if(status==='active'){
      const campaign=await read(db,`campaigns/${current.campaignId}`);
      if(!campaign||campaign.partnerUid!==current.partnerUid||campaign.status!=='active'||
        Number(campaign.startsAt)>now()||Number(campaign.expiresAt)<=now())
        throw fail('Campanha indisponível para ativação.',409);
      const partner=await read(db,`partners/${current.partnerUid}`);
      if(partner?.status!=='approved')throw fail('Divulgador não aprovado.',409);
      if(kind==='coupon'&&campaign.allowedPlans&&allowedPlans.some(plan=>!campaign.allowedPlans.includes(plan)))
        throw fail('Plano não permitido pela campanha.',409);
      if(kind==='freeDays'&&campaign.allowedPlans&&!campaign.allowedPlans.includes('vip'))
        throw fail('Campanha não permite benefício VIP.',409);
      if(kind==='coupon'&&(current.firstPurchaseOnly!==true||!Number.isFinite(Number(current.discountPercent))||
        Number(current.discountPercent)<=0||!Array.isArray(allowedPlans)||
        !allowedPlans.length||allowedPlans.some(plan=>!['vip','plus'].includes(plan))||
        dates.maxUses<1||dates.maxUses>1000||
        Number(campaign.maxUses)>1000))
        throw fail('Cupom exige primeira compra, planos válidos e limite de até 1000 usos.',409);
      if(kind==='freeDays'&&(!Number.isInteger(Number(current.freeDays))||
        Number(current.freeDays)<1||Number(current.freeDays)>30||current.perUserLimit!==1||
        dates.maxUses<1||dates.maxUses>1000||Number(campaign.maxUses)>1000))
        throw fail('Dias grátis exigem 1 a 30 dias e limite de até 1000 resgates.',409);
    }
    const updated={...current,status,active:status==='active',...dates,
      ...(kind==='coupon'?{allowedPlans}:{}),updatedAt:now(),updatedBy:actor.sub};
    const saved=await db.request(`${root}/${code}`,'PUT',updated,versioned.etag||'null_etag');
    if(saved.conflict)throw fail('Código alterado por outra operação.',409);
    await db.request(`byPartner/${root}/${current.partnerUid}/${code}`,'PUT',updated);
    await audit(actor,`${kind}.update`,code,{status:current.status,expiresAt:current.expiresAt,
      maxUses:current.maxUses,allowedPlans:current.allowedPlans},
      {status,expiresAt:dates.expiresAt,maxUses:dates.maxUses,allowedPlans});
    return {code:updated};
  }
  async function report(req,body={}){
    let uid,user,isAdmin=false;
    if(role==='control'){
      user=await admin(req);isAdmin=true;uid=clean(body.uid)||user.sub;
    }else{
      user=await identity(req);uid=user.sub;
      if(body.uid&&body.uid!==uid)throw fail('Acesso a outro divulgador negado.',403);
    }
    if(!uidPattern.test(uid))throw fail('UID inválido.');
    const partner=await read(db,'partners/'+uid);
    if(!partner||(!isAdmin&&!['approved','suspended'].includes(partner.status)))throw fail('Parceria não autorizada.',403);
    const limit=pageSize(body.limit),cursor=body.cursor||{};
    if(cursor&&typeof cursor!=='object')throw fail('Cursor inválido.');
    const names=['campaigns','links','coupons','freeDaysCodes','redemptions','commissions','payouts','financeLedger','vipBenefits'];
    const canViewFinancials=isAdmin||partner.permissions?.canViewFinancials!==false;
    if(body.section){
      const section=clean(body.section);
      if(![...names,'dailyReports'].includes(section))throw fail('Seção inválida.');
      if(!canViewFinancials&&['commissions','payouts','financeLedger'].includes(section))throw fail('Visão financeira não autorizada.',403);
      const selected=await ownerPage(section,uid,body.after,section==='dailyReports'?Math.min(limit,31):limit);
      return {section,items:safeItems(section,selected.items),nextCursor:selected.nextCursor};
    }
    const [totals,daily,settingsValue,financeState,mainAccount,...pages]=await Promise.all([
      read(db,`reports/partners/${uid}/totals`),
      ownerPage('dailyReports',uid,cursor.dailyReports,Math.min(limit,31)),
      settingsRead(),read(db,`financeState/${uid}`),read(main,`users/${uid}`),
      ...names.map(name=>!canViewFinancials&&['commissions','payouts','financeLedger'].includes(name)?
        Promise.resolve({items:[],nextCursor:null}):ownerPage(name,uid,cursor[name],limit))
    ]);
    const result={partner:{uid,label:partner.label,status:partner.status,createdAt:partner.createdAt,
      permissions:partner.permissions||{},benefits:partner.benefits||{}},
      totals:safeTotals(totals),daily:daily.items.map(item=>({date:item.id,clicks:Number(item.clicks)||0,
        signups:Number(item.signups)||0,conversions:Number(item.conversions)||0})),
      pages:{dailyReports:daily.nextCursor},settings:publicSettings(settingsValue),
      accountBenefits:{plan:bounded(mainAccount?.plan||mainAccount?.currentPlan||
        mainAccount?.account?.plan||mainAccount?.subscription?.plan||'Não informado',60),
        vipUntil:safeTimestamp(mainAccount?.vipUntil??mainAccount?.premiumUntil)},
      finance:canViewFinancials?safeFinance(financeState,settingsValue):null,
      adminView:isAdmin&&uid!==user.sub,financialOperationsAvailable:true};
    for(let i=0;i<names.length;i++){
      const name=names[i];
      result[name]=safeItems(name,pages[i].items);
      result.pages[name]=pages[i].nextCursor;
    }
    return result;
  }
  function publicSettings(value){return {allowPartnerLinks:value.allowPartnerLinks===true,
    commissionDescription:bounded(value.commissionDescription,300),
    currency:/^[A-Z]{3}$/.test(value.currency||'')?value.currency:'BRL',payoutsEnabled:value.payoutsEnabled===true};}
  function safeCount(value){const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:0;}
  function safeMoney(value){const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:0;}
  function safeTimestamp(value){
    const n=typeof value==='string'&&!/^\d+$/.test(value)?Date.parse(value):Number(value);
    if(!Number.isFinite(n)||n<=0)return 0;
    return n<100000000000?Math.trunc(n*1000):Math.trunc(n);
  }
  function safeTotals(value){return {clicks:safeCount(value?.clicks),signups:safeCount(value?.signups),
    conversions:safeCount(value?.conversions),redemptions:safeCount(value?.redemptions),
    uniqueVisitorsEstimated:safeCount(value?.uniqueVisitorsEstimated),
    couponRedemptions:safeCount(value?.couponRedemptions),freeDaysRedemptions:safeCount(value?.freeDaysRedemptions),
    confirmedPurchases:safeCount(value?.confirmedPurchases),
    commissionPendingCents:safeMoney(value?.commissionPendingCents),
    commissionApprovedCents:safeMoney(value?.commissionApprovedCents),
    commissionPaidCents:safeMoney(value?.commissionPaidCents)};}
  function safeFinance(state,settingsValue){
    const currency=/^[A-Z]{3}$/.test(settingsValue.currency||'')?settingsValue.currency:'BRL';
    const verified=state?.ledgerVerified===true&&state?.currency===currency;
    const available=verified?Math.max(0,safeMoney(state.approvedCents)-safeMoney(state.reservedCents)-safeMoney(state.recoveryCents)):0;
    return {ledgerVerified:verified,availableCents:available,recoveryCents:safeMoney(state?.recoveryCents),currency,
      canRequestPayout:settingsValue.payoutsEnabled===true&&verified&&available>0};
  }
  function safeItems(name,items){return items.map(item=>{
    if(name==='financeLedger')return {id:item.id,kind:item.kind,amountCents:safeMoney(item.amountCents),
      sourceId:item.sourceId,actorUid:item.actorUid,at:Number(item.at)||0};
    if(name==='vipBenefits')return {id:item.id,days:item.days,expiresAt:item.expiresAt,
      at:Number(item.completedAt)||0};
    if(name==='commissions'||name==='payouts')return {id:item.id,amount:Number(item.amount)||0,
      amountCents:safeMoney(item.amountCents),currency:item.currency||'BRL',
      status:item.status||'pending',at:Number(item.at||item.createdAt)||0,
      sourceVerified:item.sourceVerified===true,balanceReserved:item.balanceReserved===true,
      reservationReleasePending:item.reservationReleasePending===true,
      canApprove:Number(item.amount)>0&&Number(item.amount)<=1000000000&&
        /^[A-Z]{3}$/.test(item.currency||'')&&
        (name==='commissions'?item.sourceVerified===true&&keyPattern.test(clean(item.sourceId)):
          item.balanceReserved===true&&keyPattern.test(clean(item.reservationId)))};
    if(name==='redemptions')return {id:item.id,code:item.code,at:Number(item.at)||0,status:item.status||'recorded'};
    if(name==='dailyReports')return {date:item.id,clicks:Number(item.clicks)||0,
      signups:Number(item.signups)||0,conversions:Number(item.conversions)||0};
    if(name==='campaigns')return {id:item.id,name:item.name,status:item.status,createdAt:item.createdAt,
      startsAt:item.startsAt,expiresAt:item.expiresAt,maxUses:item.maxUses,used:item.used,
      commissionPercent:item.commissionPercent,fixedSignup:item.fixedSignup,
      fixedPurchaseCents:item.fixedPurchaseCents||0,freeDaysRewardCents:item.freeDaysRewardCents||0,
      budgetCents:item.budgetCents||0,budgetUsedCents:item.budgetUsedCents||0,allowedPlans:item.allowedPlans};
    if(name==='coupons'||name==='freeDaysCodes')return {code:item.code,campaign:item.campaign,
      status:item.status,createdAt:item.createdAt,startsAt:item.startsAt,expiresAt:item.expiresAt,
      maxUses:item.maxUses,used:item.used,discountPercent:item.discountPercent,freeDays:item.freeDays,
      allowedPlans:item.allowedPlans,active:item.active===true};
    return {code:item.code,campaign:item.campaign,status:item.status,active:item.active===true,
      createdAt:item.createdAt};
  });}
  async function settings(req,body){
    const actor=await admin(req);
    if(body.read===true)return {settings:await settingsRead()};
    const versioned=await db.request('settings/program','GET',undefined,true);
    const current=versioned.value||{};
    const next={...current,allowPartnerLinks:body.allowPartnerLinks===true,
      commissionDescription:bounded(body.commissionDescription,300),
      currency:/^[A-Z]{3}$/.test(clean(body.currency).toUpperCase())?clean(body.currency).toUpperCase():'BRL',
      payoutsEnabled:body.payoutsEnabled===true,updatedAt:now()};
    const saved=await db.request('settings/program','PUT',next,versioned.etag||'null_etag');
    if(saved.conflict)throw fail('Configurações alteradas por outra operação. Atualize e tente novamente.',409);
    await audit(actor,'settings.update','program',{allowPartnerLinks:current.allowPartnerLinks,
      currency:current.currency,commissionDescription:current.commissionDescription,
      payoutsEnabled:current.payoutsEnabled===true},
      {allowPartnerLinks:next.allowPartnerLinks,currency:next.currency,
        commissionDescription:next.commissionDescription,payoutsEnabled:next.payoutsEnabled});
    return {settings:next};
  }
  async function commissionTotals(path,id,cents,decision,orderKey){
    for(let attempt=0;attempt<6;attempt++){
      const current=await db.request(path,'GET',undefined,true),value=current.value||{};
      if(value.couponOrders?.[orderKey]==='reversed')return;
      const decisions=value.commissionDecisions||{};
      if(decisions[id]===decision)return;
      if(decisions[id])throw fail('Comissão já conciliada com outra decisão.',409);
      const next={...value,commissionDecisions:{...decisions,[id]:decision},
        commissionPendingCents:Math.max(0,safeMoney(value.commissionPendingCents)-cents),
        commissionApprovedCents:safeMoney(value.commissionApprovedCents)+(decision==='approved'?cents:0)};
      const saved=await db.request(path,'PUT',next,current.etag||'null_etag');
      if(!saved.conflict)return;
    }
    throw fail('Conflito ao atualizar o total financeiro. Reenvie a operação.',503);
  }
  async function reconcileCommissionDecision(record,decision){
    if(!['mercado-pago-verified','free-days-verified'].includes(record.createdBy))return;
    if(!keyPattern.test(clean(record.sourceId)))throw fail('Origem da comissão inválida.',409);
    const latest=await read(db,`commissions/${record.id}`);
    if(latest?.status==='reversed')return;
    if(latest?.status!==decision)throw fail('Estado da comissão mudou durante a conciliação.',409);
    const cents=Number.isSafeInteger(record.amountCents)?record.amountCents:
      Math.round(Number(record.amount)*100);
    if(!Number.isSafeInteger(cents)||cents<0)throw fail('Comissão sem valor em centavos.',409);
    const orderKey=crypto.createHash('sha256').update(record.sourceId).digest('hex').slice(0,32);
    await commissionTotals(`reports/partners/${record.partnerUid}/totals`,record.id,cents,decision,orderKey);
    await commissionTotals('reports/global/totals',record.id,cents,decision,orderKey);
  }
  async function reconcileCommissionBalance(record,decision){
    if(record.createdBy!=='mercado-pago-verified'&&record.createdBy!=='free-days-verified')return;
    const state=await read(db,`financeState/${record.partnerUid}`);
    if(!state?.ledgerEntries?.[record.id+'_pending'])return; // Legado: não criar saldo retroativamente.
    const cents=integer(record.amountCents,1,100000000);
    await finance.entry(db,record.partnerUid,record.id+'_'+decision,
      decision==='approved'?'approved':'rejected',cents,
      {sourceId:record.sourceId,actorUid:record.decisionBy,at:record.decisionAt});
  }
  async function financialAction(req,body){
    const actor=await admin(req),kind=clean(body.kind),id=clean(body.id),decision=clean(body.decision);
    const root={commission:'commissions',payout:'payouts'}[kind];
    if(!root||!keyPattern.test(id)||!['approved','rejected'].includes(decision))throw fail('Ação financeira inválida.');
    const versioned=await db.request(`${root}/${id}`,'GET',undefined,true),current=versioned.value;
    if(!current)throw fail('Lançamento não encontrado.',404);
    if(!uidPattern.test(current.partnerUid)||current.partnerUid===actor.sub)
      throw fail('Aprovação da própria parceria não permitida.',403);
    const expected=kind==='commission'?'pending':'requested';
    if(kind==='commission'&&['mercado-pago-verified','free-days-verified'].includes(current.createdBy)&&
      current.status===decision&&current.decisionBy===actor.sub){
      await reconcileCommissionDecision(current,decision);
      await reconcileCommissionBalance(current,decision);
      return {record:{id,status:decision,duplicate:true}};
    }
    if(kind==='payout'&&current.status==='rejected'&&decision==='rejected'&&current.decisionBy===actor.sub){
      const state=await read(db,`financeState/${current.partnerUid}`);
      if(state?.ledgerEntries?.[id])await finance.entry(db,current.partnerUid,id+'_release','release',
        integer(current.amountCents,1,100000000),{sourceId:id,actorUid:actor.sub,at:current.decisionAt});
      return {record:{id,status:'rejected',duplicate:true}};
    }
    if(current.status!==expected||current.isSimulation===true)throw fail('Transição financeira inválida.',409);
    if(decision==='approved'&&(!Number.isFinite(Number(current.amount))||Number(current.amount)<=0||
      Number(current.amount)>1000000000||!/^[A-Z]{3}$/.test(current.currency||'')))
      throw fail('Valor ou moeda financeira inválida.',409);
    if(decision==='approved'&&kind==='commission'&&current.sourceVerified!==true)
      throw fail('Comissão sem origem financeira verificada.',409);
    if(decision==='approved'&&kind==='commission'&&!keyPattern.test(clean(current.sourceId)))
      throw fail('Comissão sem identificador da origem.',409);
    if(decision==='approved'&&kind==='payout'&&current.balanceReserved!==true)
      throw fail('Saque sem saldo reservado.',409);
    if(decision==='approved'&&kind==='payout'&&!keyPattern.test(clean(current.reservationId)))
      throw fail('Saque sem identificador da reserva.',409);
    if(kind==='commission'&&current.createdBy==='mercado-pago-verified'){
      const cents=Number.isSafeInteger(current.amountCents)?current.amountCents:
        Math.round(Number(current.amount)*100);
      const [ownTotals,globalTotals]=await Promise.all([
        read(db,`reports/partners/${current.partnerUid}/totals`),read(db,'reports/global/totals')]);
      if(!Number.isSafeInteger(cents)||cents<0||
        safeMoney(ownTotals?.commissionPendingCents)<cents||
        safeMoney(globalTotals?.commissionPendingCents)<cents)
        throw fail('Agregados da comissão ainda não conciliados.',409);
    }
    const updated={...current,status:decision,updatedAt:now(),updatedBy:actor.sub,
      decisionAt:now(),decisionBy:actor.sub,
      reservationReleasePending:kind==='payout'&&decision==='rejected'&&current.balanceReserved===true};
    const saved=await db.request(`${root}/${id}`,'PUT',updated,versioned.etag||'null_etag');
    if(saved.conflict)throw fail('Lançamento alterado por outra operação.',409);
    await db.request(`byPartner/${root}/${current.partnerUid}/${id}`,'PUT',updated);
    if(kind==='commission'){
      await reconcileCommissionDecision(updated,decision);
      await reconcileCommissionBalance(updated,decision);
    }else if(decision==='rejected'){
      const state=await read(db,`financeState/${current.partnerUid}`);
      if(state?.ledgerEntries?.[id]){
        await finance.entry(db,current.partnerUid,id+'_release','release',
          integer(current.amountCents,1,100000000),{sourceId:id,actorUid:actor.sub,at:updated.decisionAt});
        updated.reservationReleasePending=false;
        await db.request(`payouts/${id}/reservationReleasePending`,'PUT',false);
        await db.request(`byPartner/payouts/${current.partnerUid}/${id}/reservationReleasePending`,'PUT',false);
      }
    }
    await audit(actor,`${kind}.${decision}`,id,{status:current.status,amount:current.amount,
      currency:current.currency},{status:decision,amount:current.amount,currency:current.currency,
      reservationReleasePending:updated.reservationReleasePending});
    return {record:{id,status:decision,reservationReleasePending:updated.reservationReleasePending}};
  }
  async function auditList(req,body={}){
    await admin(req);
    const result=await recentPage('audit',body.cursor,body.limit);
    return {events:result.items.map(item=>({id:item.id,actorUid:item.actorUid,action:item.action,
      target:item.target,at:item.at,before:item.before,after:item.after})),nextCursor:result.nextCursor};
  }
  async function payout(req,body){
    const {user,partner}=await ownPartner(req,true);
    if(partner.permissions?.canViewFinancials===false)throw fail('Visão financeira não autorizada.',403);
    const settingsValue=await settingsRead();
    if(settingsValue.payoutsEnabled!==true)throw fail('Solicitações de saque desabilitadas.',403);
    const cents=integer(body.amountCents,1,100000000),requestId=clean(body.requestId);
    if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestId))throw fail('Identificador da solicitação inválido.');
    const id='p_'+crypto.createHash('sha256').update(user.sub+'\0'+requestId).digest('hex').slice(0,32);
    const currency=publicSettings(settingsValue).currency;
    if(currency!=='BRL')throw fail('Saques disponíveis somente para saldo BRL conciliado.',409);
    const state=await read(db,`financeState/${user.sub}`);
    if(state?.requests?.[id]&&state.requests[id].amountCents!==cents)
      throw fail('Identificador já utilizado com outro valor.',409);
    const existing=await read(db,`payouts/${id}`);
    if(existing)return {payout:safeItems('payouts',[existing])[0]};
    if(state?.ledgerVerified!==true||state?.currency!==currency)
      throw fail('Saldo financeiro ainda não verificado.',409);
    if(Object.keys(state.requests||{}).length>=100&&!state.requests?.[id])
      throw fail('Limite de solicitações atingido; concilie o histórico.',409);
    await finance.entry(db,user.sub,id,'reserve',cents,{sourceId:id,actorUid:user.sub,at:now()});
    const record={id,partnerUid:user.sub,status:'requested',amount:cents/100,currency,
      amountCents:cents,at:now(),createdBy:user.sub,balanceReserved:true,reservationId:id};
    await db.request('','PATCH',{[`payouts/${id}`]:record,[`byPartner/payouts/${user.sub}/${id}`]:record});
    await audit(user,'payout.request',id,null,{amountCents:cents,currency});
    return {payout:safeItems('payouts',[record])[0]};
  }
  async function confirmPayout(req,body){
    const actor=await admin(req),id=clean(body.id),externalReference=clean(body.externalReference);
    if(!keyPattern.test(id)||!/^[A-Za-z0-9_-]{8,160}$/.test(externalReference))
      throw fail('Referência externa inválida.');
    const version=await db.request(`payouts/${id}`,'GET',undefined,true),record=version.value;
    if(!record||record.partnerUid===actor.sub||record.isSimulation===true||
      !['approved','paid'].includes(record.status)||record.balanceReserved!==true||
      !Number.isSafeInteger(record.amountCents)||record.amountCents<1||record.currency!=='BRL')
      throw fail('Saque não elegível para confirmação.',409);
    if(record.status==='paid'){
      if(record.externalPaymentId!==externalReference)throw fail('Saque já pago com outra referência externa.',409);
      return {payout:{id,status:'paid',duplicate:true}};
    }
    const proof=await payoutVerifier(record,externalReference);
    const proofPath=`externalPayments/${proof.paymentId}`;
    const reserved=await db.request(proofPath,'PUT',
      {paymentId:proof.paymentId,payoutId:id,partnerUid:record.partnerUid,
        amountCents:record.amountCents,confirmedAt:proof.confirmedAt,provider:proof.provider},'null_etag');
    if(reserved.conflict){const previous=await read(db,proofPath);
      if(previous?.payoutId!==id)throw fail('Pagamento externo já usado em outro saque.',409);}
    await finance.entry(db,record.partnerUid,id+'_paid','paid',record.amountCents,
      {sourceId:proof.paymentId,actorUid:actor.sub,at:proof.confirmedAt});
    for(const path of [`reports/partners/${record.partnerUid}/totals`,'reports/global/totals']){
      for(let attempt=0;attempt<8;attempt++){
        const versioned=await db.request(path,'GET',undefined,true),totals=versioned.value||{};
        if(totals.paidPayouts?.[id]===true)break;
        const next={...totals,paidPayouts:{...(totals.paidPayouts||{}),[id]:true},
          commissionApprovedCents:Math.max(0,safeMoney(totals.commissionApprovedCents)-record.amountCents),
          commissionPaidCents:safeMoney(totals.commissionPaidCents)+record.amountCents};
        const savedTotals=await db.request(path,'PUT',next,versioned.etag||'null_etag');
        if(!savedTotals.conflict)break;
        if(attempt===7)throw fail('Totais do pagamento ainda não conciliados.',503);
      }
    }
    const updated={...record,status:'paid',externalPaymentId:proof.paymentId,
      externalProvider:proof.provider,paidAt:proof.confirmedAt,updatedAt:now(),updatedBy:actor.sub};
    const saved=await db.request(`payouts/${id}`,'PUT',updated,version.etag||'null_etag');
    if(saved.conflict)throw fail('Saque alterado simultaneamente. Reenvie a confirmação.',503);
    await db.request(`byPartner/payouts/${record.partnerUid}/${id}`,'PUT',updated);
    await audit(actor,'payout.paid',id,{status:record.status},
      {status:'paid',amountCents:record.amountCents,externalPaymentId:proof.paymentId,provider:proof.provider});
    return {payout:{id,status:'paid',paidAt:proof.confirmedAt}};
  }
  async function allocateCommission(req,body){
    const actor=await admin(req),payoutId=clean(body.payoutId),commissionId=clean(body.commissionId);
    if(!keyPattern.test(payoutId)||!keyPattern.test(commissionId))throw fail('Identificador financeiro inválido.');
    const [payoutVersion,commissionVersion]=await Promise.all([
      db.request(`payouts/${payoutId}`,'GET',undefined,true),
      db.request(`commissions/${commissionId}`,'GET',undefined,true)]);
    const payout=payoutVersion.value,commission=commissionVersion.value;
    if(!payout||payout.status!=='paid'||!payout.externalPaymentId||
      !commission||commission.partnerUid!==payout.partnerUid||commission.partnerUid===actor.sub||
      !Number.isSafeInteger(commission.amountCents)||commission.amountCents<1)
      throw fail('Comissão ou saque não elegível para vinculação.',409);
    if(commission.status==='paid'){
      if(commission.paidByPayoutId!==payoutId)throw fail('Comissão já vinculada a outro saque.',409);
      return {commission:{id:commissionId,status:'paid',duplicate:true}};
    }
    if(commission.status!=='approved')throw fail('Somente comissão aprovada pode ser vinculada.',409);
    const allocations=payout.allocations||{},current=allocations[commissionId];
    if(current&&current!==commission.amountCents)throw fail('Valor de comissão divergente.');
    if(!current){
      const used=Object.values(allocations).reduce((sum,value)=>sum+safeMoney(value),0);
      if(used+commission.amountCents>payout.amountCents)throw fail('Saque pago não cobre esta comissão.',409);
      if(Object.keys(allocations).length>=1000)throw fail('Limite de vinculações atingido.',409);
      const saved=await db.request(`payouts/${payoutId}`,'PUT',
        {...payout,allocations:{...allocations,[commissionId]:commission.amountCents}},
        payoutVersion.etag||'null_etag');
      if(saved.conflict)throw fail('Saque alterado simultaneamente. Reenvie a vinculação.',409);
    }
    const updated={...commission,status:'paid',paidByPayoutId:payoutId,
      externalPaymentId:payout.externalPaymentId,paidAt:payout.paidAt,updatedAt:now(),updatedBy:actor.sub};
    const saved=await db.request(`commissions/${commissionId}`,'PUT',updated,commissionVersion.etag||'null_etag');
    if(saved.conflict)throw fail('Comissão alterada simultaneamente. Reenvie a vinculação.',409);
    await db.request(`byPartner/commissions/${commission.partnerUid}/${commissionId}`,'PUT',updated);
    await audit(actor,'commission.paid',commissionId,{status:'approved'},
      {status:'paid',payoutId,externalPaymentId:payout.externalPaymentId});
    return {commission:{id:commissionId,status:'paid',payoutId}};
  }
  return {adminData,list,create,status,partnerAccess,grantPartnerVip,createCampaign,campaignUpdate,link,myLink,
    myCoupon,myFreeDaysCode,couponCreate,freeDaysCodeCreate,codeUpdate,report,settings,
    financialAction,confirmPayout,allocateCommission,auditList,payout};
}
module.exports={createService};
