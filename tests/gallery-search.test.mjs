import test from 'node:test';
import assert from 'node:assert/strict';
import { indexGallery, searchGallery, parseGalleryQuery, relatedSuggestions } from '../web/editor/gallery-search.mjs';
const item=(id,name,category='站姿',overrides={})=>({id,name,originalName:name,category,system:'full_single',number:'P001',people:1,frame:'full',source:{id:'sample'},views:['front','side','high'].map(angle=>({id:`${id}_${angle}`,angle,original:{ready:true}})),...overrides});
const index=indexGallery([
  item('raised','站姿・双臂上举'), item('hips','站姿・双手扶腰'),item('supine','仰卧・双臂过头','趴卧'),
  item('prone','俯卧・托腮','趴卧'), item('sit','侧坐・单臂上伸','坐姿'), item('head','双手抱头'),
  item('arms','双臂交叉'),item('kneel','单膝跪・手扶膝','跪姿'),item('knee','站姿・抬膝'),
  item('heart','双手比心','手势',{frame:'upper'}),item('pair','双人拥抱','双人',{people:2}),
]);
const ids=options=>searchGallery(index,typeof options==='string'?{query:options}:options).map(x=>x.id);
test('common Chinese action aliases find source terminology',()=>{
  assert.deepEqual(ids('叉腰'),['hips']);assert.deepEqual(ids('坐着'),['sit']);
  assert.ok(ids('举手').includes('raised'));assert.deepEqual(ids('半身 比心'),['heart']);
});
test('conjoined action and view match actual views before grouping',()=>{
  const result=searchGallery(index,{query:'侧面 站姿 举手'});
  assert.equal(result.length,1);assert.deepEqual(result[0].matchedViewIds,['raised_side']);
  assert.equal(searchGallery(index,{query:'正面',angle:'side'}).length,0);
  assert.equal(searchGallery(index,{query:'单人 双人'}).length,0);
});
test('opposite postures do not inherit a wrong source category',()=>{
  assert.deepEqual(ids('仰卧'),['supine']);assert.deepEqual(ids('俯卧'),['prone']);
  assert.deepEqual(ids('抱臂'),['arms']);assert.deepEqual(ids('抱头'),['head']);
  assert.deepEqual(ids('单膝跪'),['kneel']);assert.deepEqual(ids('抬膝'),['knee']);
});
test('exact view IDs beat substring matches and missing views stay missing',()=>{
  assert.deepEqual(ids('raised_side'),['raised']);assert.deepEqual(ids('raised_low'),[]);
  assert.deepEqual(ids('P999'),[]);assert.deepEqual(ids('站姿 不存在的动作'),[]);
});
test('filters and empty results remain explicit',()=>{
  assert.deepEqual(ids({query:'拥抱',people:'1'}),[]);
  assert.ok(relatedSuggestions(index,{query:'拥抱',people:'1'}).some(x=>x.field==='people'&&x.count===1));
  assert.deepEqual(ids({query:'举手',collectionIds:['hips']}),[]);
});
test('normalization and concatenated Chinese words support IME results',()=>{
  assert.deepEqual(ids('侧面站姿举手'),['raised']);assert.deepEqual(ids('　半身　比心　'),['heart']);
  assert.deepEqual(ids('Ｐ００１'),ids('p001'));assert.equal(parseGalleryQuery('单人正面').tokens.length,2);
});
test('common action pinyin works without a network or model',()=>{
  assert.deepEqual(ids('chayao'),['hips']);assert.deepEqual(ids('cy'),['hips']);
  assert.deepEqual(ids('bixin'),['heart']);
  assert.ok(ids('zz').includes('sit'));assert.ok(ids('zz').includes('raised'));
  const ambiguous=indexGallery([item('head','双手抱头'),item('legs','站姿并腿')]);
  assert.deepEqual(new Set(searchGallery(ambiguous,{query:'bt'}).map(row=>row.id)),new Set(['head','legs']));
});
