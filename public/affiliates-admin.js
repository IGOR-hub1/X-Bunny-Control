(function(){'use strict';
  const $=id=>document.getElementById(id);
  const names={overview:'Visão geral',partners:'Divulgadores',campaigns:'Campanhas',codes:'Cupons e códigos',
    reports:'Relatórios e financeiro',audit:'Histórico',settings:'Configurações'};
  let partners=[],partnerCursor=null,selectedUid='',report=null,auditEvents=[],auditCursor=null;
  const make=(tag,value,className)=>{const element=document.createElement(tag);if(value!==undefined)element.textContent=String(value);
    if(className)element.className=className;return element;};
  const message=value=>{$('message').textContent=value;};
  const date=value=>value?new Date(Number(value)).toLocaleString('pt-BR'):'—';
  const localDate=value=>{if(!value)return '';const d=new Date(Number(value));return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  const timestamp=value=>value?new Date(value).getTime():undefined;
  const metric=(label,value)=>{const box=make('div',undefined,'metric');box.append(make('small',label),make('strong',Number(value)||0));return box;};
  const row=(title,detail)=>{const item=make('div',undefined,'row'),copy=make('div');copy.append(make('strong',title),make('small',detail||''));item.append(copy);return item;};
  function actions(item,buttons){const box=make('div',undefined,'actions');for(const [title,handler] of buttons){
      const button=make('button',title,'secondary');button.type='button';button.onclick=handler;box.append(button);}item.append(box);return item;}
  if(!window.firebase||!window.DK_FIREBASE_CONFIG){message('Firebase Authentication indisponível.');return;}
  firebase.initializeApp(window.DK_FIREBASE_CONFIG);
  async function api(action,body={}){const user=firebase.auth().currentUser;if(!user)throw new Error('Entre com sua conta autorizada.');
    const response=await fetch('/api/affiliates/'+action,{method:'POST',headers:{'Content-Type':'application/json',
      Authorization:'Bearer '+await user.getIdToken()},body:JSON.stringify(body),cache:'no-store'});
    const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Falha na API.');return data;}
  function show(view){if(!names[view])return;$('page-title').textContent=names[view];
    document.querySelectorAll('#navigation button').forEach(button=>{
      const active=button.dataset.view===view;button.classList.toggle('active',active);
      if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    document.querySelectorAll('[data-panel]').forEach(section=>section.hidden=section.dataset.panel!==view);
    if(view==='audit'&&!auditEvents.length)loadAudit().catch(error=>message(error.message));
  }
  function renderPartners(){const list=$('partner-list'),overview=$('overview-partners');list.replaceChildren();overview.replaceChildren();
    for(const partner of partners){const detail=partner.uid+' · '+partner.status;
      const item=row(partner.label||partner.uid,detail);
      actions(item,[['Abrir',()=>selectPartner(partner.uid)],
        ['Aprovar',()=>changeStatus(partner.uid,'approved')],['Suspender',()=>changeStatus(partner.uid,'suspended')],
        ['Remover',()=>changeStatus(partner.uid,'removed')]]);
      list.append(item);
    }
    for(const partner of partners.slice(0,5))overview.append(row(partner.label||partner.uid,partner.status));
    if(!partners.length){list.append(make('p','Nenhum divulgador cadastrado.'));overview.append(make('p','Nenhum divulgador cadastrado.'));}
    $('more-partners').hidden=!partnerCursor;
  }
  async function loadAdmin(more=false){const data=await api('adminData',{cursor:more?partnerCursor:null,limit:20});
    partners=more?partners.concat(data.partners):data.partners;partnerCursor=data.nextCursor;
    $('totals').replaceChildren(metric('Acessos',data.totals.clicks),metric('Cadastros',data.totals.signups),
      metric('Conversões',data.totals.conversions),metric('Resgates',data.totals.redemptions));
    $('settings-form').elements.allowPartnerLinks.checked=data.settings.allowPartnerLinks;
    $('settings-form').elements.payoutsEnabled.checked=data.settings.payoutsEnabled;
    $('settings-form').elements.currency.value=data.settings.currency;
    $('settings-form').elements.commissionDescription.value=data.settings.commissionDescription;
    renderPartners();$('app').hidden=false;message('Painel atualizado.');
  }
  async function changeStatus(uid,status){if(status==='removed'&&!confirm('Remover esta parceria logicamente? O histórico será preservado.'))return;
    try{await api('status',{uid,status});await loadAdmin();if(uid===selectedUid)await selectPartner(uid);message('Status atualizado.');}
    catch(error){message(error.message);}}
  function fillAccess(partner){const form=$('partner-access'),permissions=partner.permissions||{},benefits=partner.benefits||{};
    form.hidden=false;form.elements.uid.value=partner.uid;
    for(const name of ['canCreateLinks','canViewFinancials','canIssueCoupons','canIssueFreeDaysCodes'])
      form.elements[name].checked=permissions[name]===true;
    form.elements.commissionBoostPercent.value=benefits.commissionBoostPercent||0;
    form.elements.fixedPurchaseCents.value=benefits.fixedPurchaseCents||0;
    form.elements.freeDaysRewardCents.value=benefits.freeDaysRewardCents||0;
    form.elements.freeDaysCodeLimit.value=benefits.freeDaysCodeLimit||0;
    $('selected-partner').textContent=partner.label+' · '+partner.uid+' · '+partner.status;
  }
  async function selectPartner(uid,openReports=true){try{report=await api('report',{uid,limit:20});selectedUid=uid;
      $('campaign-create').elements.uid.value=uid;$('code-create').elements.uid.value=uid;
      $('partner-vip-grant').elements.uid.value=uid;
      $('report-select').elements.uid.value=uid;fillAccess(report.partner);
      renderCampaigns();renderCodes();renderReport();if(openReports)show('reports');message('Dados de '+report.partner.label+' atualizados.');
    }catch(error){message(error.message);}}
  function renderCampaigns(){const root=$('campaign-list');root.replaceChildren();if(!report)return;
    for(const campaign of report.campaigns){const item=row(campaign.name,
      campaign.id+' · '+campaign.status+' · comissão '+(campaign.commissionPercent||0)+'% + '+
      ((campaign.fixedPurchaseCents||0)/100).toFixed(2)+' BRL · orçamento '+
      (campaign.budgetCents?((campaign.budgetUsedCents||0)/100).toFixed(2)+' / '+(campaign.budgetCents/100).toFixed(2)+' BRL':'sem limite')+
      ' · até '+date(campaign.expiresAt));
      actions(item,[['Editar',()=>{const form=$('campaign-edit');form.hidden=false;$('campaign-edit-empty').hidden=true;
        form.elements.id.value=campaign.id;form.elements.name.value=campaign.name;form.elements.status.value=campaign.status;
        form.elements.expiresAt.value=localDate(campaign.expiresAt);form.elements.maxUses.value=campaign.maxUses||0;
        form.elements.allowedPlans.value=campaign.allowedPlans?.length===1?campaign.allowedPlans[0]:'both';
        form.elements.commissionPercent.value=campaign.commissionPercent||0;form.elements.fixedSignup.value=campaign.fixedSignup||0;
        form.elements.fixedPurchaseCents.value=campaign.fixedPurchaseCents||0;
        form.elements.freeDaysRewardCents.value=campaign.freeDaysRewardCents||0;
        form.elements.budgetCents.value=campaign.budgetCents||0;
        show('campaigns');}]]);root.append(item);}
    if(!root.children.length)root.append(make('p','Nenhuma campanha nesta página.'));
    document.querySelector('[data-more="campaigns"]').hidden=!report.pages.campaigns;
  }
  function renderCodes(){const root=$('code-list');root.replaceChildren();if(!report)return;
    for(const [kind,key] of [['link','links'],['coupon','coupons'],['freeDays','freeDaysCodes']]){
      for(const code of report[key]){const extra=kind==='coupon'?' · primeira compra '+code.discountPercent+'%':
        kind==='freeDays'?' · '+code.freeDays+' dias':'';
        const item=row(code.code,kind+' · '+code.status+' · '+code.campaign+extra+' · até '+date(code.expiresAt));
        actions(item,[['Editar',()=>{const form=$('code-edit');form.hidden=false;$('code-edit-empty').hidden=true;
          form.elements.kind.value=kind;form.elements.code.value=code.code;form.elements.status.value=code.status;
          form.elements.allowedPlans.value=code.allowedPlans?.length===1?code.allowedPlans[0]:'both';
          form.elements.expiresAt.value=localDate(code.expiresAt);form.elements.maxUses.value=code.maxUses||0;show('codes');}]]);
        root.append(item);
      }
      document.querySelector(`[data-more="${key}"]`).hidden=!report.pages[key];
    }
    if(!root.children.length)root.append(make('p','Nenhum código nesta página.'));
  }
  function renderReport(){if(!report)return;
    $('report-label').textContent=report.partner.label+' · '+report.partner.uid+' · '+report.partner.status;
    $('partner-totals').replaceChildren(metric('Acessos',report.totals.clicks),metric('Cadastros',report.totals.signups),
      metric('Conversões',report.totals.conversions),metric('Resgates',report.totals.redemptions));
    const daily=$('daily-list');daily.replaceChildren();for(const item of report.daily)
      daily.append(row(item.date,`${item.clicks} acessos · ${item.signups} cadastros · ${item.conversions} conversões`));
    if(!daily.children.length)daily.append(make('p','Sem atividade diária registrada.'));
    const redemptions=$('redemption-list');redemptions.replaceChildren();for(const item of report.redemptions)
      redemptions.append(row(item.code||item.id,item.status+' · '+date(item.at)));
    if(!redemptions.children.length)redemptions.append(make('p','Nenhum resgate registrado.'));
    const ledger=$('finance-ledger-list');ledger.replaceChildren();
    for(const item of report.financeLedger||[])ledger.append(row(item.kind+' · '+Number(item.amountCents||0)/100+' BRL',
      item.id+' · '+date(item.at)));
    if(!ledger.children.length)ledger.append(make('p','Nenhum movimento de saldo nesta página.'));
    for(const [kind,key,target,pending] of [['commission','commissions','commission-list','pending'],
      ['payout','payouts','payout-list','requested']]){
      const root=$(target);root.replaceChildren();for(const record of report[key]){
        const item=row(record.id,record.status+' · '+Number(record.amount||0).toFixed(2)+' · '+date(record.at));
        if(record.status===pending){const options=[];
          if(record.canApprove)
            options.push(['Aprovar',()=>decide(kind,record.id,'approved')]);
          options.push(['Rejeitar',()=>decide(kind,record.id,'rejected')]);actions(item,options);}
        root.append(item);
      }if(!root.children.length)root.append(make('p','Nenhum lançamento registrado.'));
      document.querySelector(`[data-more="${key}"]`).hidden=!report.pages[key];
    }
    for(const section of ['dailyReports','redemptions','financeLedger'])document.querySelector(`[data-more="${section}"]`).hidden=!report.pages[section];
  }
  async function decide(kind,id,decision){if(!confirm((decision==='approved'?'Aprovar':'Rejeitar')+' este lançamento?'))return;
    try{const result=await api('financialAction',{kind,id,decision});await selectPartner(selectedUid);
      message('Decisão registrada por sua conta.'+(result.record.reservationReleasePending?' Reserva pendente de conciliação.':''));}
    catch(error){message(error.message);}}
  async function moreSection(section){if(!report||!report.pages[section])return;
    try{const result=await api('report',{uid:selectedUid,section,after:report.pages[section],limit:20});
      const key=section==='dailyReports'?'daily':section;report[key].push(...result.items);report.pages[section]=result.nextCursor;
      if(section==='campaigns')renderCampaigns();else if(['links','coupons','freeDaysCodes'].includes(section))renderCodes();else renderReport();
      message('Mais registros carregados.');}catch(error){message(error.message);}}
  function renderAudit(){const root=$('audit-list');root.replaceChildren();for(const event of auditEvents){
      const item=row(event.action+' · '+event.target,'Por '+event.actorUid+' · '+date(event.at));
      const details=make('details'),summary=make('summary','Ver alteração'),pre=make('pre',JSON.stringify({antes:event.before,depois:event.after},null,2));
      details.append(summary,pre);item.append(details);root.append(item);
    }if(!root.children.length)root.append(make('p','Nenhuma alteração registrada.'));
    $('more-audit').hidden=!auditCursor;}
  async function loadAudit(more=false){const data=await api('auditList',{cursor:more?auditCursor:null,limit:20});
    auditEvents=more?auditEvents.concat(data.events):data.events;auditCursor=data.nextCursor;renderAudit();}
  function values(form,names){const body={};for(const name of names)body[name]=form.elements[name].value.trim();return body;}
  function dates(body){if(body.startsAt)body.startsAt=timestamp(body.startsAt);else delete body.startsAt;
    if(body.expiresAt)body.expiresAt=timestamp(body.expiresAt);return body;}
  async function submit(event,action,body,after){event.preventDefault();try{const result=await api(action,body);
      if(after)await after(result);message('Operação registrada e auditada.');}catch(error){message(error.message);}}
  document.querySelectorAll('#navigation button').forEach(button=>button.onclick=()=>show(button.dataset.view));
  document.querySelectorAll('[data-go]').forEach(button=>button.onclick=()=>show(button.dataset.go));
  document.querySelectorAll('[data-more]').forEach(button=>button.onclick=()=>moreSection(button.dataset.more));
  $('more-partners').onclick=()=>loadAdmin(true).catch(error=>message(error.message));
  $('more-audit').onclick=()=>loadAudit(true).catch(error=>message(error.message));
  $('reload').onclick=()=>loadAdmin().then(()=>selectedUid&&selectPartner(selectedUid)).catch(error=>message(error.message));
  $('logout').onclick=()=>firebase.auth().signOut().then(()=>location.assign('index.html'));
  $('create-partner').onsubmit=event=>submit(event,'create',values(event.currentTarget,['uid','label']),()=>loadAdmin());
  $('partner-access').onsubmit=event=>{const form=event.currentTarget;
    const permissions={};for(const name of ['canCreateLinks','canViewFinancials','canIssueCoupons','canIssueFreeDaysCodes'])
      permissions[name]=form.elements[name].checked;
    const benefits={commissionBoostPercent:Number(form.elements.commissionBoostPercent.value),
      fixedPurchaseCents:Number(form.elements.fixedPurchaseCents.value),
      freeDaysRewardCents:Number(form.elements.freeDaysRewardCents.value),
      freeDaysCodeLimit:Number(form.elements.freeDaysCodeLimit.value)};
    submit(event,'partnerAccess',{uid:form.elements.uid.value,permissions,benefits},async()=>{await loadAdmin();await selectPartner(form.elements.uid.value,false);});};
  $('campaign-create').onsubmit=event=>{const form=event.currentTarget;
    submit(event,'createCampaign',dates(values(form,['uid','name','startsAt','expiresAt','maxUses','allowedPlans','commissionPercent','fixedSignup','fixedPurchaseCents','freeDaysRewardCents','budgetCents'])),
      ()=>selectPartner(form.elements.uid.value,false));};
  $('campaign-edit').onsubmit=event=>{const form=event.currentTarget;
    submit(event,'campaignUpdate',dates(values(form,['id','name','status','expiresAt','maxUses','allowedPlans','commissionPercent','fixedSignup','fixedPurchaseCents','freeDaysRewardCents','budgetCents'])),
      ()=>selectPartner(selectedUid,false));};
  $('code-create').onsubmit=event=>{const form=event.currentTarget,body=dates(values(form,
      ['kind','uid','campaignId','code','expiresAt','maxUses','discountPercent','allowedPlans','freeDays']));
    const action={link:'link',coupon:'couponCreate',freeDays:'freeDaysCodeCreate'}[body.kind];delete body.kind;
    submit(event,action,body,()=>selectPartner(form.elements.uid.value,false));};
  $('code-edit').onsubmit=event=>{const form=event.currentTarget;
    submit(event,'codeUpdate',dates(values(form,['kind','code','status','expiresAt','maxUses','allowedPlans'])),
      ()=>selectPartner(selectedUid,false));};
  $('report-select').onsubmit=event=>{event.preventDefault();selectPartner(event.currentTarget.elements.uid.value.trim());};
  let vipRequestId='';
  $('partner-vip-grant').addEventListener('input',()=>{vipRequestId='';});
  $('partner-vip-grant').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');
    if(!confirm('Conceder os dias VIP configurados a esta conta?'))return;
    if(!vipRequestId)vipRequestId=crypto.randomUUID();button.disabled=true;
    try{const result=await api('grantPartnerVip',{uid:form.elements.uid.value.trim(),
      days:Number(form.elements.days.value),requestId:vipRequestId});vipRequestId='';
      message('VIP concedido até '+date(result.benefit.expiresAt)+'.');await selectPartner(form.elements.uid.value.trim(),false);}
    catch(error){message(error.message+' Repita a solicitação para retomar a mesma operação.');}
    finally{button.disabled=false;}};
  $('payout-confirm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');
    if(!confirm('Verificar a confirmação externa e registrar este saque como pago?'))return;
    button.disabled=true;
    try{const result=await api('confirmPayout',values(form,['id','externalReference']));
      message('Saque '+result.payout.id+' confirmado pelo verificador externo.');
      if(selectedUid)await selectPartner(selectedUid,false);}
    catch(error){message(error.message);}finally{button.disabled=false;}};
  $('commission-allocation').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');
    button.disabled=true;
    try{const result=await api('allocateCommission',values(form,['payoutId','commissionId']));
      message('Comissão '+result.commission.id+' vinculada ao saque externo confirmado.');
      if(selectedUid)await selectPartner(selectedUid,false);}
    catch(error){message(error.message);}finally{button.disabled=false;}};
  $('settings-form').onsubmit=event=>{const form=event.currentTarget;
    submit(event,'settings',{allowPartnerLinks:form.elements.allowPartnerLinks.checked,
      payoutsEnabled:form.elements.payoutsEnabled.checked,
      currency:form.elements.currency.value.trim(),commissionDescription:form.elements.commissionDescription.value.trim()},
      ()=>loadAdmin());};
  firebase.auth().onAuthStateChanged(user=>{if(user)loadAdmin().catch(error=>{$('app').hidden=true;message(error.message);});
    else{$('app').hidden=true;message('Entre pelo início deste painel com uma conta autorizada.');}});
})();
