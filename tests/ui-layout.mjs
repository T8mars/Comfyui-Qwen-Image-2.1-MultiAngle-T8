// Real editor layout and keyboard checks. Uses the isolated UI fixture server.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function uiLayout(browser, origin, out) {
  const page = await browser.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  const idle = () => page.waitForFunction(() => document.querySelector('#loading').hidden && !document.querySelector('#workspace').inert, {timeout:120000});
  try {
    await page.setViewportSize({width:1440,height:900});
    await page.goto(`${origin}/tests/editor.html`); await idle();
    assert.equal(await page.locator('#download-guide').isEnabled(),false);
    assert.equal(await page.locator('#open-batch').isEnabled(),false);
    await page.locator('#tab-objects').click();
    await page.locator('#add-actor').click(); await idle();
    await page.locator('#model-base').click(); await idle();
    await page.locator('[data-guide="pose"]').click(); await idle();
    // Standalone changes this caption; measure the longer embedded caption too.
    await page.locator('#apply').evaluate(el => {el.lastChild.textContent='应用到节点';});
    for (const [width,height] of [[1920,1080],[1660,1000],[1440,900],[1366,768],[1180,820],[1024,768],[881,700],[880,820],[768,900],[551,800],[550,800],[390,844],[320,650]]) {
      await page.setViewportSize({width,height});
      await page.locator('#pose-occlusion').selectOption('visible'); await idle();
      const geometry = await page.evaluate(() => {
        const label = document.querySelector('#pose-occlusion').closest('label'), title = label.querySelector('span').getBoundingClientRect(), select = label.querySelector('select').getBoundingClientRect();
        const heading = document.querySelector('#camera-heading').getBoundingClientRect(), sliders = document.querySelector('#camera-sliders').getBoundingClientRect(), lens = document.querySelector('#lens-panel').getBoundingClientRect();
        const apply = document.querySelector('#apply').getBoundingClientRect(), dialogs = [...document.querySelectorAll('dialog[open]')].map(el=>el.getBoundingClientRect());
        const copy = document.querySelector('#pose-copy-mode'), copyLabel = copy.closest('label');
        return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,gap:select.top-title.bottom,copyWidth:copy.getBoundingClientRect().width,copyFieldWidth:copyLabel.getBoundingClientRect().width,headingBottom:heading.bottom,slidersTop:sliders.top,lensTop:lens.top,slidersBottom:sliders.bottom,applyRight:apply.right,dialogs:dialogs.map(r=>({left:r.left,right:r.right}))};
      });
      assert.ok(geometry.gap>=7,`${width}px: pose label touches select`);
      assert.ok(Math.abs(geometry.copyWidth-geometry.copyFieldWidth)<=1,`${width}px: pose-copy dropdown must fill the field`);
      assert.ok(geometry.pageWidth<=width,`${width}px: horizontal overflow`);
      assert.ok(geometry.applyRight<=width,`${width}px: apply button clipped`);
      assert.ok(geometry.headingBottom<=geometry.slidersTop,`${width}px: camera sliders precede heading`);
      assert.ok(geometry.slidersBottom<=geometry.lensTop,`${width}px: camera and lens controls interleave`);
      results.push({width,height,...geometry});
    }
    await page.setViewportSize({width:320,height:844});
    await page.locator('#tab-materials').click();
    await page.locator('#tab-materials').press('ArrowRight');
    assert.equal(await page.locator('#tab-objects').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#tab-materials').getAttribute('tabindex'),'-1');
    await page.locator('#open-batch').click();
    const dialog = await page.locator('#batch-dialog').boundingBox();
    assert.ok(dialog.x>=0 && dialog.x+dialog.width<=320,'Batch dialog must fit the smallest viewport');
    await page.locator('#batch-close').click();
    assert.equal(await page.locator('#batch-dialog').isVisible(),false);
    await page.waitForFunction(()=>!document.querySelector('#stage-guide').hidden,{timeout:30000});
    await page.locator('#pose-occlusion').scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(out,'pose-controls-320.png')});
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#pose-occlusion').scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(out,'pose-controls-desktop.png')});
    assert.deepEqual(errors,[]);
    return {viewports:results,emptyGuideActionsDisabled:true,keyboardTabs:true,batchDialog:true,errors};
  } finally {await page.close();}
}
