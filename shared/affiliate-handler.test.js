'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHandler}=require('./affiliate-handler');

async function call(role,action,method='POST'){
  const response={statusCode:200,headers:{},setHeader(name,value){this.headers[name]=value;},end(body){this.body=JSON.parse(body);}};
  await createHandler(role)({url:'/api/affiliates?action='+action,method,headers:{}},response);
  return response;
}

test('painel do parceiro não expõe ações administrativas',async()=>{
  const response=await call('partners','adminData');
  assert.equal(response.statusCode,404);
  for(const action of ['partnerAccess','campaignUpdate','couponCreate','freeDaysCodeCreate',
    'codeUpdate','financialAction','auditList'])
    assert.equal((await call('partners',action)).statusCode,404);
});
test('ações de ambos os painéis exigem token antes de acessar Firebase',async()=>{
  assert.equal((await call('control','adminData')).statusCode,401);
  assert.equal((await call('partners','report')).statusCode,401);
});
