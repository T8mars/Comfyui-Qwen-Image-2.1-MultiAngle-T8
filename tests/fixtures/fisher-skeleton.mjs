import { ORDER, LIMBS, COLORS } from "../../web/editor/openpose.mjs";

export function multiSkeleton(count, occludedHead=false) {
  const width=count*170+40,height=280,data=new Uint8ClampedArray(width*height*4),people=[];
  const paint=(x,y,color)=>{if(x<0||x>=width||y<0||y>=height)return;const i=(y*width+x)*4;data[i]=parseInt(color.slice(1,3),16);data[i+1]=parseInt(color.slice(3,5),16);data[i+2]=parseInt(color.slice(5,7),16);data[i+3]=255;};
  for(let person=0;person<count;person++) {
    const hidden=Array.isArray(occludedHead)?occludedHead.includes(person):occludedHead;
    const cx=person*170+100,offset=person%2*6,points={head:[cx,25+offset],neck:[cx,55+offset],rs:[cx-30,65+offset],re:[cx-48,105+offset],rw:[cx-62,145+offset],ls:[cx+30,65+offset],le:[cx+48,105+offset],lw:[cx+62,145+offset],rh:[cx-20,140+offset],rk:[cx-25,190+offset],ra:[cx-28,245+offset],lh:[cx+20,140+offset],lk:[cx+25,190+offset],la:[cx+28,245+offset]};people.push(points);
    LIMBS.forEach(([a,b],index)=>{if(hidden&&index===12)return;const p=points[ORDER[a]],q=points[ORDER[b]],steps=Math.ceil(Math.hypot(q[0]-p[0],q[1]-p[1]));for(let step=0;step<=steps;step++){const x=Math.round(p[0]+(q[0]-p[0])*step/steps),y=Math.round(p[1]+(q[1]-p[1])*step/steps);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)paint(x+dx,y+dy,COLORS[index]);}});
    ORDER.forEach((name,index)=>{if(hidden&&name==='head')return;const [x,y]=points[name];for(let dy=-5;dy<=5;dy++)for(let dx=-5;dx<=5;dx++)if(dx*dx+dy*dy<=25)paint(x+dx,y+dy,COLORS[index]);});
    if(hidden){const [x,y]=points.head;for(let dy=-5;dy<=5;dy++)for(let dx=-5;dx<=5;dx++)if(dx*dx+dy*dy<=25)paint(x+dx,y+dy,'#ffffff');}
  }
  return{image:{data,width,height},people};
}
