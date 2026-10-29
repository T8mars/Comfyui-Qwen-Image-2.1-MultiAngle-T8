import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { indexGallery, searchGallery } from '../web/editor/gallery-search.mjs';

const corpus=JSON.parse(fs.readFileSync(new URL('./fixtures/gallery-search-corpus.json',import.meta.url),'utf8'));
const index=indexGallery(corpus.items), key=row=>`${row.system}_${row.number}`;
const positives=[
  ['举手','full_single_P019'],['站姿 举手','full_single_P019'],['侧面站姿举手','full_single_P019'],
  ['叉腰','full_single_P018'],['站姿 扶腰','full_single_P018'],['坐着','full_single_P001'],['单人 坐着','full_single_P001'],
  ['仰卧','full_single_P049'],['俯卧','full_single_P051'],['侧躺','full_single_P050'],['抱头','full_single_P011'],
  ['单膝跪','full_single_P033'],['托腮','full_single_P012'],['前倾','full_single_P069'],['后仰','full_single_P011'],
  ['抬腿','full_single_P024'],['扶膝','full_single_P033'],['过头','full_single_P057'],['伸展','full_single_P019'],
  ['盘腿','pair60_P042'],['侧坐','full_single_P047'],['后撑','full_single_P003'],['半身 比心','upper80v2_P001'],
  ['比耶','upper80v2_P004'],['抱臂','upper80v2_P041'],['回眸','full_sexy_P003'],['仰头','full_single_P037'],
  ['牵手','pair60_P008'],['面对面','pair60_P001'],['拥抱','pair60_P042'],['张开双臂','full_single_P077'],
  ['P001','full_single_P001'],['full_single_P019_side','full_single_P019'],['chayao','full_single_P018'],['cy','full_single_P018'],
  ['xiongqianshuangshoubixin','upper80v2_P001'],['xqssbx','upper80v2_P001'],['shuangshoubaotou','full_single_P011'],
  ['jushou','full_single_P019'],['全身 单人 俯视 举手','full_single_P019'],
];
const negatives=[
  ['抱臂','full_single_P011'],['抱头','upper80v2_P041'],['仰卧','full_single_P051'],['俯卧','full_single_P049'],
  ['单膝跪','full_single_P001'],['抬膝','full_single_P033'],['单人','pair60_P051'],['双人','upper80v2_P001'],
  ['上半身','full_single_P019'],['全身','upper80v2_P001'],['仰卧 俯卧','full_single_P049'],
  ['单人 双人','pair60_P001'],['全身 半身','upper80v2_P001'],['正面 侧面','full_single_P019'],
  ['full_sexy_P018_low','full_sexy_P018'],['拥抱','pair60_P059'],['拥抱','upper80v2_P050'],
  ['握手','upper80v2_P038'],['向左倾','full_single_P009'],['P999','full_single_P001'],
];
test('pinned corpus keeps all 288 groups and 1439 actual views',()=>{
  assert.equal(corpus.items.length,288);assert.equal(corpus.items.reduce((n,item)=>n+item.views.length,0),1439);
});
test('40 independently selected search examples find the named source action',()=>{
  const failures=[];
  for(const [query,expected] of positives)if(!searchGallery(index,{query}).some(row=>key(row)===expected))failures.push({query,expected});
  assert.deepEqual(failures,[]);
});
test('20 confusions stay excluded rather than silently relaxing the query',()=>{
  const failures=[];
  for(const [query,excluded] of negatives)if(searchGallery(index,{query}).some(row=>key(row)===excluded))failures.push({query,excluded});
  assert.deepEqual(failures,[]);
});
test('exact identifiers rank first, missing low view stays missing, pinyin has full title coverage',()=>{
  assert.equal(searchGallery(index,{query:'full_single_P019'})[0]?.system,'full_single');
  assert.equal(searchGallery(index,{query:'P001'}).length,4);
  for(const row of index)assert.ok(row.pinyin.length>=2,key(row.item));
  const side=searchGallery(index,{query:'侧面站姿举手'});
  assert.ok(side.length>0);for(const row of side)assert.ok(row.matchedViewIds.every(id=>id.endsWith('_side')));
  assert.equal(searchGallery(index,{query:'full_sexy_P018',angle:'low'}).length,0);
});
test('full corpus search latency remains below a usable interactive budget',t=>{
  const samples=[];
  for(let run=0;run<5;run++)for(const [query] of positives){const start=performance.now();searchGallery(index,{query});samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);const p95=samples[Math.floor(samples.length*.95)];t.diagnostic(`200 full-corpus queries: p95 ${p95.toFixed(2)} ms`);
  assert.ok(p95<100,`p95 ${p95} ms`);
});
