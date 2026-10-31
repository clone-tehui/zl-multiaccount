const params = new URLSearchParams(window.location.search);
const input = document.getElementById('executionId');
const button = document.getElementById('loadBtn');
const statusEl = document.getElementById('status');
const detailsEl = document.getElementById('details');
const networkEl = document.getElementById('network');
let network = null;
let nodeById = new Map();

input.value = params.get('id') || params.get('executionId') || '';
button.addEventListener('click', () => loadTrace(input.value));
if (input.value) loadTrace(input.value);

async function loadTrace(executionId) {
  const id = String(executionId || '').trim();
  if (!id) {
    statusEl.textContent = 'Thiếu execution_id';
    return;
  }
  statusEl.textContent = 'Đang tải...';
  const res = await fetch(`/api/executions/${encodeURIComponent(id)}/trace`);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.ok) {
    statusEl.textContent = payload.error || `Lỗi tải trace (${res.status})`;
    return;
  }
  const trace = payload.trace || { nodes: [], edges: [] };
  renderTrace(trace);
  statusEl.textContent = `${trace.nodes.length} nodes · ${trace.edges.length} edges`;
}

function renderTrace(trace) {
  nodeById = new Map((trace.nodes || []).map((node) => [String(node.id), node]));
  const nodes = new vis.DataSet((trace.nodes || []).map((node) => ({
    id: String(node.id),
    label: `${node.stepNumber}. ${node.label}`,
    title: node.type,
    shape: 'box',
    color: colorForType(node.type),
    font: { face: 'Inter, Arial', size: 14 },
    margin: 10
  })));
  const edges = new vis.DataSet((trace.edges || []).map((edge) => ({
    from: String(edge.from),
    to: String(edge.to),
    arrows: 'to',
    color: '#6d858a',
    smooth: { type: 'cubicBezier' }
  })));
  network = new vis.Network(networkEl, { nodes, edges }, {
    layout: { hierarchical: { enabled: true, direction: 'LR', sortMethod: 'directed', levelSeparation: 180, nodeSpacing: 130 } },
    physics: false,
    interaction: { hover: true, tooltipDelay: 120 }
  });
  network.on('click', (event) => {
    const nodeId = event.nodes?.[0];
    if (nodeId) renderDetails(nodeById.get(String(nodeId)));
  });
  if ((trace.nodes || []).length) renderDetails(trace.nodes[0]);
}

function renderDetails(node) {
  if (!node) return;
  detailsEl.innerHTML = `
    <h2>${escapeHtml(node.label || node.id)}</h2>
    <div class="kv">
      <strong>Type</strong><span>${escapeHtml(node.type || '')}</span>
      <strong>Model</strong><span>${escapeHtml(node.modelUsed || '—')}</span>
      <strong>Duration</strong><span>${Number(node.durationMs || 0)} ms</span>
    </div>
    <h3>Input Data</h3>
    <pre>${escapeHtml(JSON.stringify(node.inputData ?? null, null, 2))}</pre>
    <h3>Output Data</h3>
    <pre>${escapeHtml(JSON.stringify(node.outputData ?? null, null, 2))}</pre>
  `;
}

function colorForType(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized === 'router') return { background: '#dff7ff', border: '#3994aa' };
  if (normalized === 'agent') return { background: '#e9fbe9', border: '#4ea154' };
  if (normalized === 'sub_agent') return { background: '#fff1d6', border: '#c8841b' };
  if (normalized === 'tool') return { background: '#eee8ff', border: '#7259d1' };
  if (normalized === 'end') return { background: '#e5f1ed', border: '#547d72' };
  return { background: '#f2f6f6', border: '#9db1b5' };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}
