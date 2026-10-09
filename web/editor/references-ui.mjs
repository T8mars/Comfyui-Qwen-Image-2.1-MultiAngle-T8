import { USES, newUse, addReference, upgradeReferences, libraryManifest, libraryPrompt, staleGuide } from './reference-library.mjs?v=20261009v160';
const $ = id => document.getElementById(id);
const copy = value => JSON.parse(JSON.stringify(value));
const imageURL = asset => `/anyangle-studio/assets/${encodeURIComponent(asset.name)}`;
const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
function button(text, action, className = '') { const node = el('button', text, className); node.type = 'button'; node.onclick = action; return node; }
function select(options, value, change) { const node = el('select'); for (const [key, title] of options) node.append(new Option(title, key)); node.value = value; node.onchange = () => change(node.value); return node; }
function field(title, input) { const node = el('label', title); node.append(input); return node; }
let context, key, previewId, connected = [], tab = 'materials', openId, lastMapping = '', mappingWarning = '';
let renderedScene, renderedItems = [];
function edit(action) { context.begin(); action(); context.changed(false); }
function chooseTab(value) { tab = value; refreshReferencesUI(true); $(`tab-${value}`).focus(); }

export function installReferencesUI(value) {
  context = value;
  const left = document.querySelector('.left-panel'), objects = el('div', '', 'reference-objects'); objects.id = 'reference-objects';
  objects.setAttribute('role', 'tabpanel'); objects.setAttribute('aria-labelledby', 'tab-objects');
  objects.append(...left.children); left.append(objects);
  const tabs = el('div', '', 'reference-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '侧栏内容');
  for (const [id, title] of [['materials', '参考素材'], ['objects', '场景对象']]) {
    const node = button(title, () => chooseTab(id)); node.id = `tab-${id}`; node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', `reference-${id}`);
    node.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); chooseTab(event.key === 'Home' ? 'materials' : event.key === 'End' ? 'objects' : tab === 'materials' ? 'objects' : 'materials');
    };
    tabs.append(node);
  }
  left.prepend(tabs);
  const materials = el('section', '', 'reference-materials'); materials.id = 'reference-materials';
  materials.setAttribute('role', 'tabpanel'); materials.setAttribute('aria-labelledby', 'tab-materials');
  materials.innerHTML = `<div class="section-heading"><h2>参考素材 <small>REFERENCE LIBRARY</small></h2><span id="reference-count"></span></div>
    <p class="hint">图片可以是人物、衣饰、产品、场景或风格；展开素材设置用途和目标。</p>
    <div class="reference-source"><img id="library-source-image" alt="场景来源图" hidden><div><strong>场景来源图</strong><p id="library-source-state" class="hint"></p><button id="source-tools">重建 / 提取 / 换图</button><button id="source-to-library">加入参考库</button></div></div>
    <div class="compact-actions"><button id="add-reference" class="primary">＋ 添加素材</button><button id="read-references">读取连线</button></div>
    <div id="legacy-references"><p class="hint">此场景沿用旧版图片规则。升级后可为每张图设置多种用途；升级可撤销。</p><button id="upgrade-references">升级为多用途参考</button></div>
    <div id="reference-cards"></div><p id="reference-empty-note" class="empty-note">添加素材，再选择用途。无需先添加人物。</p>
    <details class="reference-templates"><summary>参考组合模板</summary><select id="reference-template"></select><div class="compact-actions"><button id="save-reference-template">保存组合</button><button id="apply-reference-template">应用组合</button></div><p class="hint">模板保存素材和用途；套用时添加为独立素材，目标需核对。</p></details>`;
  left.insertBefore(materials, objects);
  const stale = el('div', '', 'reference-review'); stale.id = 'reference-source-warning';
  const message = el('p'); message.id = 'reference-source-warning-text';
  const keep = button('沿用已保存的结构图', () => edit(() => { const scene = context.doc(); scene.derivedGuideStale = false; scene.retainedGuideSource = scene.derivedGuideSource;
    scene.conditioning.acceptStoredSource = true; if (scene.openpose) scene.openpose.acceptStoredSource = true; })); keep.id = 'keep-derived-guide';
  stale.append(message, button('重新提取 / 重建', () => chooseTab('objects')), keep); materials.insertBefore(stale, $('reference-cards'));
  const portable = el('div', '', 'compact-actions reference-portable'); portable.append($('export-scene'), $('import-scene')); materials.append(portable);
  const file = el('input'); file.type = 'file'; file.multiple = true; file.accept = 'image/*'; file.hidden = true; document.body.append(file);
  $('add-reference').onclick = () => file.click();
  file.onchange = () => { const files = [...file.files]; file.value = ''; if (!files.length) return;
    context.run(async () => { const scene = context.doc(), assets = []; for (const item of files) assets.push(await context.upload(item, true));
      if (context.doc() !== scene) throw new Error('场景已改变，请重新添加素材');
      edit(() => { if (scene.version !== 3) upgradeReferences(scene); for (const asset of assets) addReference(scene, asset); });
    });
  };
  $('read-references').onclick = () => context.send('anyangle-read-actors');
  $('upgrade-references').onclick = () => edit(() => upgradeReferences(context.doc()));
  $('source-tools').onclick = () => chooseTab('objects');
  $('source-to-library').onclick = () => edit(() => { const scene = context.doc(); if (scene.version !== 3) upgradeReferences(scene); if (scene.reference) addReference(scene, scene.reference); });
  $('save-reference-template').onclick = async () => { const name = await context.askName('保存参考组合', '我的参考组合'); if (!name) return;
    edit(() => { const library = context.doc().referenceLibrary; library.templates ||= []; library.templates.push({ id: crypto.randomUUID(), name, items: copy(library.items) }); });
  };
  $('apply-reference-template').onclick = () => edit(() => {
    const scene = context.doc(), template = scene.referenceLibrary.templates?.find(item => item.id === $('reference-template').value);
    if (!template) return;
    for (const saved of template.items) addReference(scene, saved.asset, { ...copy(saved), id: `ref-${crypto.randomUUID()}`, inputKey: null, missing: false,
      usages: saved.usages.map(use => ({ ...copy(use), id: `use-${crypto.randomUUID()}` })) });
  });
  const mode = el('label', '创作方式', 'reference-workflow');
  const control = select([['guided', '构图引导 + 多图参考'], ['references-only', '仅参考创作 · 无引导'], ['text', '纯文本创作 · 无图片']], 'guided', selected => edit(() => {
    const scene = context.doc(); if (scene.version !== 3) upgradeReferences(scene);
    scene.referenceLibrary.mode = selected;
    if (selected !== 'guided') scene.conditioning.model = 'base';
  })); control.id = 'reference-workflow'; mode.append(control); document.querySelector('.model-switch').after(mode);
  const first = el('div', '', 'reference-first-settings'); first.id = 'reference-first-settings';
  first.innerHTML = `<label>输出画幅参考<select id="first-reference"></select></label><label>首图面积预算<select id="first-reference-resolution"><option value="0">保留原尺寸 · 按32对齐</option><option value="768">768²像素</option><option value="1024">1024²像素</option><option value="1536">1536²像素</option><option value="2048">2048²像素</option></select></label><p class="hint">首图决定实际输出比例和尺寸。其他图使用编码节点的参考预算；纯文本默认1024×1024。</p>`;
  mode.after(first);
  const frame = el('p', '', 'hint'); frame.id = 'reference-frame-state'; first.append(frame);
  $('first-reference').onchange = () => edit(() => { context.doc().referenceLibrary.firstReferenceId = $('first-reference').value || null; });
  $('first-reference-resolution').onchange = () => edit(() => { context.doc().referenceLibrary.firstResolution = Number($('first-reference-resolution').value); });
  const send = el('details', '', 'reference-send-plan'); send.id = 'reference-send-plan';
  send.innerHTML = '<summary id="reference-send-summary"></summary><div id="reference-send-images"></div><p id="reference-send-warning" class="hint"></p><p class="hint">图号为实际送入顺序。目标和来源区域通过提示词描述；全文模式不会自动附加这些用途。</p>';
  document.querySelector('.right-panel').prepend(send);
  const preview = el('div', '', 'reference-stage-preview'); preview.id = 'reference-stage-preview';
  preview.innerHTML = '<div class="reference-preview-title"><strong>参考预览</strong><span>保留3D场景 · 无引导图输出</span></div><img id="reference-stage-image" alt="当前参考素材预览"><p id="reference-stage-empty" class="empty-note">输入提示词，或添加参考素材。</p><div id="reference-stage-thumbs"></div>';
  $('stage').append(preview);
  const crop = el('dialog', '', 'reference-crop-dialog'); crop.id = 'reference-crop-dialog';
  crop.innerHTML = `<form method="dialog"><div class="section-heading"><h2>裁切为独立参考</h2><button value="cancel" formnovalidate>取消</button></div><p class="hint">在图上拖出矩形。裁切会生成新素材和新图号；原图保留。</p><div id="reference-crop-surface"><img id="reference-crop-image" alt="裁切来源"><div id="reference-crop-box"></div></div><div class="crop-fields">${['x','y','width','height'].map(name => `<label>${name}<input id="crop-${name}" type="number" min="${name === 'width' || name === 'height' ? 1 : 0}" required></label>`).join('')}</div><button value="ok" class="primary">保存裁切素材</button></form>`;
  document.body.append(crop); installCropDrag();
}

