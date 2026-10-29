import { GALLERY_PINYIN } from './gallery-pinyin.mjs?v=20261029v180';
// An offline action vocabulary: precise matches stay separate from camera-view filters.
export const ACTIONS = [
  ['站姿',['站姿','站立','站着','站立姿势','立姿'],['站姿','站立','站着','立姿'],'zhanzi zhanli zz zl'],
  ['坐姿',['坐姿','坐着','坐下'],['坐','坐位'],'zuozi zuoxia zz zx'],
  ['跪姿',['跪姿','跪着','跪下','跪立'],['跪'],'guizi guixia gz gx'],
  ['蹲姿',['蹲姿','蹲着','蹲下','下蹲'],['蹲'],'dunzi dunxia xiadun dz dx xd'],
  ['仰卧',['仰卧','平躺','躺平','躺着朝上'],['仰卧'],'yangwo pingtang yw pt'],
  ['俯卧',['俯卧','趴卧','趴着','趴下'],['俯卧'],'fuwo pawo fw pw'],
  ['侧卧',['侧卧','侧躺'],['侧卧'],'cewo cetang cw ct'],
  ['举手',['举手','举臂','抬手','双手举高'],['上举','上伸','举臂','举手','上方伸展'],'jushou jubi taishou js jb ts'],
  ['叉腰',['叉腰','扶腰','手扶腰'],['扶腰','叉腰'],'chayao fuyao cy fy'],
  ['抱臂',['抱臂','交叉手臂','交叉双臂'],['抱臂','抱胸','双臂交叉','手臂交叉','双臂于胸下交叉'],'baobi jiaochashuangbi bb jcsb'],
  ['抱头',['抱头','双手抱头'],['抱头','抱后脑'],'baotou bt'],
  ['比心',['比心','心形手势','爱心手势'],['比心','心形'],'bixin xinxingshoushi bx xxss'],
  ['比耶',['比耶','剪刀手','V字手势'],['比V','双V','V字手势','剪刀手'],'biye jiandaoshou by jds'],
  ['托腮',['托腮','撑脸','托脸'],['托腮'],'tuosai chenglian ts cl'],
  ['撩发',['撩发','摸头发','摸发','抚发'],['撩发','抚发','抓发'],'liaofa motoufa liaotoufa lf mtf ltf'],
  ['回头',['回头','回望','回眸','回首'],['回头','回望','回眸','回首'],'huitou huiwang ht hw'],
  ['仰头',['仰头','抬头','仰望'],['仰头','抬头','仰望'],'yangtou taitou yangwang yt tt yw'],
  ['低头',['低头','垂头'],['低头','垂头'],'ditou chuitou dt ct'],
  ['前倾',['前倾','俯身','弯腰'],['前倾','俯身','弯腰'],'qianqing fushen wanyao qq fs wy'],
  ['后仰',['后仰','后倾'],['后仰','后倾'],'houyang houqing hy hq'],
  ['抬腿',['抬腿','举腿'],['抬腿','腿高抬','腿上抬','腿后抬','抬起单腿','腿抬起','抬背・单腿高抬','腿朝天','腿后举'],'taitui jutui tt jt'],
  ['抬膝',['抬膝','膝盖抬起'],['抬膝','膝抬起'],'taixi tx'],
  ['单膝跪',['单膝跪','单膝跪地'],['单膝跪'],'danxigui dxg'],
  ['扶膝',['扶膝','手扶膝','扶着膝盖'],['扶膝'],'fuxi fx'],
  ['过头',['过头','手臂过头'],['过头'],'guotou gt'],
  ['伸展',['伸展','伸懒腰','拉伸'],['伸展','拉伸'],'shenzhan shenlanyao lashen sz sly ls'],
  ['抱膝',['抱膝','抱住膝盖'],['抱膝','双膝抱'],'baoxi bx'],
  ['盘腿',['盘腿','盘坐','盘腿坐'],['盘腿','盘坐'],'pantui panzuo pt pz'],
  ['翘腿',['翘腿','翘二郎腿','二郎腿'],['翘腿','翘二郎腿','二郎腿'],'qiaotui erlangtui qt elt'],
  ['并腿',['并腿','双腿并拢'],['并腿','腿并拢'],'bingtui bt'],
  ['交叠',['交叠','交叉腿'],['交叠','双腿交叉'],'jiaodie jiaochatui jd jct'],
  ['拥抱',['拥抱','抱住','搂抱'],['拥抱','搂抱','被拥','相拥','环抱'],'yongbao loubao yb lb'],
  ['牵手',['牵手','拉手'],['牵手','拉手','双手相拉'],'qianshou lashou qs ls'],
  ['握手',['握手'],['握手'],'woshou ws'],
  ['背靠背',['背靠背'],['背靠背'],'beikaobei bkb'],
  ['面对面',['面对面','相对'],['面对面','相对'],'mianduimian xiangdui mdm xd'],
  ['侧坐',['侧坐'],['侧坐'],'cezuo cz'],
  ['四肢着地',['四肢着地','四点支撑'],['四肢着地','四点支撑'],'sizhizhaodi sidianzhicheng szzd sdzc'],
  ['后撑',['后撑','双手后撑'],['后撑'],'houcheng hc'],
  ['手指交扣',['手指交扣','十指交扣','十指相扣'],['交扣','相扣'],'shizhijiaokou shizhixiangkou szjk szxk'],
  ['张开双臂',['张开双臂','展开双臂'],['展开双臂','双臂张开','双臂展开','展臂'],'zhangkaishuangbi zhankaishuangbi zksb'],
  ['肩上',['肩上','搭肩'],['肩上','搭肩'],'jianshang dajian js dj'],
];
const SPECIAL = [
  ['单人',{people:'1'}],['一人',{people:'1'}],['双人',{people:'2'}],['两人',{people:'2'}],
  ['全身',{frame:'full'}],['半身',{frame:'upper'}],['上半身',{frame:'upper'}],
  ['正面',{angle:'front'}],['侧面',{angle:'side'}],['侧视',{angle:'side'}],
  ['斜侧',{angle:'diag'}],['斜侧面',{angle:'diag'}],['俯视',{angle:'high'}],['仰视',{angle:'low'}],
];
export const normalizeSearch = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[・·，,。:：;；（）()【】\[\]+＋]/g,' ').replace(/\s+/g,' ').trim();
const families = new Map(), words = new Map();
for(const [canonical,aliases,patterns,pinyin] of ACTIONS){
  const family={canonical,patterns:patterns.map(normalizeSearch),pinyin:pinyin.split(' ')};families.set(canonical,family);
  for(const alias of aliases)words.set(normalizeSearch(alias),{action:canonical,term:alias});
  for(const alias of family.pinyin)if(alias.length>=2){
    const prior=words.get(alias);
    if(!prior)words.set(alias,{actions:[canonical],term:alias,pinyin:true});
    else if(prior.pinyin&&!prior.actions.includes(canonical))prior.actions.push(canonical);
  }
}
for(const [term,filter] of SPECIAL)words.set(term,{filter,term});
const vocabulary=[...words.keys()].sort((a,b)=>b.length-a.length);
const knownBody = /仰卧|俯卧|侧卧|坐|跪|蹲|站姿|站立|立姿/;

