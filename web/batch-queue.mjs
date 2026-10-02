export function promptForSnapshot(compiled, nodeId, snapshot) {
  if (snapshot?.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.id)) throw new Error('无效的批量场景快照');
  const prompt = structuredClone(compiled), id = String(nodeId);
  if (prompt.output[id]?.class_type !== 'AnyAngleStudioT8') throw new Error('当前 Studio 节点未包含在可执行工作流中');
  const value = JSON.stringify(snapshot);
  prompt.output[id].inputs.snapshot = value;
  const node = prompt.workflow.nodes.find(node => String(node.id) === id);
  if (!node) throw new Error('工作流缺少 Studio 节点，请重新打开工作台');
  node.widgets_values[0] = value;
  return prompt;
}
