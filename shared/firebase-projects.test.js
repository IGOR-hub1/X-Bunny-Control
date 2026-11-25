'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createProjectStores}=require('./firebase-projects');

test('projetos principal e Partners precisam ter IDs diferentes',()=>{
  assert.throws(()=>createProjectStores({mainProjectId:'same',partnersProjectId:'same'}),error=>error.statusCode===503);
});
test('Partners exige ID e URL próprios',()=>{
  assert.throws(()=>createProjectStores({mainProjectId:'main',partnersProjectId:'',partnersDatabaseURL:''}),error=>error.statusCode===503);
  assert.throws(()=>createProjectStores({mainProjectId:'main',partnersProjectId:'partners'}),error=>error.statusCode===503);
});
test('credencial de serviço de outro projeto é recusada',()=>{
  assert.throws(()=>createProjectStores({mainProjectId:'main',partnersProjectId:'partners',
    mainDatabaseURL:'https://main-default-rtdb.firebaseio.com',
    partnersDatabaseURL:'https://partners-default-rtdb.firebaseio.com',
    mainAccount:{project_id:'wrong',client_email:'test@example.invalid',private_key:'not-used'},
    partnersAccount:{project_id:'partners',client_email:'test@example.invalid',private_key:'not-used'}}),
    error=>error.statusCode===503);
});
