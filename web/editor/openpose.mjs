// Adapted from Work-Fisher/ComfyUI-Fisher-Pose (MIT, Copyright 2026 Work-Fisher).
export const ORDER = ['head','neck','rs','re','rw','ls','le','lw','rh','rk','ra','lh','lk','la'];
export const LIMBS = [[1,2],[1,5],[2,3],[3,4],[5,6],[6,7],[1,8],[8,9],[9,10],[1,11],[11,12],[12,13],[1,0]];
export const COLORS = ['#ff0000','#ff5500','#ffaa00','#ffff00','#aaff00','#55ff00','#00ff00','#00ff55','#00ffaa','#00ffff','#00aaff','#0055ff','#0000ff','#5500ff'];

const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function hue(r,g,b) {
    const hi=Math.max(r,g,b),lo=Math.min(r,g,b),delta=hi-lo;
    if(hi<75||delta<hi*.6)return -1;
    const value=hi===r?(g-b)/delta:hi===g?(b-r)/delta+2:(r-g)/delta+4;
    return (value*60+360)%360;
}

// Recognize bright, round body-joint markers; validate each connection against
// the limb palette. This is intentionally not a pose estimator for photographs.
export function detectSkeleton({data,width,height},diagnostics=null) {
    const count=width*height,mask=new Int8Array(count).fill(-1),hues=new Float32Array(count).fill(-1);
    let colored=0;
    for(let i=0;i<count;i++) {
        if(data[i*4+3]<128)continue;
        const r=data[i*4],g=data[i*4+1],b=data[i*4+2],h=hue(r,g,b);hues[i]=h;
        if(h<0)continue;colored++;
        const index=Math.round(h/20)%18,delta=Math.min(Math.abs(h-index*20),360-Math.abs(h-index*20));
        if(index<14&&delta<8&&Math.max(r,g,b)>175)mask[i]=index;
    }
    if(colored>count*.2||colored<30)throw Error('未识别到标准彩色骨架，请上传黑底 OpenPose 身体骨架图');
    // Distance to the edge separates round joint markers from thin bones even
    // when a joint and a touching bone have the same palette color.
    const radii=new Float32Array(count);
    for(let pass=0;pass<2;pass++)for(let step=0;step<count;step++){
        const i=pass?count-1-step:step,color=mask[i];if(color<0)continue;
        const x=i%width,y=Math.floor(i/width),sign=pass?1:-1;
        let value=pass?radii[i]:1e6;
        for(const [dx,dy,cost]of [[sign,0,1],[0,sign,1],[sign,sign,Math.SQRT2],[-sign,sign,Math.SQRT2]]){
            const nx=x+dx,ny=y+dy,j=ny*width+nx;
            value=Math.min(value,(nx<0||nx>=width||ny<0||ny>=height||mask[j]!==color?0:radii[j])+cost);
        }
        radii[i]=value;
    }
    const candidates=Array.from({length:14},()=>[]),queue=new Int32Array(count);
    for(let seed=0;seed<count;seed++) {
        const color=mask[seed];if(color<0)continue;
        let start=0,end=1,sx=0,sy=0,sxx=0,syy=0,sxy=0;queue[0]=seed;mask[seed]=-1;
        while(start<end) {
            const index=queue[start++],x=index%width,y=Math.floor(index/width);
            sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
            for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
                const nx=x+dx,ny=y+dy;if(nx<0||nx>=width||ny<0||ny>=height)continue;
                const next=ny*width+nx;if(mask[next]===color){mask[next]=-1;queue[end++]=next;}
            }
        }
        if(end<5)continue;
        let radius=0;for(let j=0;j<end;j++)radius=Math.max(radius,radii[queue[j]]);
        if(radius<2.8)continue;
        const cx=sx/end,cy=sy/end,vx=sxx/end-cx*cx,vy=syy/end-cy*cy,cov=sxy/end-cx*cy;
        const spread=Math.hypot(vx-vy,2*cov),minorAll=(vx+vy-spread)/2,majorAll=(vx+vy+spread)/2;
        if(majorAll>minorAll*3.6&&radius<Math.sqrt(Math.max(0,minorAll))*2.3)continue;
        const core=new Set();for(let j=0;j<end;j++)if(radii[queue[j]]>=radius*.78)core.add(queue[j]);
        while(core.size){
            const cluster=[core.values().next().value];core.delete(cluster[0]);
            for(let j=0;j<cluster.length;j++){
                const index=cluster[j],x=index%width,y=Math.floor(index/width);
                for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
                    const nx=x+dx,ny=y+dy,next=ny*width+nx;
                    if(nx>=0&&nx<width&&ny>=0&&ny<height&&core.delete(next))cluster.push(next);
                }
            }
            const n=cluster.length;if(n<Math.max(3,radius*radius*.08))continue;
            let sx=0,sy=0,sxx=0,syy=0,sxy=0;
            for(const index of cluster){const x=index%width,y=Math.floor(index/width);sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;}
            const x=sx/n,y=sy/n,xx=sxx/n-x*x,yy=syy/n-y*y,xy=sxy/n-x*y;
            const trace=xx+yy,delta=Math.hypot(xx-yy,2*xy),minor=(trace-delta)/2,major=(trace+delta)/2;
            if(major/Math.max(.25,minor)>3.6||n>radius*radius*3)continue;
            candidates[color].push({point:[x,y],radius});
        }
    }
    // Older OpenPose renderers paint limbs over the joint dots. Recover covered
    // markers from intersections of differently colored limb endpoints.
    const lineMask=new Int8Array(count).fill(-1),ends=Array.from({length:13},()=>[]);
    for(let i=0;i<count;i++){const h=hues[i];if(h<0)continue;const c=Math.round(h/20)%18;if(c<13&&Math.abs(h-c*20)<8)lineMask[i]=c;}
    for(let seed=0;seed<count;seed++){
        const color=lineMask[seed];if(color<0)continue;
        let start=0,end=1,sx=0,sy=0,sxx=0,syy=0,sxy=0;queue[0]=seed;lineMask[seed]=-1;
        while(start<end){const i=queue[start++],x=i%width,y=Math.floor(i/width);sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
            for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy,j=ny*width+nx;if(nx>=0&&nx<width&&ny>=0&&ny<height&&lineMask[j]===color){lineMask[j]=-1;queue[end++]=j;}}
        }
        if(end<12)continue;
        const x=sx/end,y=sy/end,xx=sxx/end-x*x,yy=syy/end-y*y,xy=sxy/end-x*y;
        const angle=.5*Math.atan2(2*xy,xx-yy),ux=Math.cos(angle),uy=Math.sin(angle);
        const delta=Math.hypot(xx-yy,2*xy),minor=(xx+yy-delta)/2,major=(xx+yy+delta)/2;
        if(major<minor*2.8||major<6)continue;
        let lo=Infinity,hi=-Infinity;for(let j=0;j<end;j++){const i=queue[j],t=(i%width-x)*ux+(Math.floor(i/width)-y)*uy;lo=Math.min(lo,t);hi=Math.max(hi,t);}
        ends[color].push([x+ux*lo,y+uy*lo],[x+ux*hi,y+uy*hi]);
    }
    const tolerance=Math.max(8,Math.min(width,height)/80);
    for(let joint=0;joint<14;joint++){
        const edges=LIMBS.map((limb,i)=>limb.includes(joint)?i:-1).filter(i=>i>=0);
        const proposed=[];
        if(edges.length===1)proposed.push(...ends[edges[0]]);
        else for(let u=0;u<edges.length;u++)for(let v=u+1;v<edges.length;v++)for(const a of ends[edges[u]])for(const b of ends[edges[v]])if(distance(a,b)<tolerance)proposed.push([(a[0]+b[0])/2,(a[1]+b[1])/2]);
        for(const point of proposed)if(candidates[joint].every(c=>distance(c.point,point)>tolerance))candidates[joint].push({point,radius:3});
    }
    function linkScore(a,b,color) {
        const length=distance(a.point,b.point);if(length<Math.max(a.radius,b.radius)*1.4)return -1;
        let hits=0,total=0;const samples=Math.max(12,Math.ceil(length/2));
        for(let i=2;i<samples-2;i++) {
            const t=i/samples,x=Math.round(a.point[0]*(1-t)+b.point[0]*t),y=Math.round(a.point[1]*(1-t)+b.point[1]*t);
            let found=false;
            for(let dy=-1;dy<=1&&!found;dy++)for(let dx=-1;dx<=1;dx++) {
                if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue;
                const h=hues[(y+dy)*width+x+dx];if(h<0)continue;
                const diff=Math.abs(h-color*20);if(Math.min(diff,360-diff)<11){found=true;break;}
            }
            total++;if(found)hits++;
        }
        return total?hits/total:-1;
    }
    if(diagnostics)diagnostics({candidates,ends,linkScore});
    const originalCandidates=candidates.map(list=>list.slice());
    // Hand and face markers reuse body colors. A body joint must participate
    // in the complete body connection graph, not merely have the right hue.
    if(candidates.some(list=>list.length>160))throw Error('彩色标记过密，无法可靠区分身体骨架');
    let candidateId=0;for(const list of candidates)for(const item of list)item.id=candidateId++;
    const scores=new Map();
    const score=(a,b,color)=>{
        const key=color+':'+Math.min(a.id,b.id)+':'+Math.max(a.id,b.id);
        if(!scores.has(key))scores.set(key,linkScore(a,b,color));
        return scores.get(key);
    };
    for(let pass=0;pass<14;pass++){
        let changed=false;
        for(let color=0;color<LIMBS.length;color++){
            const [a,b]=LIMBS[color];
            for(const [parent,child]of [[a,b],[b,a]]){
                const kept=candidates[parent].filter(p=>candidates[child].some(q=>score(p,q,color)>=.58));
                if(kept.length!==candidates[parent].length){changed=true;candidates[parent]=kept;}
            }
        }
        if(!changed)break;
    }
    const roots=candidates[1];
    if(!roots.length)return recoverOccluded(originalCandidates,ends,linkScore,width,height,tolerance,data);
    if(roots.length>3||candidates.some(list=>list.length>12))throw Error('身体骨架存在多组歧义，暂不能可靠区分最多 3 个人物');
    const people=roots.map(root=>({1:root}));
    for(let color=0;color<LIMBS.length;color++) {
        const [parent,child]=LIMBS[color],options=candidates[child];
        let best=null,bestScore=-Infinity;
        function assign(index,used,selected,totalScore) {
            if(index===people.length){if(totalScore>bestScore){bestScore=totalScore;best=selected.slice();}return;}
            for(let j=0;j<options.length;j++) {
                if(used.has(j))continue;
                const match=score(people[index][parent],options[j],color);
                if(match<.58)continue;
                used.add(j);selected.push(options[j]);assign(index+1,used,selected,totalScore+match);selected.pop();used.delete(j);
            }
        }
        assign(0,new Set(),[],0);
        if(!best)throw Error('骨架关节缺失、重叠或配色不匹配，暂未应用；请换完整的 OpenPose 骨架图');
        people.forEach((person,index)=>person[child]=best[index]);
    }
    return people.map(person=>Object.fromEntries(ORDER.map((name,index)=>[name,person[index].point]))).sort((a,b)=>a.neck[0]-b.neck[0]);
}