export function parseGalleryQuery(query){
  const normalized=normalizeSearch(query), tokens=[];
  for(const part of normalized.split(' ').filter(Boolean)){
    if(/^[a-z0-9_-]+$/.test(part)){tokens.push(words.get(part)||{text:part,term:part});continue;}
    let rest=part;
    while(rest){
      const word=vocabulary.find(word=>rest.startsWith(word));
      if(word){tokens.push(words.get(word));rest=rest.slice(word.length);}
      else {
        let stop=1;while(stop<rest.length&&!vocabulary.some(word=>rest.slice(stop).startsWith(word)))stop++;
        tokens.push({text:rest.slice(0,stop),term:rest.slice(0,stop)});rest=rest.slice(stop);
      }
    }
  }
  return {normalized,tokens};
}

export function indexGallery(items){
  return items.map(item=>{
    const name=normalizeSearch(item.name), original=normalizeSearch(item.originalName), tags=(item.tags||[]).map(normalizeSearch);
    const actionText=[name,...tags].join(' '), category=normalizeSearch(item.category);
    const bodyText=knownBody.test(actionText)?actionText:`${actionText} ${category}`;
    const actions=new Set();
    for(const [canonical,family] of families){
      const text=/站姿|坐姿|跪姿|蹲姿|仰卧|俯卧|侧卧/.test(canonical)?bodyText:actionText;
      if(canonical==='拥抱'&&item.people!==2)continue;
      if(family.patterns.some(pattern=>text.includes(pattern)))actions.add(canonical);
    }
    const pinyin=item.source?.id==='ai-pose-gallery-zh'?GALLERY_PINYIN[`${item.system}_${item.number}`]||[]:[];
    return {item,name,original,tags,actions,pinyin,text:normalizeSearch([item.id,item.name,item.originalName,item.number,item.system,item.systemName,...tags].join(' '))};
  });
}

