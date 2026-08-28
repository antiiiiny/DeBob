import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Edge, Node } from '../graph/types.js'
import {
  openDb,
  readManifest,
  SqlitePersistenceAdapter,
  type Manifest,
} from '../persistence/sqlite.js'

type VisualiserNode = Pick<
  Node,
  'id' | 'type' | 'name' | 'filePath' | 'layer' | 'startLine' | 'endLine' | 'confidence' | 'dataSource' | 'metadata'
>
type VisualiserEdge = Pick<Edge, 'id' | 'source' | 'target' | 'type' | 'confidence' | 'dataSource'>

interface VisualiserPayload {
  manifest: Manifest | null
  nodes: VisualiserNode[]
  edges: VisualiserEdge[]
}

/**
 * Reads the persisted graph once, then serves it through a local read-only
 * HTTP server for the inline visualisation.
 */
export async function startVisualiserServer(
  repoRoot: string,
  options: { port?: number } = {},
): Promise<{ url: string; close: () => void }> {
  const contextDbPath = join(repoRoot, '.debob', 'context.db')
  if (!existsSync(contextDbPath)) {
    throw new Error("No graph found. Run 'debob init' first.")
  }

  const { db, dbPath } = await openDb(repoRoot)
  const adapter = new SqlitePersistenceAdapter(db, dbPath)
  let graph
  try {
    graph = adapter.readGraph()
  } finally {
    // sql.js allocates the database in memory, including for this read-only use.
    adapter.close()
  }

  const payload: VisualiserPayload = {
    manifest: readManifest(repoRoot),
    nodes: Array.from(graph.nodes.values()).map(serialiseNode),
    edges: graph.edges.map(serialiseEdge),
  }
  const requestedPort = options.port ?? 7842
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    throw new Error('Port must be an integer between 1 and 65535.')
  }

  for (let offset = 0; offset < 5 && requestedPort + offset <= 65535; offset += 1) {
    const port = requestedPort + offset
    try {
      const server = await listen(port, payload)
      return {
        url: 'http://localhost:' + port,
        close: () => server.close(),
      }
    } catch (error) {
      if (isAddressInUse(error)) continue
      throw error
    }
  }

  throw new Error('Unable to start graph visualiser: the next 5 ports are already in use.')
}

function serialiseNode(node: Node): VisualiserNode {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    filePath: node.filePath,
    layer: node.layer,
    startLine: node.startLine,
    endLine: node.endLine,
    confidence: node.confidence,
    dataSource: node.dataSource,
    metadata: node.metadata,
  }
}

function serialiseEdge(edge: Edge): VisualiserEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    confidence: edge.confidence,
    dataSource: edge.dataSource,
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE'
}

function listen(port: number, payload: VisualiserPayload): Promise<Server> {
  const server = createServer(requestHandler(payload))
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server)
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function requestHandler(payload: VisualiserPayload) {
  const graphJson = JSON.stringify(payload)

  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Method Not Allowed')
      return
    }

    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname === '/api/graph') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(graphJson)
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(VISUALISER_HTML)
  }
}

// ─── Inline Visualiser ─────────────────────────────────────────────────────