function recoverOccluded(original,ends,pixelScore,width,height,tolerance,data) {
    const edgeCache=new Map();
    const linkScore=(a,b,color)=>{
        const key=color+':'+a.point.join(',')+':'+b.point.join(',');
        if(!edgeCache.has(key))edgeCache.set(key,pixelScore(a,b,color));
        return edgeCache.get(key);
    };
    const pools=original.map(list=>list.map(item=>({...item}))),children=Array.from({length:14},()=>[]);
    LIMBS.forEach(([a,b],color)=>children[a].push({child:b,color}));
    const add=(joint,point,estimated=false)=>{
        if(pools[joint].every(p=>distance(p.point,point)>tolerance*.55))pools[joint].push({point,radius:2,estimated});
    };
    // Retain all limb endpoints, including points hidden under another limb.
    LIMBS.forEach(([a,b],color)=>{for(const point of ends[color]){add(a,point);add(b,point);}});
    // Collapsed shoulders may share the neck's image coordinate.
    for(const shoulder of [2,5])for(const root of pools[1])add(shoulder,root.point,true);
    // Extrapolate only chains with no supported visible continuation. Tie each
    // estimate to its parent candidate, so another person's limb cannot use it.
    for(const [root,middle,tip]of [[2,3,4],[5,6,7],[8,9,10],[11,12,13]]){
        for(const [a,b,previous]of [[root,middle,1],[middle,tip,root]]){
            const color=LIMBS.findIndex(([u,v])=>u===a&&v===b);
            const priorColor=LIMBS.findIndex(([u,v])=>u===previous&&v===a);
            for(const parent of pools[a].slice(0,60)){
                if(pools[b].some(q=>linkScore(parent,q,color)>=.4))continue;
                for(const prior of pools[previous].slice(0,60)){
                if(pools[b].length>=160)break;
                if(priorColor>=0&&!parent.estimated&&linkScore(prior,parent,priorColor)<.4)continue;
                const dx=parent.point[0]-prior.point[0],dy=parent.point[1]-prior.point[1];
                if(Math.hypot(dx,dy)<tolerance*2)continue;
                const point=[parent.point[0]+dx*.9,parent.point[1]+dy*.9];
                if(point[0]>-width&&point[0]<width*2&&point[1]>-height&&point[1]<height*2)
                    pools[b].push({point,radius:2,estimated:true,from:parent});
                }
            }
        }
    }
    // Dense white facial landmarks can entirely cover the nose/neck line.
    // Use their local centroid only as an explicitly estimated head position.
    for(const root of pools[1]){
        if(pools[0].some(head=>linkScore(root,head,12)>=.3))continue;
        const radius=Math.min(width,height)*.14;let sx=0,sy=0,n=0;
        for(let y=Math.max(0,Math.floor(root.point[1]-radius));y<Math.min(height,root.point[1]+radius);y++)
        for(let x=Math.max(0,Math.floor(root.point[0]-radius));x<Math.min(width,root.point[0]+radius);x++){
            const i=(y*width+x)*4;
            if(data[i]>220&&data[i+1]>220&&data[i+2]>220&&data[i+3]>128){sx+=x;sy+=y;n++;}
        }
        if(n>=12&&n<radius*radius*.5)pools[0].push({point:[sx/n,sy/n],radius:2,estimated:true,from:root});
    }
    if(pools.some(list=>list.length>200))throw Error('骨架标记过密，无法可靠区分身体');
    let id=0;for(const list of pools)for(const p of list)p.id=id++;
    const memo=new Map();
    function solve(joint,point) {
        const key=joint+':'+point.id;if(memo.has(key))return memo.get(key);
        let total=0,visible=0,nodes={[joint]:point},estimated=[];
        for(const {child,color}of children[joint]){
            let best=null;
            for(const option of pools[child]){
                if(option.from&&option.from!==point)continue;
                const length=distance(point.point,option.point),raw=linkScore(point,option,color);
                const collapsed=length<tolerance;
                let value=raw;
                if(option.estimated)value=.16;
                else if(collapsed)value=[2,5,8,11].includes(child)?.18:.03;
                else if(raw<.30)continue;
                const sub=solve(child,option);if(!sub)continue;
                const score=sub.total+value;
                if(!best||score>best.total)best={total:score,visible:sub.visible+(raw>=.58&&!collapsed&&!option.estimated?1:0),nodes:sub.nodes,estimated:[...sub.estimated,...(raw<.58||collapsed||option.estimated?[child]:[])]};
            }
            if(!best){memo.set(key,null);return null;}
            total+=best.total;visible+=best.visible;Object.assign(nodes,best.nodes);estimated.push(...best.estimated);
        }
        const result={total,visible,nodes,estimated};memo.set(key,result);return result;
    }
    const solutions=pools[1].map(root=>solve(1,root)).filter(s=>s&&s.visible>=9&&s.total>=8.5).sort((a,b)=>b.total-a.total);
    if(!solutions.length)throw Error('可见的身体关节不足，无法可靠补全；请使用更完整的骨架图');
    const chosen=[];
    for(const solution of solutions){
        if(chosen.some(other=>Object.keys(solution.nodes).filter(k=>distance(solution.nodes[k].point,other.nodes[k].point)<tolerance*2).length>2))continue;
        chosen.push(solution);if(chosen.length===3)break;
    }
    const people=chosen.map(solution=>Object.fromEntries(ORDER.map((name,joint)=>[name,solution.nodes[joint].point]))).sort((a,b)=>a.neck[0]-b.neck[0]);
    const inferred=[...new Set(chosen.flatMap(solution=>solution.estimated.map(index=>ORDER[index])))];
    people.warnings=['重叠或裁切的关节已近似补全，请检查姿势'];
    people.inferredJoints=inferred;
    return people;
}