export function searchGallery(index, options={}){
  const {normalized,tokens}=parseGalleryQuery(options.query), results=[];
  for(const row of index){
    const {item}=row;
    if(item.hidden && options.tab!=='hidden' || !item.hidden && options.tab==='hidden')continue;
    if(options.tab==='favorites'&&!item.favorite || options.tab==='recent'&&!item.lastUsed)continue;
    if(options.type && !['all','reference-set'].includes(options.type))continue;
    if(options.source && options.source!==item.source?.id || options.category && options.category!==item.category)continue;
    if(options.collectionIds&&!options.collectionIds.includes(item.id))continue;
    if(options.people && String(item.people)!==String(options.people) || options.frame && item.frame!==options.frame)continue;
    const matched=[],reasons=new Set();let score=0;
    for(const view of item.views || []){
      if(options.angle && options.angle!==view.angle || options.offline==='ready'&&!view.original?.ready)continue;
      let matches=true,viewScore=0;
      for(const token of tokens){
        if(token.filter){
          const ok=Object.entries(token.filter).every(([key,value])=>String(key==='angle'?view.angle:item[key])===value);
          if(!ok){matches=false;break;}viewScore+=30;
        }else if(token.action||token.actions){
          if(!(token.actions||[token.action]).some(action=>row.actions.has(action))&&!(token.pinyin&&row.pinyin.includes(token.term))){matches=false;break;}viewScore+=token.pinyin?10:40;
        }else{
          const id=normalizeSearch(view.id), text=token.text;
          if(!row.text.includes(text)&&!id.includes(text)&&!(text.length>=2&&row.pinyin.some(term=>term===text||text.length>=4&&term.includes(text)))){matches=false;break;}
          viewScore+=id===text?1000:row.name===text?800:row.name.includes(text)?100:20;
        }
      }
      if(matches){matched.push(view.id);score=Math.max(score,viewScore);for(const token of tokens)reasons.add(token.action||token.term);}
    }
    if(!matched.length)continue;
    if(normalized===normalizeSearch(item.id)||normalized===`${item.system}_${item.number}`.toLowerCase())score+=2000;
    if(normalized===row.name)score+=1500;
    results.push({...item,matchedViewIds:matched,matchReasons:[...reasons],searchScore:score});
  }
  results.sort((a,b)=>b.searchScore-a.searchScore || (options.sort==='recent'||options.tab==='recent'? (b.lastUsed||0)-(a.lastUsed||0):0)
    || (options.sort==='favorite'?Number(!!b.favorite)-Number(!!a.favorite):0) || a.name.localeCompare(b.name,'zh-CN') || a.id.localeCompare(b.id));
  return results;
}

export function relatedSuggestions(index,options){
  // Suggestions never change the actual query or silently relax an active filter.
  const result=[];
  for(const key of ['angle','people','frame','category','source','tab'])if(options[key]){
    const count=searchGallery(index,{...options,[key]:''}).length;
    if(count)result.push({field:key,count});
  }
  return result;
}
