// Real renderer at four browser DPRs, three output ratios and three camera lenses.
import assert from 'node:assert/strict';
export async function framingMatrix(browser,origin) {
  const cases=[];
  for(const dpr of [1,1.25,1.5,2]) {
    const page=await browser.newPage({viewport:{width:1200,height:840},deviceScaleFactor:dpr});
    try {
      await page.goto(`${origin}/tests/webgl.html`);await page.waitForFunction(()=>window.ready,{timeout:120000});
      const records=await page.evaluate(async()=>{
        const {Vector3}=await import('/web/vendor/three.module.mjs');const s=window.studio,d=window.doc,records=[];
        for(const [width,height] of [[768,768],[1365,768],[432,768]]) for(const focalLength of [24,50,85]) {
          d.width=width;d.height=height;Object.assign(d.camera,{azimuth:35,elevation:18,focalLength,offsetX:0,offsetY:0,offsetZ:0});s.fit();
          Object.assign(d.camera,{offsetX:1.2,offsetY:-.7,offsetZ:1});s.updateShot(true);
          const live=s.viewer.camera,capture=s.viewer.captureCamera,serialize=()=>JSON.stringify({canvas:[s.canvas.width,s.canvas.height],position:live.position.toArray(),projection:live.projectionMatrix.toArray(),capturePosition:capture.position.toArray(),captureProjection:capture.projectionMatrix.toArray(),camera:d.camera});
          const before=serialize(),png=await s.capture();const stable=serialize()===before;
          const image=new Image();image.src=png;await image.decode();
          const distance=capture.position.distanceTo(s.baseTarget),z=new Vector3(0,0,-distance).applyMatrix4(capture.projectionMatrix).z;
          const lower=new Vector3(-1,-1,z).unproject(capture).project(live),upper=new Vector3(1,1,z).unproject(capture).project(live);
          let maxProjectionError=0;
          for(const actor of d.actors) for(const bone of ['head','hand_l','hand_r','foot_l','foot_r']) {
            const world=s.actorBones(actor.id)[bone].getWorldPosition(new Vector3()),output=world.clone().project(capture),display=world.project(live);
            const x=(display.x-lower.x)/(upper.x-lower.x)*2-1,y=(display.y-lower.y)/(upper.y-lower.y)*2-1;
            maxProjectionError=Math.max(maxProjectionError,Math.abs(x-output.x),Math.abs(y-output.y));
          }
          records.push({dpr:devicePixelRatio,width,height,focalLength,stable,decoded:[image.width,image.height],maxProjectionError,people:s.poseJSON().people.length});
        }
        s.dispose();return records;
      });
      for(const record of records){assert.ok(record.stable);assert.deepEqual(record.decoded,[record.width,record.height]);assert.ok(record.maxProjectionError<1e-6,JSON.stringify(record));assert.equal(record.people,2);}
      cases.push(...records);
    } finally {await page.close();}
  }
  return{count:cases.length,maxProjectionError:Math.max(...cases.map(c=>c.maxProjectionError)),cases};
}
