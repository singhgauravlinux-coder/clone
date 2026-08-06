import { toResourceNode } from './inventory';
import { DemoClient } from './api';
import { toCsv } from '../components/ActivityView';
import { liveTopology } from '../core/topology';
import * as demo from './demo';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

async function main() {
  const client = new DemoClient();
  const boot = await client.bootstrap();
  check('bootstrap returns a scoped user', boot.user.organizationId === boot.organization.id);
  check('bootstrap returns clusters', boot.clusters.length >= 2);

  const apps = await client.listApplications();
  check('applications are listed', apps.length === 4);

  /* Topology ------------------------------------------------------------- */

  const app = apps.find((entry) => entry.name === 'checkout-api')!;
  const graph = liveTopology(app);
  check('graph has one node per resource plus the application root',
    graph.nodes.length === app.resources.length + 1,
    `${graph.nodes.length} vs ${app.resources.length + 1}`);
  check('every edge points at a node it can resolve',
    graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.from)
      && graph.nodes.some((node) => node.id === edge.to)));
  check('the application is the only tier 0 node',
    graph.nodes.filter((node) => node.tier === 0).length === 1);
  check('pods sit deeper than their deployment',
    graph.nodes.find((node) => node.kind === 'Pod')!.tier
    > graph.nodes.find((node) => node.kind === 'Deployment')!.tier);
  check('drift surfaces as out-of-sync',
    graph.nodes.some((node) => node.sync === 'out-of-sync'));
  check('a degraded pod keeps its health', graph.nodes.some((node) => node.health === 'degraded'));
  check('layout assigns distinct positions',
    new Set(graph.nodes.map((node) => `${node.x}:${node.y}`)).size === graph.nodes.length);

  /* Deploy actions -------------------------------------------------------- */

  const before = await client.listDeployments(app.id);
  const dry = await client.apply({
    applicationId: app.id,
    files: [{ path: 'deployment.yaml', content: 'kind: Deployment\nmetadata:\n  name: checkout-api\n' }],
    dryRun: true,
    message: 'check',
  });
  check('a dry run is marked as such', dry.deployment.dryRun);
  check('a dry run produces a diff', dry.diff.includes('+kind: Deployment'));
  check('a dry run does not add a revision',
    (await client.listDeployments(app.id)).length === before.length);

  const applied = await client.apply({
    applicationId: app.id,
    files: [{ path: 'deployment.yaml', content: 'kind: Deployment\nmetadata:\n  name: checkout-api\n' }],
    dryRun: false,
    message: 'ship it',
  });
  check('applying records a revision',
    (await client.listDeployments(app.id)).length === before.length + 1);
  check('the new revision is the highest', applied.deployment.revision > before[0].revision);

  await client.rollback(app.id, before[0].revision);
  const history = await client.listDeployments(app.id);
  check('rollback is itself a deployment', history[0].message.includes('rollback'));

  /* Audit ---------------------------------------------------------------- */

  const all = await client.listActivity({});
  check('actions are appended to the ledger',
    all.some((entry) => entry.action === 'deployment.apply')
    && all.some((entry) => entry.action === 'deployment.rollback'));

  const failuresOnly = await client.listActivity({ statuses: ['failure'] });
  check('status filter narrows the ledger',
    failuresOnly.length > 0 && failuresOnly.every((entry) => entry.status === 'failure'));

  const searched = await client.listActivity({ query: 'checkout-api' });
  check('free text search matches a target name',
    searched.every((entry) => JSON.stringify(entry).toLowerCase().includes('checkout-api')));

  const actorFiltered = await client.listActivity({ actors: ['ci-bot@acme.test'] });
  check('actor filter is exact',
    actorFiltered.every((entry) => entry.actorEmail === 'ci-bot@acme.test'));

  const recent = await client.listActivity({ since: new Date(Date.now() - 3600_000).toISOString() });
  check('time filter excludes older rows', recent.length < all.length);

  /* CSV export ----------------------------------------------------------- */

  const csv = toCsv(all.slice(0, 5));
  const lines = csv.split('\n');
  check('csv has a header and one row per entry', lines.length === 6, `${lines.length} lines`);
  check('csv header carries every audited column',
    ['occurredAt', 'actorEmail', 'ip', 'userAgent', 'action', 'status', 'oldValue', 'newValue', 'requestId']
      .every((column) => lines[0].includes(column)));

  const quoted = toCsv([{
    ...all[0],
    error: 'denied: "minReplicas", must be >= 2',
  }]);
  check('csv quotes embedded commas and quotes', quoted.includes('""minReplicas""'));

  /* Sessions -------------------------------------------------------------- */

  await client.revokeSession('sess-3');
  const afterRevoke = await client.bootstrap();
  check('revoking a session removes it', !afterRevoke.sessions.some((session) => session.id === 'sess-3'));

  /* Demo data sanity ------------------------------------------------------- */

  check('demo data is deterministic across imports',
    demo.applications[0].resources.length === apps[0].resources.length);
  check('every resource carries a namespace',
    demo.applications.every((entry) => entry.resources.every((node) => node.namespace !== '')));


  /* ── live cluster inventory ─────────────────────────────────────────────── */

  {
    const client = new DemoClient();
    const inventory = await client.listInventory('cl-prod-eu', {});
    const objects = inventory.objects;

    check('the inventory reads more than the platform deployed',
      objects.length > objects.filter((object) => object.managed).length);

    check('objects installed by other tools are present',
      objects.some((object) => object.managedBy === 'helm' && !object.managed));

    check('a CRD instance appears without the app knowing the kind',
      objects.some((object) => object.apiVersion.startsWith('argoproj.io/')));

    check('cluster scoped objects carry no namespace',
      objects.filter((object) => object.kind === 'Node').every((object) => object.namespace === ''));

    check('kinds the credential cannot list are reported, not hidden',
      inventory.unreadable.some((entry) => entry.forbidden));

    check('a failed api group degrades the read instead of failing it',
      inventory.discoveryFailures.length > 0 && objects.length > 0);

    // Every inferred parent must resolve, or the topology draws an edge to
    // nothing.
    const uids = new Set(objects.map((object) => object.uid));
    check('every parent edge resolves',
      objects.filter((object) => object.parentId).every((object) => uids.has(object.parentId!)));

    check('pod parents are replica sets, not deployments directly',
      objects.filter((object) => object.kind === 'Pod' && object.parentId)
        .every((object) => {
          const parent = objects.find((candidate) => candidate.uid === object.parentId);
          return parent?.kind === 'ReplicaSet' || parent?.kind === 'StatefulSet' || parent?.kind === 'DaemonSet';
        }));

    check('service edges are marked inferred, owner edges are not',
      objects.filter((object) => object.kind === 'Service' && object.parentId)
        .every((object) => object.edge === 'selector'));

    const managedOnly = await client.listInventory('cl-prod-eu', { onlyManaged: true });
    check('the managed filter excludes observed objects',
      managedOnly.objects.every((object) => object.managed));
    check('the managed filter is narrower than the full read',
      managedOnly.objects.length < objects.length);

    const namespaced = await client.listInventory('cl-prod-eu', { namespaces: ['kube-system'] });
    check('the namespace filter is exact',
      namespaced.objects.every((object) => object.namespace === 'kube-system'));
    check('the namespace filter finds something', namespaced.objects.length > 0);

    const searched = await client.listInventory('cl-prod-eu', { search: 'coredns' });
    check('free text search matches a name', searched.objects.length > 0);

    const byImage = await client.listInventory('cl-prod-eu', { search: 'prometheus/node-exporter' });
    check('free text search matches an image', byImage.objects.length > 0);

    const kinds = await client.listApiResources('cl-prod-eu');
    check('discovery separates custom kinds from built-ins',
      kinds.some((entry) => entry.custom) && kinds.some((entry) => !entry.custom));

    const namespaces = await client.listNamespaces('cl-prod-eu');
    check('namespaces are derived from what was actually read',
      namespaces.includes('production') && namespaces.includes('kube-system'));
    check('the empty namespace of a cluster scoped object is not listed',
      !namespaces.includes(''));

    // An observed object has no desired state, so claiming it is in sync would
    // be a lie.
    const observed = objects.find((object) => !object.managed)!;
    const managed = objects.find((object) => object.managed)!;
    check('an observed object reports unknown sync', toResourceNode(observed).syncStatus === 'unknown');
    check('a managed object reports in sync', toResourceNode(managed).syncStatus === 'in_sync');
    check('age is derived from the creation timestamp', toResourceNode(managed).age > 0);

    check('reading the cluster is itself audited',
      (await client.listActivity({ actions: ['cluster.inventory'] })).length > 0);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILING`);
  if (failures) process.exit(1);
}

void main();