export function readSkeletonImage(image) {
    const factor=Math.min(1,1400/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');canvas.width=Math.round(image.naturalWidth*factor);canvas.height=Math.round(image.naturalHeight*factor);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const people=detectSkeleton(ctx.getImageData(0,0,canvas.width,canvas.height));
    const result=people.map(points=>Object.fromEntries(Object.entries(points).map(([key,[x,y]])=>[key,[x/factor,y/factor]])));
    result.warnings=people.warnings||[];result.inferredJoints=people.inferredJoints||[];return result;
}


// Lift a single 2D OpenPose body (pixels, from pose-import.mjs readSkeletonImage)
// into 3D keypoints for the VNCCS mannequin. A 2D skeleton has no depth, so each
// segment's depth comes from foreshortening: |dz| = sqrt(L² - l²), where L is the
// mannequin's bone length and l the projected length. The front/back sign is a
// heuristic (knees, elbows, hands forward; shins back) that the user can flip.

// [key, from, to, default forward sign, flip group]
export const LIFT_SEGMENTS = [
    ['torso', 'hipMid', 'neck', 1, 'torso'],
    ['lUpperArm', 'ls', 'le', 1, 'lArmUpper'], ['lForearm', 'le', 'lw', 1, 'lArmLower'],
    ['rUpperArm', 'rs', 're', 1, 'rArmUpper'], ['rForearm', 're', 'rw', 1, 'rArmLower'],
    ['lThigh', 'lh', 'lk', 1, 'lLegUpper'], ['lShin', 'lk', 'la', -1, 'lLegLower'],
    ['rThigh', 'rh', 'rk', 1, 'rLegUpper'], ['rShin', 'rk', 'ra', -1, 'rLegLower'],
];
// A flipped upper segment mirrors the whole limb, like folding it to the other side.
const LIMB_OF = { lArmLower: 'lArmUpper', rArmLower: 'rArmUpper', lLegLower: 'lLegUpper', rLegLower: 'rLegUpper' };

const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
const length = v => Math.hypot(...v);

export function isFacingAway(points) {
    // In a front view the subject's right shoulder is on the image's left.
    const shoulders = points.rs[0] - points.ls[0];
    const hips = points.rh[0] - points.lh[0];
    return (Math.abs(shoulders) >= Math.abs(hips) ? shoulders : hips) > 0;
}

/**
 * @param points {head(nose), neck, ls, le, lw, rs, re, rw, lh, lk, la, rh, rk, ra}: [x, y] image pixels
 * @param rest same keys plus hipMid, as [x, y, z] mannequin rest positions (neck = shoulder midpoint)
 * @param flips {torso, body, lArmUpper, lArmLower, ...}: true = invert that depth guess
 * @returns {kps, facingAway, scale} with kps relative to the hip midpoint, y up, +z toward the camera
 */
export function liftOpenPose(points, rest, flips = {}) {
    const p2 = Object.fromEntries(Object.entries(points).map(([key, [x, y]]) => [key, [x, -y]]));
    p2.hipMid = mid(p2.lh, p2.rh);
    const restLength = ([, a, b]) => length(sub(rest[b], rest[a]));
    const imageLength = ([, a, b]) => length(sub(p2[b], p2[a]));
    // The second-least foreshortened segment sets pixels→world, tolerating one odd proportion.
    const ratios = LIFT_SEGMENTS.filter(seg => imageLength(seg) > 1e-3).map(seg => restLength(seg) / imageLength(seg)).sort((a, b) => a - b);
    if (!ratios.length) throw Error('骨架关节重合，无法换算成人偶姿势');
    const scale = ratios[Math.min(1, ratios.length - 1)];
    const depth = seg => Math.sqrt(Math.max(0, restLength(seg) ** 2 - (scale * imageLength(seg)) ** 2));
    const sign = key => {
        const [, , , forward, group] = LIFT_SEGMENTS.find(seg => seg[0] === key);
        const flipped = Boolean(flips[group]) !== Boolean(LIMB_OF[group] && flips[LIMB_OF[group]]);
        return flipped ? -forward : forward;
    };
    const planar = (from, to) => [...sub(p2[to], p2[from]).map(v => v * scale), 0];
    const segment = key => LIFT_SEGMENTS.find(seg => seg[0] === key);
    const step = (base, key) => {
        const seg = segment(key);
        const offset = planar(seg[1], seg[2]);
        offset[2] = depth(seg) * sign(key);
        return add(base, offset);
    };

    // Body turn: a narrowed shoulder/hip line means the torso rotated about the vertical axis.
    // The nose leaning to the image right means the subject turned toward its own left,
    // which pulls the left side back and the right side forward.
    const turn = Math.sign(p2.head[0] - p2.neck[0]) || 1;
    const halfDepth = (a, b, restA, restB) => Math.sqrt(Math.max(0, length(sub(rest[restA], rest[restB])) ** 2 - (scale * length(sub(p2[a], p2[b]))) ** 2)) / 2;
    const shoulderTurn = halfDepth('ls', 'rs', 'ls', 'rs') * turn;
    const hipTurn = halfDepth('lh', 'rh', 'lh', 'rh') * turn;

    const kps = { hipMid: [0, 0, 0] };
    kps.lh = [...planar('hipMid', 'lh').slice(0, 2), -hipTurn];
    kps.rh = [...planar('hipMid', 'rh').slice(0, 2), hipTurn];
    kps.neck = step(kps.hipMid, 'torso');
    if (flips.torso) kps.neck[2] = -kps.neck[2];
    kps.ls = add(kps.neck, [...planar('neck', 'ls').slice(0, 2), -shoulderTurn]);
    kps.rs = add(kps.neck, [...planar('neck', 'rs').slice(0, 2), shoulderTurn]);
    kps.head = add(kps.neck, planar('neck', 'head'));
    kps.le = step(kps.ls, 'lUpperArm'); kps.lw = step(kps.le, 'lForearm');
    kps.re = step(kps.rs, 'rUpperArm'); kps.rw = step(kps.re, 'rForearm');
    kps.lk = step(kps.lh, 'lThigh'); kps.la = step(kps.lk, 'lShin');
    kps.rk = step(kps.rh, 'rThigh'); kps.ra = step(kps.rk, 'rShin');

    // A back view is the depth mirror of the same picture seen from the front.
    const facingAway = isFacingAway(points) !== Boolean(flips.body);
    if (facingAway) for (const point of Object.values(kps)) point[2] = -point[2];
    return { kps, facingAway, scale };
}

// Keys expected by PoseViewerCore.applyWorldKeypointImport.
export const WORLD_KEYPOINT_NAMES = {
    hipMid: 'pelvis', neck: 'neck', head: 'head',
    ls: 'left_shoulder', le: 'left_elbow', lw: 'left_wrist', rs: 'right_shoulder', re: 'right_elbow', rw: 'right_wrist',
    lh: 'left_hip', lk: 'left_knee', la: 'left_ankle', rh: 'right_hip', rk: 'right_knee', ra: 'right_ankle',
};

// Copy only observed segments in the image plane, without inventing their depth.
export function copyVisiblePose(points, rest) {
    if (!points.ls || !points.rs || !points.neck) throw Error('复制姿势需要清晰可见的左右肩；请使用人物更完整的照片');
    const p2 = Object.fromEntries(Object.entries(points).map(([key, [x, y]]) => [key, [x, -y]]));
    const direction = (a, b) => {
        const vector = sub(p2[b], p2[a]), distance = length(vector);
        if (distance < 1e-3) throw Error('照片关节重合，无法复制该肢体方向');
        return vector.map(value => value / distance);
    };
    const step = (base, a, b) => add(base, [...direction(a, b).map(value => value * length(sub(rest[b], rest[a]))), 0]);
    const hips = !!(p2.lh && p2.rh);
    const kps = { hipMid: rest.pelvis.slice(), neck: rest.neck.slice() };
    if (hips) {
        p2.hipMid = mid(p2.lh, p2.rh);
        kps.neck = step(rest.hipMid, 'hipMid', 'neck');
        const axis = direction('rh', 'lh'), half = length(sub(rest.lh, rest.rh)) / 2;
        kps.lh = add(rest.hipMid, [...axis.map(value => value * half), 0]);
        kps.rh = add(rest.hipMid, [...axis.map(value => -value * half), 0]);
    }
    const shoulderAxis = direction('rs', 'ls'), half = length(sub(rest.ls, rest.rs)) / 2;
    kps.ls = add(kps.neck, [...shoulderAxis.map(value => value * half), 0]);
    kps.rs = add(kps.neck, [...shoulderAxis.map(value => -value * half), 0]);
    if (p2.head) kps.head = step(kps.neck, 'neck', 'head');
    for (const [, from, to] of LIFT_SEGMENTS.slice(1)) {
        if (kps[from] && p2[from] && p2[to]) kps[to] = step(kps[from], from, to);
    }
    return kps;
}
