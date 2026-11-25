'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const file=path.resolve(__dirname,'../firebase-partners/database.rules.json');
test('Firebase Partners nega acesso direto do navegador a todas as coleções',
  {skip:!fs.existsSync(file)},()=>{
  const rules=JSON.parse(fs.readFileSync(file,'utf8')).rules;
  assert.equal(rules['.read'],false);
  assert.equal(rules['.write'],false);
  for(const key of ['controlAdmins','partners','campaigns','links','coupons','freeDaysCodes',
    'redemptions','commissions','payouts','audit','codeRegistry'])assert.ok(rules[key]);
});