const VISUALISER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeBob Graph Visualiser</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
  <style>
    :root { background: #0d141c; color: #e8edf4; color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 960px; overflow: hidden; }
    #app { display: grid; grid-template-columns: 250px minmax(420px, 1fr) 310px; grid-template-rows: 68px calc(100vh - 68px); height: 100vh; }
    #topbar { align-items: center; background: #121d29; border-bottom: 1px solid #253548; display: flex; gap: 18px; grid-column: 1 / -1; padding: 0 22px; }
    .brand { color: white; font-size: 20px; font-weight: 750; white-space: nowrap; }
    .repo-name { color: #8bbcf4; }
    #stats { color: #aebccc; display: flex; font-size: 13px; gap: 14px; white-space: nowrap; }
    #search { background: #0b121a; border: 1px solid #34485d; border-radius: 7px; color: #e8edf4; margin-left: auto; max-width: 360px; outline: none; padding: 9px 12px; width: 32vw; }
    #search:focus { border-color: #4a90d9; box-shadow: 0 0 0 3px rgba(74,144,217,.18); }
    aside { background: #101923; overflow-y: auto; padding: 18px; }
    #filters { border-right: 1px solid #253548; } #inspector { border-left: 1px solid #253548; }
    .panel-title { color: white; font-size: 14px; margin: 0 0 14px; }
    .filter-section { border-top: 1px solid #253548; margin-top: 15px; padding-top: 15px; }
    .filter-section h3 { color: #8fa3b9; font-size: 11px; letter-spacing: .08em; margin: 0 0 9px; text-transform: uppercase; }
    .filter-option { align-items: center; color: #c9d4e0; cursor: pointer; display: flex; font-size: 13px; gap: 8px; margin: 7px 0; }
    .filter-option input { accent-color: #4a90d9; margin: 0; }
    #graph-area { min-width: 0; position: relative; } #cy { height: 100%; width: 100%; }
    #loading { align-items: center; background: #0d141c; color: #b9c6d5; display: flex; inset: 0; justify-content: center; position: absolute; z-index: 2; }
    #loading.error { color: #ff8a8a; padding: 32px; text-align: center; }
    #legend { background: rgba(16,25,35,.94); border: 1px solid #31445a; border-radius: 8px; bottom: 16px; max-width: 330px; padding: 10px 12px; position: absolute; right: 16px; z-index: 1; }
    .legend-title { color: white; font-size: 11px; font-weight: 700; margin: 0 0 6px; text-transform: uppercase; }
    .legend-items { display: flex; flex-wrap: wrap; gap: 6px 11px; }
    .legend-item { align-items: center; color: #c4cfda; display: flex; font-size: 11px; gap: 5px; }
    .legend-swatch { border-radius: 50%; height: 9px; width: 9px; } .legend-line { border-radius: 2px; height: 3px; width: 13px; }
    .legend-section + .legend-section { margin-top: 9px; }
    #inspector-empty { color: #8394a7; font-size: 13px; line-height: 1.5; }
    #inspector-content { display: none; } #inspector-content.visible { display: block; }
    .node-heading { color: white; font-size: 15px; margin: 0 0 15px; overflow-wrap: anywhere; }
    .detail-row { border-bottom: 1px solid #223244; padding: 8px 0; }
    .detail-label { color: #8496aa; display: block; font-size: 10px; letter-spacing: .07em; margin-bottom: 3px; text-transform: uppercase; }
    .detail-value, .edge-list li { color: #dbe4ee; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .connected-title { color: white; font-size: 13px; margin: 18px 0 0; }
    .edge-list { list-style: none; margin: 7px 0 0; padding: 0; }
    .edge-list li { border-bottom: 1px solid #223244; font-size: 11px; line-height: 1.45; padding: 7px 0; }
  </style>
</head>
<body>
  <div id="app">
    <header id="topbar">
      <div class="brand">DeBob <span class="repo-name" id="repo-name">Graph</span></div>
      <div id="stats"><span id="node-count">0 nodes</span><span id="edge-count">0 edges</span><span id="commit-count">0 commits</span></div>
      <input id="search" type="search" aria-label="Search graph nodes" placeholder="Search node names">
    </header>
    <aside id="filters">
      <h2 class="panel-title">Filters</h2>
      <div id="node-type-filters"></div><div id="edge-type-filters"></div><div id="layer-filters"></div>
      <div class="filter-section"><label class="filter-option"><input id="hot-only" type="checkbox"> Hot files only</label></div>
    </aside>
    <main id="graph-area">
      <div id="loading">Loading graph…</div><div id="cy"></div>
      <section id="legend">
        <div class="legend-section"><div class="legend-title">Node types</div><div class="legend-items" id="node-legend"></div></div>
        <div class="legend-section"><div class="legend-title">Edge types</div><div class="legend-items" id="edge-legend"></div></div>
      </section>
    </main>
    <aside id="inspector"><h2 class="panel-title">Node Inspector</h2><div id="inspector-empty">Select a node to inspect its graph data and connections.</div><div id="inspector-content"></div></aside>
  </div>
  <script>
    (function () {
      var NODE_TYPES = ['file', 'class', 'function', 'interface', 'variable', 'package', 'route'];
      var EDGE_TYPES = ['imports', 'exports', 'extends', 'implements', 'calls', 'depends_on', 'instantiates', 'exposes', 'handles', 'tests', 'reads_from', 'writes_to', 'communicates_with', 'configured_by', 'related_to'];
      var LAYERS = ['presentation', 'business', 'data', 'config', 'test', 'infra', 'unclassified'];
      var NODE_COLORS = { file: '#4A90D9', class: '#7B61FF', function: '#50C878', interface: '#FFB347', variable: '#87CEEB', package: '#FF6B6B', route: '#FFD700' };
      var EDGE_COLORS = {
        imports: '#9AA5B1', exports: '#4A90D9', extends: '#7B61FF', implements: '#FFB347',
        calls: '#50C878', depends_on: '#FF6B6B', instantiates: '#E879F9', exposes: '#22D3EE',
        handles: '#F97316', tests: '#A3E635', reads_from: '#38BDF8', writes_to: '#F43F5E',
        communicates_with: '#C084FC', configured_by: '#FACC15', related_to: '#94A3B8'
      };
      var DEFAULT_EDGE_COLOR = '#94A3B8';
      var state = { nodeTypes: new Set(NODE_TYPES), edgeTypes: new Set(EDGE_TYPES), layers: new Set(LAYERS), hotOnly: false };
      var graphData = null;
      var cy = null;
      var search = document.getElementById('search');
      var loading = document.getElementById('loading');
      var inspector = document.getElementById('inspector-content');
      var inspectorEmpty = document.getElementById('inspector-empty');

      function filterGroup(containerId, title, values, selected) {
        var container = document.getElementById(containerId);
        var section = document.createElement('section');
        section.className = 'filter-section';
        var heading = document.createElement('h3');
        heading.textContent = title;
        section.appendChild(heading);
        values.forEach(function (value) {
          var label = document.createElement('label');
          label.className = 'filter-option';
          var checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = true;
          checkbox.addEventListener('change', function () {
            if (checkbox.checked) selected.add(value);
            else selected.delete(value);
            applyFilters();
          });
          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(value));
          section.appendChild(label);
        });
        container.appendChild(section);
      }

      function legend(containerId, values, colors, line) {
        var container = document.getElementById(containerId);
        values.forEach(function (value) {
          var item = document.createElement('div');
          item.className = 'legend-item';
          var swatch = document.createElement('span');
          swatch.className = line ? 'legend-line' : 'legend-swatch';
          swatch.style.backgroundColor = colors[value] || DEFAULT_EDGE_COLOR;
          var label = document.createElement('span');
          label.textContent = value;
          item.appendChild(swatch);
          item.appendChild(label);
          container.appendChild(item);
        });
      }

      filterGroup('node-type-filters', 'Node type', NODE_TYPES, state.nodeTypes);
      filterGroup('edge-type-filters', 'Edge type', EDGE_TYPES, state.edgeTypes);
      filterGroup('layer-filters', 'Layer', LAYERS, state.layers);
      legend('node-legend', NODE_TYPES, NODE_COLORS, false);
      legend('edge-legend', EDGE_TYPES, EDGE_COLORS, true);
      document.getElementById('hot-only').addEventListener('change', function (event) {
        state.hotOnly = event.target.checked;
        applyFilters();
      });
      search.addEventListener('input', applyFilters);

      function setupGraph(data) {
        graphData = data;
        var manifest = data.manifest;
        var parts = manifest && manifest.repoPath ? manifest.repoPath.split(/[\\\\/]/).filter(Boolean) : [];
        document.getElementById('repo-name').textContent = parts[parts.length - 1] || 'Graph';
        document.getElementById('node-count').textContent = (manifest ? manifest.nodeCount : data.nodes.length) + ' nodes';
        document.getElementById('edge-count').textContent = (manifest ? manifest.edgeCount : data.edges.length) + ' edges';
        document.getElementById('commit-count').textContent = (manifest ? manifest.commitCount : 0) + ' commits';

        var churns = data.nodes.filter(function (node) { return node.type === 'file'; }).map(function (node) { return Number(node.metadata && node.metadata.churnScore) || 0; });
        var maxChurn = Math.max.apply(Math, [0].concat(churns));
        var elements = [];
        data.nodes.forEach(function (node) {
          var churn = Number(node.metadata && node.metadata.churnScore) || 0;
          var radius = node.type === 'file' ? 20 + (maxChurn > 0 ? Math.max(0, churn) / maxChurn * 40 : 0) : 18;
          elements.push({
            group: 'nodes',
            data: Object.assign({}, node, { label: node.name, diameter: radius * 2 }),
            classes: 'node-' + node.type + (node.metadata && node.metadata.hot === true ? ' hot' : '')
          });
        });
        data.edges.forEach(function (edge) {
          elements.push({
            group: 'edges',
            data: Object.assign({}, edge, { edgeColor: EDGE_COLORS[edge.type] || DEFAULT_EDGE_COLOR }),
            classes: 'edge-' + edge.type
          });
        });

        var styles = [
          { selector: 'node', style: { 'background-color': '#607083', 'border-color': '#101923', 'border-width': 1, color: '#e8edf4', height: 'data(diameter)', label: 'data(label)', 'font-size': 10, 'min-zoomed-font-size': 8, 'text-outline-color': '#0d141c', 'text-outline-width': 2, 'text-valign': 'bottom', 'text-margin-y': 5, width: 'data(diameter)' } },
          { selector: 'edge', style: { 'curve-style': 'bezier', 'line-color': 'data(edgeColor)', opacity: .72, 'target-arrow-color': 'data(edgeColor)', 'target-arrow-shape': 'triangle', width: 1.6 } },
          { selector: 'node.hot', style: { 'border-color': '#FF0000', 'border-width': 3 } },
          { selector: 'node.search-dim', style: { opacity: .13 } },
          { selector: 'node.search-match', style: { 'border-color': '#ffffff', 'border-width': 4, 'z-index': 999 } }
        ];
        NODE_TYPES.forEach(function (type) {
          styles.push({ selector: 'node.node-' + type, style: { 'background-color': NODE_COLORS[type] } });
        });
        cy = window.cytoscape({
          container: document.getElementById('cy'),
          elements: elements,
          style: styles,
          layout: {
            // A rank layout puts every root and isolated node on the same row.
            // This graph commonly has many of both, so use a compact topology
            // layout that keeps each connected area together instead.
            name: 'cose',
            animate: false,
            idealEdgeLength: 90,
            nodeRepulsion: 7000,
            gravity: 1,
            numIter: 1500,
            padding: 50,
            tile: true
          },
          wheelSensitivity: .2
        });
        cy.on('tap', 'node', function (event) { showInspector(event.target.data('id')); });
        cy.on('tap', function (event) { if (event.target === cy) clearInspector(); });
        applyFilters();
        loading.style.display = 'none';
      }

      function applyFilters() {
        if (!cy || !graphData) return;
        var visibleNodes = new Set();
        cy.nodes().forEach(function (element) {
          var node = element.data();
          var layer = node.layer || 'unclassified';
          var hot = node.metadata && node.metadata.hot === true;
          var visible = state.nodeTypes.has(node.type) && state.layers.has(layer) && (!state.hotOnly || hot);
          if (visible) {
            visibleNodes.add(node.id);
            element.show();
          } else element.hide();
        });
        cy.edges().forEach(function (element) {
          var edge = element.data();
          if (state.edgeTypes.has(edge.type) && visibleNodes.has(edge.source) && visibleNodes.has(edge.target)) element.show();
          else element.hide();
        });
        var query = search.value.trim().toLowerCase();
        cy.nodes().removeClass('search-dim search-match');
        if (query) cy.nodes(':visible').forEach(function (element) {
          var name = String(element.data('name') || '').toLowerCase();
          element.addClass(name.indexOf(query) >= 0 ? 'search-match' : 'search-dim');
        });
      }

      function detail(label, value) {
        var row = document.createElement('div');
        row.className = 'detail-row';
        var key = document.createElement('span');
        key.className = 'detail-label';
        key.textContent = label;
        var text = document.createElement('span');
        text.className = 'detail-value';
        text.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
        row.appendChild(key);
        row.appendChild(text);
        inspector.appendChild(row);
      }

      function metadata(node, key) {
        return node.metadata && Object.prototype.hasOwnProperty.call(node.metadata, key) ? node.metadata[key] : '—';
      }

      function lineRange(start, end) {
        if (start === undefined && end === undefined) return '—';
        if (start === undefined) return String(end);
        if (end === undefined || end === start) return String(start);
        return start + '–' + end;
      }

      function showInspector(nodeId) {
        var node = graphData.nodes.find(function (item) { return item.id === nodeId; });
        if (!node) return;
        inspector.replaceChildren();
        inspectorEmpty.style.display = 'none';
        inspector.classList.add('visible');
        var title = document.createElement('h3');
        title.className = 'node-heading';
        title.textContent = node.name;
        inspector.appendChild(title);
        detail('ID', node.id); detail('Name', node.name); detail('Type', node.type);
        detail('File path', node.filePath); detail('Layer', node.layer || 'unclassified');
        detail('Lines', lineRange(node.startLine, node.endLine)); detail('Confidence', node.confidence);
        detail('Data source', node.dataSource); detail('Churn score', metadata(node, 'churnScore'));
        detail('Author count', metadata(node, 'authorCount')); detail('Last modified', metadata(node, 'lastModifiedAt'));
        detail('Hot', metadata(node, 'hot'));
        var connected = graphData.edges.filter(function (edge) { return edge.source === node.id || edge.target === node.id; });
        var heading = document.createElement('h4');
        heading.className = 'connected-title';
        heading.textContent = 'Connected edges (' + connected.length + ')';
        inspector.appendChild(heading);
        if (!connected.length) { detail('Connections', 'None'); return; }
        var list = document.createElement('ul');
        list.className = 'edge-list';
        connected.forEach(function (edge) {
          var item = document.createElement('li');
          item.textContent = edge.source + ' → ' + edge.type + ' → ' + edge.target;
          list.appendChild(item);
        });
        inspector.appendChild(list);
      }

      function clearInspector() {
        inspector.replaceChildren();
        inspector.classList.remove('visible');
        inspectorEmpty.style.display = 'block';
      }

      fetch('/api/graph')
        .then(function (response) {
          if (!response.ok) throw new Error('Graph API returned status ' + response.status);
          return response.json();
        })
        .then(setupGraph)
        .catch(function (error) {
          loading.classList.add('error');
          loading.textContent = 'Unable to load graph: ' + error.message;
        });
    }());
  </script>
</body>
</html>
`
