import { ORDER, LIMBS, COLORS } from './openpose.mjs?v=20261009v160';

export function galleryKeypointFrame(people, width, height) {
  return { canvas_width: width, canvas_height: height, people: people.map(person => {
    const body = Array(54).fill(0);
    ORDER.forEach((name, index) => {
      const point = person.points?.[name];
      if (!point) return;
      if (point.length !== 2 || !point.every(Number.isFinite) || point[0] < 0 || point[0] >= width || point[1] < 0 || point[1] >= height) throw new Error('标记的关节超出图片范围');
      body.splice(index * 3, 3, point[0], point[1], 1);
    });
    return { pose_keypoints_2d: body };
  }) };
}

// User corrections belong to this isolated preview until the final apply operation.
export function installGalleryKeypoints(container, asset, onChange) {
  const ns = 'http://www.w3.org/2000/svg', names = ['头部','颈部','右肩','右肘','右腕','左肩','左肘','左腕','右髋','右膝','右踝','左髋','左膝','左踝'];
  const width = asset.width, height = asset.height;
  let people = [], boxes = [], dragging = null, edited = false;
  const details = document.createElement('details'); details.className = 'pg-keypoints';
  const summary = document.createElement('summary'); summary.textContent = '线稿未检出或骨架不准？框选人物 / 修正关节';
  const help = document.createElement('p'); help.className = 'hint'; help.textContent = '框选模式：拖动圈出每个人，再点击“按框提取”。标点模式：选择人物和关节，点击原图修正；只标可见关节，缺失关节不补猜。';
  const bar = document.createElement('div'); bar.className = 'compact-actions';
  const mode = document.createElement('select'); mode.setAttribute('aria-label','标注模式'); mode.append(new Option('框选人物（拖动）','box'),new Option('修正关节（点击）','point'));
  const person = document.createElement('select'); person.setAttribute('aria-label','标注人物');
  const joint = document.createElement('select'); joint.setAttribute('aria-label','待标记关节');
  ORDER.forEach((name,index) => joint.append(new Option(names[index],name)));
  const button = (text, fn) => { const node = document.createElement('button'); node.type='button'; node.textContent=text; node.onclick=fn; return node; };
  const add = button('新增标注人物', () => { if(people.length>=9)return; people.push({id:`manual-${people.length+1}`,points:{}}); refreshPeople(people.length-1); mode.value='point'; edited=true; onChange(); });
  const removePoint = button('清除此关节', () => { if(people[Number(person.value)]) { delete people[Number(person.value)].points[joint.value];edited=true;render();onChange(); } });
  const clear = button('清空选框', () => { boxes=[];render(); });
  const whole = button('整张图作为单人区域', () => { boxes=[[0,0,width,height]];render(); });
  bar.append(mode,person,joint,add,removePoint,clear,whole);
  const canvas = document.createElementNS(ns,'svg');canvas.setAttribute('viewBox',`0 0 ${width} ${height}`);canvas.setAttribute('role','img');canvas.setAttribute('aria-label','在来源图上框选人物或修正关节');canvas.style.touchAction='none';
  const image=document.createElementNS(ns,'image');image.setAttribute('href',`/anyangle-studio/assets/${encodeURIComponent(asset.name)}`);image.setAttribute('width',width);image.setAttribute('height',height);
  const overlay=document.createElementNS(ns,'g');overlay.style.pointerEvents='none';canvas.append(image,overlay);
  const count=document.createElement('p');count.className='hint';
  details.append(summary,help,bar,canvas,count);container.append(details);
  const shape=(type,attributes)=>{const node=document.createElementNS(ns,type);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);overlay.append(node);return node;};
  function render(){
    overlay.replaceChildren();
    boxes.forEach((box,index)=>{shape('rect',{x:box[0],y:box[1],width:box[2]-box[0],height:box[3]-box[1],fill:'#18bed51a',stroke:'#087b97','stroke-width':4});const text=shape('text',{x:box[0]+8,y:box[1]+30,fill:'#087b97','font-size':28});text.textContent=index+1;});
    const points=people[Number(person.value)]?.points||{};
    for(const [i,[a,b]] of LIMBS.entries())if(points[ORDER[a]]&&points[ORDER[b]])shape('line',{x1:points[ORDER[a]][0],y1:points[ORDER[a]][1],x2:points[ORDER[b]][0],y2:points[ORDER[b]][1],stroke:COLORS[i],'stroke-width':5});
    ORDER.forEach((name,index)=>{if(points[name])shape('circle',{cx:points[name][0],cy:points[name][1],r:name===joint.value?10:6,fill:COLORS[index],stroke:'#111','stroke-width':2});});
    count.textContent=`${boxes.length} 个人物选框 · 当前人物 ${Object.keys(points).length} 个可见关节`;
  }
  function refreshPeople(index=0){person.replaceChildren(...people.map((row,i)=>new Option(`人物 ${i+1}`,i)));person.value=String(index);render();}
  function coordinate(event){const point=canvas.createSVGPoint();point.x=event.clientX;point.y=event.clientY;const at=point.matrixTransform(canvas.getScreenCTM().inverse());return [Math.max(0,Math.min(width-.01,at.x)),Math.max(0,Math.min(height-.01,at.y))];}
  canvas.onpointerdown=event=>{if(event.button!==0)return;const at=coordinate(event);if(mode.value==='point'){
    const row=people[Number(person.value)];if(!row)return;row.points[joint.value]=at;edited=true;render();onChange();
  }else{if(boxes.length>=9)return;dragging=at;canvas.setPointerCapture(event.pointerId);}};
  canvas.onpointerup=event=>{if(!dragging)return;const end=coordinate(event),box=[Math.min(dragging[0],end[0]),Math.min(dragging[1],end[1]),Math.max(dragging[0],end[0]),Math.max(dragging[1],end[1])];dragging=null;if(box[2]-box[0]>=16&&box[3]-box[1]>=16)boxes.push(box);render();};
  canvas.onpointercancel=()=>{dragging=null;};person.onchange=joint.onchange=render;
  refreshPeople();
  return { details, bar, regions:()=>structuredClone(boxes), edited:()=>edited,
    frame:()=>galleryKeypointFrame(people,width,height), people:()=>structuredClone(people),
    setPeople(value){people=structuredClone(value);edited=false;refreshPeople();}, open(){details.open=true;},
    setBusy(value){bar.inert=value;canvas.style.pointerEvents=value?'none':'';} };
}
