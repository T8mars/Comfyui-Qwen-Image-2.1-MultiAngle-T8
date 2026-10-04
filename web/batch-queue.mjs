export function promptForSnapshot(compiled, nodeId, snapshot, frozenScene = null) {
  if (snapshot?.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.id)) throw new Error('无效的批量场景快照');
  const prompt = structuredClone(compiled), id = String(nodeId);
  if (prompt.output[id]?.class_type !== 'AnyAngleStudioT8') throw new Error('当前 Studio 节点未包含在可执行工作流中');
  const value = JSON.stringify(snapshot);
  prompt.output[id].inputs.snapshot = value;
  const node = prompt.workflow.nodes.find(node => String(node.id) === id);
  if (!node) throw new Error('工作流缺少 Studio 节点，请重新打开工作台');
  node.widgets_values[0] = value;
  if (frozenScene?.version === 2) {
    // The batch snapshot owns its photos and guide. Re-evaluating a random upstream
    // image for every queued camera would silently change role identities.
    const frozenNames = new Set(['reference_image', 'structure_image', 'pose_keypoints', 'actor_references']);
    for (const key of Object.keys(prompt.output[id].inputs)) if (frozenNames.has(key) || /^(actor_references\.)?actor_reference_/.test(key)) delete prompt.output[id].inputs[key];
    const links = new Set();
    for (const input of node.inputs || []) if (frozenNames.has(input.name) || /^(actor_references\.)?actor_reference_/.test(input.name)) {
      if (input.link != null) links.add(input.link); input.link = null;
    }
    prompt.workflow.links = prompt.workflow.links?.filter(link => !links.has(Array.isArray(link) ? link[0] : link.id));
    for (const other of prompt.workflow.nodes) for (const output of other.outputs || []) if (output.links) output.links = output.links.filter(link => !links.has(link));
  }
  return prompt;
}
