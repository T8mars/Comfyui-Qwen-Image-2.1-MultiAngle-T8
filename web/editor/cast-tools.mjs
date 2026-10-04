import { editableActors, bindActor } from './actors.mjs?v=20261004mp1';
import { PRESETS } from './scene.mjs?v=20261004mp1';

const $ = id => document.getElementById(id);
export function installCastTools(context) {
  const panel = document.createElement('details'); panel.className = 'panel-block';
  panel.innerHTML = `<summary>互动编排与道具 <span class="tag">SCENE</span></summary><label>编排<select id="cast-layout"><option value="group">合影 · 面向镜头</option><option value="dialogue">对话 · 面向彼此</option><option value="handshake">握手 · 对齐双手</option></select></label><button id="apply-layout" class="wide-button">应用到选中人物</button><p class="hint">锁定人物保持原状。握手为一次 IK 对齐，之后可自由编辑；不模拟碰撞。</p><button id="align-contact" class="wide-button">再次对齐双手</button><button id="release-contact" class="wide-button">清除接触锚点</button><button id="add-prop" class="wide-button">＋ 导入 GLB 道具</button><div id="prop-list" class="prop-list"></div>`;
  $('hands-panel').before(panel);
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.glb'; file.hidden = true; document.body.append(file);
  const mutate = action => context.run(async () => {
    const previous = structuredClone(context.doc()); context.begin();
    try { await action(); context.changed(); render(); }
    catch(error) { context.replace(previous); await context.studio().restore(previous); throw error; }
  });
  $('apply-layout').onclick = () => mutate(async () => {
    const doc=context.doc(), roles=editableActors(doc,'selected');
    if(!roles.length) throw new Error('请先选中未锁定的人物');
    const layout=$('cast-layout').value;if(layout!=='group'&&roles.length!==2)throw new Error('对话和握手请选中两位未锁定人物');
    context.studio().syncPose(); const active=doc.activeActorId;
    for(const[i,role]of roles.entries()){
      role.pose=structuredClone(PRESETS[0]); role.pose={bones:role.pose.bones};
      role.transform.x=(i-(roles.length-1)/2)*(layout==='group'?7:6);role.transform.z=0;role.transform.y=0;role.transform.yaw=layout==='group'?0:i===0?90:-90;
    }
    bindActor(doc,active);await context.studio().restore(doc);context.studio().useRigPose();context.studio().groundActors(roles.map(role=>role.id));
    if(layout==='handshake') await context.studio().alignHands(roles[0].id,'r',roles[1].id,'r');
    context.showScene();context.toast('编排已应用；可继续调整机位、站位或关节');
  });
  $('align-contact').onclick = () => mutate(async()=>{const roles=editableActors(context.doc(),'selected');if(roles.length!==2)throw new Error('请选中两位未锁定人物');await context.studio().alignHands(roles[0].id,'r',roles[1].id,'r');});
  $('release-contact').onclick = ()=>{context.begin();context.doc().contacts=[];context.changed(false);context.toast('接触锚点已清除，当前姿势保留');};
  $('add-prop').onclick = ()=>file.click();
  file.onchange = ()=>{const chosen=file.files[0];file.value='';if(!chosen)return;
    mutate(async()=>{if(context.doc().source.kind!=='human')throw new Error('请先切换到人偶场景，再导入同场道具');const asset=await context.upload(chosen);const prop={id:`prop-${crypto.randomUUID()}`,label:chosen.name,asset,transform:{x:0,y:0,z:-5,scale:1,yaw:0},visible:true,locked:false};context.doc().props||=[];context.doc().props.push(prop);await context.studio().restoreProps();});
  };
  function render(){
    $('prop-list').replaceChildren();
    for(const prop of context.doc().props||[]){
      const card=document.createElement('div');card.className='prop-card';const title=document.createElement('strong');title.textContent=prop.label;card.append(title);
      for(const[key,label]of [['x','X'],['y','Y'],['z','Z'],['scale','尺度'],['yaw','朝向°']]){const row=document.createElement('label'),input=document.createElement('input');input.type='number';input.step=key==='yaw'?'1':'.1';input.value=prop.transform[key];input.disabled=prop.locked;row.append(document.createTextNode(label),input);input.onchange=()=>{const n=Number(input.value);if(!Number.isFinite(n)||key==='scale'&&n<=0)return;context.begin();prop.transform[key]=n;context.studio().updateProp(prop);context.changed();};card.append(row);}
      const actions=document.createElement('div');actions.className='compact-actions';
      for(const[text,action]of [[prop.visible?'隐藏':'显示',()=>{prop.visible=!prop.visible;context.studio().updateProp(prop);}],[prop.locked?'解锁':'锁定',()=>{prop.locked=!prop.locked;}],['删除',async()=>{context.doc().props=context.doc().props.filter(item=>item.id!==prop.id);await context.studio().restoreProps();}]]){const button=document.createElement('button');button.textContent=text;button.onclick=()=>mutate(action);actions.append(button);}
      card.append(actions);$('prop-list').append(card);
    }
  }
  let key;return()=>{const next=JSON.stringify(context.doc().props||[]);if(next!==key){key=next;render();}};
}
