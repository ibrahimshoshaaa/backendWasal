const test = require('node:test');
const assert = require('node:assert/strict');
const {resolveOptions} = require('../src/services/options');
const groups = [
  {id:1,name:'الحجم',pricing_mode:'absolute',is_required:true,min_select:1,max_select:1},
  {id:2,name:'جبنة',is_required:false,min_select:0,max_select:1}
];
const choices = [
  {id:11,group_id:1,name:'كبير',total_price:'120',extra_price:0,is_available:true},
  {id:12,group_id:1,name:'صغير',total_price:'80',extra_price:0,is_available:true},
  {id:21,group_id:2,name:'جبنة',extra_price:10,is_available:true}
];
const db = async sql => ({rows: sql.startsWith('SELECT *') ? groups : choices});
test('size is a full price, independent of base price, plus optional extras',async()=>{
  const selection=[{group_id:1,choice_ids:[11]}];
  assert.equal(100+(await resolveOptions(db,1,selection,100)).extra,120);
  assert.equal(150+(await resolveOptions(db,1,selection,150)).extra,120);
  assert.equal(100+(await resolveOptions(db,1,[{group_id:1,choice_ids:[12]}],100)).extra,80);
  assert.equal(100+(await resolveOptions(db,1,[...selection,{group_id:2,choice_ids:[21]}],100)).extra,130);
});
test('size selection cannot be omitted, doubled or unavailable',async()=>{
  await assert.rejects(resolveOptions(db,1,[],100));
  await assert.rejects(resolveOptions(db,1,[{group_id:1,choice_ids:[11,12]}],100));
  const unavailable=async sql=>({rows:sql.startsWith('SELECT *')?groups:choices.map(c=>({...c,is_available:false}))});
  await assert.rejects(resolveOptions(unavailable,1,[{group_id:1,choice_ids:[11]}],100));
});
