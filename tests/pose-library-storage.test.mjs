// Server persistence/conflict behavior is covered by test_pose_library.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import {filterCatalog} from '../web/editor/pose-catalog.mjs';
const items=[
 {id:'a',name:'自然站立',originalName:'Standing',category:'站姿',tags:['relaxed'],source:{id:'general'},favorite:true},
 {id:'b',name:'自然站立',originalName:'Standing B',category:'站姿',tags:[],source:{id:'miu-main'}},
 {id:'built',name:'举手',category:'站姿',tags:[],source:{id:'builtin'},builtin:true},
 {id:'hidden',name:'已隐藏',category:'站姿',source:{id:'builtin'},hidden:true,favorite:true},
];
test('same display name retains independent source identities',()=>assert.deepEqual(filterCatalog(items,{query:'自然'}).map(x=>x.id),['a','b']));
test('source, original names and tags remain searchable',()=>{
 assert.deepEqual(filterCatalog(items,{source:'miu-main',query:'standing'}).map(x=>x.id),['b']);
 assert.deepEqual(filterCatalog(items,{query:'relaxed'}).map(x=>x.id),['a']);
});
test('favorites exclude hidden items and filtering never mutates stored entries',()=>{
 const previous=structuredClone(items);assert.deepEqual(filterCatalog(items,{tab:'favorites'}).map(x=>x.id),['a']);assert.deepEqual(items,previous);
});
test('empty filters show all visible rows and a missing category shows no matches',()=>{
 assert.equal(filterCatalog(items).length,3);assert.deepEqual(filterCatalog(items,{category:'舞蹈'}),[]);
});