function useControls(scene, item, use) {
  const panel = el('div', '', 'reference-use');
  const usage = select(Object.entries(USES), use.kind, value => edit(() => { use.kind = value; })); panel.append(field('用途', usage));
  const options = [['scene', '整个画面'], ['text', '文字指定目标'], ...scene.actors.map(actor => [`actor:${actor.id}`, `人物 · ${actor.label}`]), ...(scene.props || []).map(prop => [`prop:${prop.id}`, `道具 · ${prop.label}`])];
  const selected = use.target.kind === 'scene' || use.target.kind === 'text' ? use.target.kind : `${use.target.kind === 'actors' ? 'actor' : 'prop'}:${use.target.ids[0] || ''}`;
  if (!options.some(([id]) => id === selected)) options.push([selected, '待重新分配目标']);
  const target = select(options, selected, value => edit(() => {
    const delimiter = value.indexOf(':'), kind = delimiter < 0 ? value : value.slice(0, delimiter), id = delimiter < 0 ? '' : value.slice(delimiter + 1);
    use.target = { kind: kind === 'actor' ? 'actors' : kind === 'prop' ? 'props' : kind, ids: id ? [id] : [], text: use.target.text || '' };
  })); panel.append(field('用于谁 / 什么', target));
  if (use.kind === 'identity') panel.append(el('p', '身份用途只参考脸型和发型。复制整个人物外观需另加服装、配饰或风格用途；多视图可先裁切单人。', 'hint'));
  if (use.target.kind === 'actors' || use.target.kind === 'props') {
    const group = el('div', '', 'reference-targets');
    for (const object of scene[use.target.kind] || []) {
      const check = el('input'); check.type = 'checkbox'; check.checked = use.target.ids.includes(object.id);
      check.onchange = () => edit(() => { use.target.ids = check.checked ? [...use.target.ids, object.id] : use.target.ids.filter(id => id !== object.id); });
      group.append(field(object.label, check));
    } panel.append(group);
  }
  for (const [title, owner, name, placeholder] of [
    ...(use.target.kind === 'text' ? [['目标说明', use.target, 'text', '例如：女主手持的包、前景产品']] : []),
    ['来源内容 / 区域', use, 'sourceText', '例如：照片左侧女性；仅取手袋'], ['补充要求', use, 'instruction', '例如：保留材质，改为银色']]) {
    const input = el('textarea'); input.rows = 2; input.maxLength = 16000; input.value = owner[name] || ''; input.placeholder = placeholder;
    input.onchange = () => edit(() => { owner[name] = input.value; }); panel.append(field(title, input));
  }
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = use.enabled !== false; enabled.onchange = () => edit(() => { use.enabled = enabled.checked; });
  const controls = el('div', '', 'reference-use-actions'); controls.append(field('启用用途', enabled), button('删除用途', () => edit(() => { item.usages = item.usages.filter(value => value.id !== use.id); }))); panel.append(controls); return panel;
}
function card(scene, item, manifest) {
  const entry = el('div', '', 'reference-entry');
  const details = el('details', '', 'reference-card'); details.open = openId === item.id;
  details.ontoggle = () => { if (!details.isConnected) return; if (details.open) openId = item.id; else if (openId === item.id) openId = null; };
  const summary = el('summary'), image = el('img'); image.alt = item.label; if (item.asset) image.src = imageURL(item.asset);
  summary.onclick = () => { openId = details.open ? null : item.id; };
  const caption = el('span'), ref = manifest.references.find(ref => ref.referenceIds.includes(item.id));
  const state = manifest.excluded.find(value => value.id === item.id);
  caption.append(el('strong', item.label), el('small', ref ? `image_${ref.index} · ${item.usages.map(use => USES[use.kind]).join(' / ')}` : state?.reason || '未发送'));
  summary.append(image, caption); details.append(summary);
  const label = el('input'); label.value = item.label; label.onchange = () => edit(() => { item.label = label.value.trim() || '参考素材'; }); details.append(field('素材名称', label));
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = item.enabled !== false; enabled.onchange = () => edit(() => { item.enabled = enabled.checked; }); details.append(field('发送此素材', enabled));
  details.append(el('p', item.inputKey ? `连线 ${item.inputKey} · 批次 ${item.batchCount || 1} 张，当前第 ${(item.batchIndex || 0) + 1} 张` : `保存素材 · ${item.asset?.width || '?'} × ${item.asset?.height || '?'}`, 'hint'));
  if (item.reviewSource) details.append(el('p', '连线图片已更新，请核对来源区域及用途描述。', 'reference-review'));
  for (const use of item.usages) details.append(useControls(scene, item, use));
  const actions = el('div', '', 'reference-card-actions');
  const source = button('作为来源图', () => edit(() => { const previous = scene.reference; scene.reference = copy(item.asset); context.sourceChanged(previous); }));
  source.disabled = !item.asset || context.sourceConnected();
  source.title = context.sourceConnected() ? '来源图由节点连线提供，请更换上游图片或断开来源图连线' : !item.asset ? '请先读取或导入此素材' : '将此素材用于姿势提取或三维重建';
  const crop = button('裁切素材', () => cropReference(item)); crop.disabled = !item.asset;
  actions.append(button('＋ 添加用途', () => edit(() => { item.usages.push(newUse('identity', { kind: 'scene', ids: [], text: '' })); })),
    source, crop, button('↑', () => moveReference(scene, item, -1)), button('↓', () => moveReference(scene, item, 1)));
  if (item.inputKey) actions.append(button('使用已保存版本', () => edit(() => { item.inputKey = null; item.missing = false; })));
  if (item.inputKey && item.batchCount > 1) actions.append(button('拆分批次为多素材', () => splitBatch(scene, item)));
  if (item.reviewSource) actions.append(button('已核对新来源', () => edit(() => { item.reviewSource = false; })));
  details.append(actions);
  const tools = el('div', '', 'reference-card-tools');
  const replace = button('替换图片', () => replaceReference(scene, item));
  replace.disabled = !!item.inputKey;
  replace.title = item.inputKey ? '请在上游换图，或展开素材选择「使用已保存版本」后替换' : '替换图片，保留名称、用途、目标和排序';
  const remove = button('删除素材', () => edit(() => {
    scene.referenceLibrary.items = scene.referenceLibrary.items.filter(value => value.id !== item.id);
    if (scene.referenceLibrary.firstReferenceId === item.id) scene.referenceLibrary.firstReferenceId = null;
    if (openId === item.id) openId = null;
  }));
  remove.title = '从参考库移除，可撤销；场景来源图和人物保留';
  tools.append(replace, remove); entry.append(details, tools); return entry;
}
function replaceReference(scene, item) {
  const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true; document.body.append(file);
  file.oncancel = () => file.remove();
  file.onchange = () => {
    const selected = file.files[0]; file.remove(); if (!selected) return;
    context.run(async () => {
      const asset = await context.upload(selected, true);
      if (context.doc() !== scene || !scene.referenceLibrary.items.includes(item)) throw new Error('场景已改变，请重新替换素材');
      edit(() => { item.asset = asset; item.batchIndex = 0; item.batchCount = 1; item.missing = false; item.reviewSource = true; delete item.parent; });
    });
  };
  file.click();
}
function moveReference(scene, item, delta) {
  edit(() => { const items = scene.referenceLibrary.items, index = items.indexOf(item), next = Math.min(items.length - 1, Math.max(0, index + delta)); items.splice(index, 1); items.splice(next, 0, item); });
}
function splitBatch(scene, item) {
  const assets = connected.find(ref => ref.inputKey === item.inputKey)?.assets;
  if (!assets?.length) { context.toast('先点击“读取连线”获取完整批次'); return; }
  edit(() => { for (let index = 1; index < assets.length; index++) {
    if (scene.referenceLibrary.items.some(value => value.inputKey === item.inputKey && value.batchIndex === index)) continue;
    addReference(scene, assets[index], { label: `${item.label} · ${index + 1}`, inputKey: item.inputKey, batchIndex: index, batchCount: assets.length,
      usages: item.usages.map(use => ({ ...copy(use), id: `use-${crypto.randomUUID()}` })) });
  } });
}
export function setReferenceConnections(values) { connected = values || []; }
export function refreshReferencesUI(force = false) {
  if (!context) return;
  const scene = context.doc(), library = scene.referenceLibrary, modern = scene.version === 3 && !!library;
  $('reference-materials').hidden = tab !== 'materials'; $('reference-objects').hidden = tab !== 'objects';
  for (const value of ['materials', 'objects']) { $(`tab-${value}`).classList.toggle('active', tab === value); $(`tab-${value}`).setAttribute('aria-selected', String(tab === value)); $(`tab-${value}`).tabIndex = tab === value ? 0 : -1; }
  $('legacy-references').hidden = modern; $('reference-workflow').value = modern ? library.mode : 'guided';
  const source = scene.reference; $('source-to-library').disabled = !source;
  $('reference-source-warning').hidden = !scene.sourceStale && !scene.derivedGuideStale && !staleGuide(scene);
  $('reference-source-warning-text').textContent = scene.sourceStale ? '来源图已改变，当前3D仍来自旧图。请重新重建；参考素材与相机设置保留。' : '来源图已改变，已提取的骨架 / 深度仍来自旧图。请重新提取，或明确沿用保存结构。';
  $('keep-derived-guide').hidden = !scene.derivedGuideStale && !staleGuide(scene);
  $('library-source-image').hidden = !source; if (source) $('library-source-image').src = imageURL(source);
  $('library-source-state').textContent = source ? '用于提取 / 重建；加入参考库后才参与多图创作。' : '可选。无图也可摆放人偶或纯文本创作。';
  const noGuide = modern && library.mode !== 'guided'; $('stage').classList.toggle('reference-only', noGuide); $('reference-stage-preview').hidden = !noGuide;
  if (noGuide) $('mouse-pitch').closest('.studio-options').hidden = true;
  $('image-order-row').hidden = noGuide || scene.conditioning.promptMode === 'single';
  for (const option of $('image-order').options) option.textContent = option.value === 'guide-first'
    ? (modern ? '引导在前 / 参考在后' : '引导图 1 / 原图 2')
    : (modern ? '参考在前 / 引导在后' : '原图 1 / 引导图 2');
  if (modern) $('reference-heading').textContent = '场景来源图 · 提取 / 重建';
  document.querySelector('.guide-choice-grid').hidden = noGuide;
  document.querySelector('.guide-label').hidden = noGuide;
  document.querySelector('.output-section').hidden = noGuide;
  for (const id of ['coarse-inputs','openpose-panel','map-inputs','canny-options','guide-explanation','stage-help']) if (noGuide) $(id).hidden = true;
  if (!noGuide) $('stage-help').hidden = false;
  $('ratio').disabled = noGuide;
  $('reference-first-settings').hidden = !modern || library.mode !== 'references-only';
  $('reference-send-plan').hidden = !modern; document.querySelector('.reference-templates').hidden = !modern;
  if (!modern) { key = null; renderedScene = null; renderedItems = []; $('reference-cards').replaceChildren(); $('reference-empty-note').hidden = true; return; }
  const manifest = libraryManifest(scene), signature = JSON.stringify([library, scene.actors, scene.props, scene.conditioning, manifest, context.sourceConnected()]);
  const firstImage = manifest.references[0];
  if (firstImage && library.mode === 'references-only') {
    let width = firstImage.asset.width, height = firstImage.asset.height;
    const requested = `${width} × ${height}`, scale = library.firstResolution ? library.firstResolution / Math.sqrt(width * height) : 1;
    width = Math.max(32, Math.round(width * scale / 32) * 32); height = Math.max(32, Math.round(height * scale / 32) * 32);
    $('reference-frame-state').textContent = `来源 ${requested} → 首图 / 原生输出 ${width} × ${height}`;
  } else $('reference-frame-state').textContent = library.mode === 'text' ? '原生纯文本画幅：1024 × 1024' : '';
  const mapping = JSON.stringify([manifest.guide?.index, manifest.references.map(reference => [reference.asset.name, reference.index])]);
  if (lastMapping && lastMapping !== mapping) mappingWarning = '图片编号或内容已改变；自定义 / 编码器全文中的 <imageN> 保持原文，请核对当前清单。';
  lastMapping = mapping;
  const selectedId = library.firstReferenceId || '';
  if (force || signature !== key || scene !== renderedScene || library.items.some((item, index) => item !== renderedItems[index])) {
    key = signature; renderedScene = scene; renderedItems = library.items.slice();
    $('reference-cards').replaceChildren(...library.items.map(item => card(scene, item, manifest)));
    $('reference-count').textContent = `${library.items.length} 素材`; $('reference-empty-note').hidden = !!library.items.length;
    $('first-reference').replaceChildren(new Option('第一个启用素材', ''), ...library.items.map(item => new Option(item.label, item.id))); $('first-reference').value = selectedId;
    const budget = $('first-reference-resolution'), resolution = String(library.firstResolution || 0);
    for (const option of [...budget.options]) if (option.dataset.custom === 'true') option.remove();
    if (![...budget.options].some(option => option.value === resolution)) {
      const option = new Option(`${resolution}²像素 · 自定义`, resolution); option.dataset.custom = 'true'; budget.append(option);
    }
    budget.value = resolution;
    $('reference-template').replaceChildren(...(library.templates || []).map(template => new Option(template.name, template.id)));
    $('apply-reference-template').disabled = !library.templates?.length;
    $('reference-send-summary').textContent = `本次 ${manifest.imageCount} 图 · ${manifest.guide ? '1 引导 + ' : ''}${manifest.references.length} 参考`;
    const rows = []; if (manifest.guide) rows.push(el('p', `image_${manifest.guide.index} · 当前构图引导`));
    for (const reference of manifest.references) rows.push(el('p', `image_${reference.index} · ${reference.labels.join(' / ')} · ${reference.usages.map(use => `${USES[use.kind]} → ${use.targetText}`).join('；')}`));
    for (const entry of manifest.excluded) rows.push(el('p', `${entry.label} · ${entry.reason}`, 'hint'));
    $('reference-send-images').replaceChildren(...rows); $('reference-send-warning').textContent = [mappingWarning, ...manifest.warnings].filter(Boolean).join(' ') || 'Qwen 官方建议范围：10 图。相同素材多用途只编码一次。';
    if (scene.conditioning.model === 'base') {
      $('image-wiring').textContent = 'Studio 当前构图引导 / 场景与参考设置 → 多图编码；Studio prompt → 编码 prompt（使用输入全文）。';
      $('prompt-preview').textContent = libraryPrompt(scene, manifest);
      $('prompt-mode-hint').textContent = '编码器可断线手写或接入其他文本节点；补充模式追加一次，全文模式使用原文。用途是描述性提示，不是硬遮罩。';
    }
  }
  if (noGuide) {
    const selected = library.items.find(item => item.id === previewId) || library.items.find(item => item.id === selectedId) || library.items.find(item => item.asset);
    $('reference-stage-image').hidden = !selected?.asset; $('reference-stage-empty').hidden = !!selected?.asset;
    if (selected?.asset) $('reference-stage-image').src = imageURL(selected.asset);
    $('reference-stage-thumbs').replaceChildren(...library.items.filter(item => item.asset).map(item => { const thumb = button('', () => { previewId = item.id; refreshReferencesUI(); }); const image = el('img'); image.src = imageURL(item.asset); image.alt = item.label; thumb.title = item.label; thumb.append(image); thumb.classList.toggle('active', item.id === selected?.id); return thumb; }));
    $('view-detail').textContent = library.mode === 'text' ? '纯文本创作 · 参考图不会发送' : '仅参考创作 · 首张参考决定输出画幅';
  }
  for (const id of ['camera-heading', 'camera-eyebrow', 'camera-sliders', 'lens-panel', 'view-presets', 'shot-shelf', 'guide-section']) {
    const node = $(id) || (id === 'guide-section' ? document.querySelector('.guide-section') : null); if (node && noGuide) node.hidden = true;
  }
  if (noGuide) { $('download-guide').disabled = true; $('open-batch').disabled = true; }
  document.querySelector('.guide-section').hidden = noGuide;
  $('model-anyangle').disabled ||= noGuide;
  if (scene.conditioning.model === 'base') {
    $('image-wiring').textContent = 'Studio 当前构图引导 / 场景与参考设置 → 多图编码；Studio prompt → 编码 prompt（使用输入全文）。';
    $('prompt-mode-hint').textContent = '编码器可断线手写或接入其他文本节点；补充模式追加一次，全文模式使用原文。用途是描述性提示，不是硬遮罩。';
    const select = $('prompt-mode');
    for (const option of select.options) { if (option.value === 'default') option.textContent = modern ? '按素材用途自动生成' : '默认模板'; if (option.value === 'single') option.hidden = modern; }
    if (modern && scene.conditioning.promptMode === 'single') $('prompt-mode-hint').textContent += ' 旧单图选项已保留；新版发送内容以素材清单为准，关闭素材可只发引导。';
  }
}
function installCropDrag() {
  const surface = $('reference-crop-surface'), image = $('reference-crop-image'); let start;
  function display() { const w = image.naturalWidth, h = image.naturalHeight; if (!w || !h) return; const box = $('reference-crop-box');
    box.style.left = `${Number($('crop-x').value) / w * 100}%`; box.style.top = `${Number($('crop-y').value) / h * 100}%`;
    box.style.width = `${Number($('crop-width').value) / w * 100}%`; box.style.height = `${Number($('crop-height').value) / h * 100}%`; }
  const point = event => { const bounds = image.getBoundingClientRect(); return [Math.max(0, Math.min(image.naturalWidth, Math.round((event.clientX - bounds.left) / bounds.width * image.naturalWidth))), Math.max(0, Math.min(image.naturalHeight, Math.round((event.clientY - bounds.top) / bounds.height * image.naturalHeight)))]; };
  surface.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); start = point(event); surface.setPointerCapture(event.pointerId); };
  surface.onpointermove = event => { if (!start) return; const end = point(event); for (const [id, value] of [['x', Math.min(start[0], end[0])], ['y', Math.min(start[1], end[1])], ['width', Math.abs(start[0] - end[0])], ['height', Math.abs(start[1] - end[1])]]) $(`crop-${id}`).value = value; display(); };
  surface.onpointerup = surface.onpointercancel = () => { start = null; };
  for (const name of ['x', 'y', 'width', 'height']) $(`crop-${name}`).oninput = display;
  image.onload = display;
}
async function cropReference(item) {
  if (!item.asset) return;
  const scene = context.doc(), asset = item.asset, dialog = $('reference-crop-dialog'), image = $('reference-crop-image');
  image.src = imageURL(asset); for (const [name, value] of [['x', 0], ['y', 0], ['width', asset.width], ['height', asset.height]]) $(`crop-${name}`).value = value;
  dialog.returnValue = ''; dialog.showModal();
  const result = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true })); if (result !== 'ok') return;
  context.run(async () => {
    const x = Number($('crop-x').value), y = Number($('crop-y').value), width = Number($('crop-width').value), height = Number($('crop-height').value);
    if (![x,y,width,height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > image.naturalWidth || y + height > image.naturalHeight) throw new Error('裁切区域须位于原图内且至少1×1像素');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(image, x,y,width,height, 0,0,width,height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const saved = await context.upload(new File([blob], 'crop.png', { type: 'image/png' }), true);
    if (context.doc() !== scene || !scene.referenceLibrary.items.includes(item) || item.asset.name !== asset.name) throw new Error('裁切来源已改变，请重试');
    edit(() => addReference(scene, saved, { label: `${item.label} · 裁切`, parent: { name: asset.name, box: [x,y,width,height] }, usages: item.usages.map(use => ({ ...copy(use), id: `use-${crypto.randomUUID()}` })) }));
  });
}
