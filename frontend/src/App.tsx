import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ChevronDown, CircleDot, Columns2, FileInput, GitCommitVertical,
  History, Layers3, PlayCircle, RotateCcw, ScanSearch, ShieldCheck, Trash2, Upload, X,
} from 'lucide-react';
import type { GeneratedFile, Model } from './core/types';
import { generate, importDocuments, resourceById, resourceGroups, resources, validate } from './core/registry';
import { parseDocuments } from './core/yaml';
import { set } from './core/model';
import { createZip } from './core/zip';
import { buildTopology } from './core/topology';
import type { ActivityEntry, Application, Cluster, CurrentUser } from './platform/types';
import { can } from './platform/types';
import type { PlatformClient } from './platform/api';
import { createClient } from './platform/api';
import { FormRenderer } from './components/FormRenderer';
import { YamlPane } from './components/YamlPane';
import { IssuePanel } from './components/IssuePanel';
import { ImportDialog } from './components/ImportDialog';
import { TopologyView } from './components/TopologyView';
import { ActivityView } from './components/ActivityView';
import { DeployView } from './components/DeployView';
import { ExplorerView } from './components/ExplorerView';
import { ResourceDrawer } from './components/ResourceDrawer';
import { toResourceNode } from './platform/inventory';
import type { ClusterResource } from './platform/types';
import { cls, surface } from './theme';

interface ClusterTarget {
  id: string;
  label: string;
  /** A target with no endpoint can author but not deploy. */
  live: boolean;
  note: string;
}

const CLUSTERS: ClusterTarget[] = [
  { id: 'none', label: 'No cluster attached', live: false, note: 'Authoring only. Nothing can be applied.' },
  { id: 'demo', label: 'demo-cluster (synthetic)', live: true, note: 'Synthetic health for evaluating the view. Not a real cluster.' },
];

const ORGS = ['acme-corp'];
const PROJECTS = ['platform', 'payments', 'storefront'];
const NAMESPACES = ['default', 'production', 'staging', 'observability'];

function download(name: string, content: BlobPart, type = 'text/yaml') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

export default function App() {
  const [resourceId, setResourceId] = useState(resources[0].id);
  const [models, setModels] = useState<Record<string, Model>>(() => ({ [resources[0].id]: resources[0].defaults() }));
  const [fileIndex, setFileIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'form' | 'yaml' | 'graph'>('form');
  const [rightView, setRightView] = useState<'yaml' | 'topology' | 'split'>('split');
  const [activityOpen, setActivityOpen] = useState(false);
  const [plan, setPlan] = useState<string | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [scope, setScope] = useState({
    organization: ORGS[0],
    project: PROJECTS[0],
    cluster: CLUSTERS[0].id,
    namespace: NAMESPACES[1],
  });
  const [mode, setMode] = useState<'author' | 'deploy' | 'explore'>('author');
  // The explorer works on live objects rather than the application tree, so it
  // keeps its own selection.
  const [inspectedResource, setInspectedResource] = useState<ClusterResource | null>(null);
  const [client, setClient] = useState<PlatformClient | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [liveClusters, setLiveClusters] = useState<Cluster[]>([]);
  const [projectSlugs, setProjectSlugs] = useState<string[]>(PROJECTS);
  const [applications, setApplications] = useState<Application[]>([]);
  const [applicationId, setApplicationId] = useState('');
  const [logCount, setLogCount] = useState(0);
  const copyTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  /** Authoring targets: the offline entry plus every connected cluster. */
  const clusterTargets: ClusterTarget[] = useMemo(() => [
    CLUSTERS[0],
    ...liveClusters.map((cluster) => ({
      id: cluster.id,
      label: `${cluster.name} (${cluster.slug})`,
      live: cluster.status !== 'unreachable',
      note: `${cluster.kubernetesVersion} · ${cluster.nodeCount} nodes · ${cluster.status} · ${cluster.authMode}`,
    })),
    ...(liveClusters.length === 0 ? [CLUSTERS[1]] : []),
  ], [liveClusters]);

  const target = clusterTargets.find((entry) => entry.id === scope.cluster) ?? clusterTargets[0];
  const namespaceOptions = useMemo(() => {
    const cluster = liveClusters.find((entry) => entry.id === scope.cluster);
    return cluster?.namespaces?.length ? cluster.namespaces : NAMESPACES;
  }, [liveClusters, scope.cluster]);
  const resource = resourceById.get(resourceId)!;
  const model = models[resourceId] ?? resource.defaults();

  const files: GeneratedFile[] = useMemo(() => generate(resource, model), [resource, model]);
  const issues = useMemo(() => validate(resource, model), [resource, model]);
  const errorPaths = useMemo(
    () => new Set(issues.filter((issue) => issue.level === 'error' && issue.path).map((issue) => issue.path!)),
    [issues],
  );
  const errorCount = issues.filter((issue) => issue.level === 'error').length;
  const warningCount = issues.length - errorCount;
  const active = files[Math.min(fileIndex, files.length - 1)] ?? files[0];

  const context = useMemo(() => ({
    actor: 'you@acme-corp.example',
    sessionId: 'sess_local',
    ip: '127.0.0.1',
    organization: scope.organization,
    project: scope.project,
    cluster: target.live ? target.label : undefined,
    namespace: scope.namespace,
  }), [scope, target]);

  /**
   * Every action goes to the ledger. The client decides where that is: the
   * server writes a hash-chained row, the demo client keeps it in memory.
   */
  const log = useCallback((action: string, fields: Partial<ActivityEntry> = {}) => {
    setLogCount((current) => current + 1);
    void client?.record({
      action,
      status: 'success',
      projectSlug: context.project,
      clusterSlug: context.cluster,
      namespace: context.namespace,
      ...fields,
    });
  }, [client, context]);

  const flash = useCallback((tone: 'ok' | 'warn', text: string) => {
    setToast({ tone, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    let cancelled = false;
    createClient().then(async (connected) => {
      if (cancelled) return;
      setClient(connected);
      try {
        const boot = await connected.bootstrap();
        if (cancelled) return;
        setUser(boot.user);
        setLiveClusters(boot.clusters);
        setProjectSlugs(boot.projects.map((project) => project.slug));
        setScope((current) => ({
          ...current,
          organization: boot.organization.slug,
          project: boot.projects[0]?.slug ?? current.project,
        }));
        const apps = await connected.listApplications();
        if (cancelled) return;
        setApplications(apps);
        setApplicationId(apps[0]?.id ?? '');
      } catch {
        // An unreachable control plane still leaves a usable authoring tool.
      }
      void connected.record({ action: 'auth.session.start', status: 'success', targetKind: 'Session' });
    });
    return () => { cancelled = true; };
  }, []);

  /** Drift is reported by the backend. Synthetic mode marks the first workload. */
  const drifted = useMemo(() => {
    if (!target.live) return [] as string[];
    const first = files.find((file) => file.language === 'yaml');
    if (!first) return [] as string[];
    try {
      const doc = parseDocuments(first.content)[0];
      return doc?.kind && doc?.metadata?.name ? [`${doc.kind}/${doc.metadata.name}`] : [];
    } catch {
      return [] as string[];
    }
  }, [files, target.live]);

  const topology = useMemo(
    () => buildTopology(files, {
      application: `${scope.project}/${resource.id}`,
      live: target.live,
      drifted,
    }),
    [files, scope.project, resource.id, target.live, drifted],
  );

  const selectResource = (id: string) => {
    setResourceId(id);
    setModels((current) => (current[id] ? current : { ...current, [id]: resourceById.get(id)!.defaults() }));
    setFileIndex(0);
    setEditing(false);
    setNotice(null);
    setMobileTab('form');
    log('yaml.open', { targetKind: resourceById.get(id)?.label, targetName: id });
  };

  const change = useCallback((path: string, value: any) => {
    setModels((current) => ({ ...current, [resourceId]: set(current[resourceId] ?? model, path, value) }));
  }, [resourceId, model]);

  const applyDraft = (value: string) => {
    setDraft(value);
    if (!resource.load) {
      setEditError('This format has no importer, so edits here are not read back into the form.');
      return;
    }
    try {
      const docs = files.flatMap((file, index) => {
        if (file.language !== 'yaml') return [];
        return parseDocuments(index === fileIndex ? value : file.content);
      });
      const next = resource.load(docs);
      if (!next) {
        setEditError('The edited document no longer matches this form.');
        return;
      }
      setModels((current) => ({ ...current, [resourceId]: next }));
      setEditError(null);
    } catch (error: any) {
      setEditError(error?.line ? `Line ${error.line}: ${error.message}` : String(error?.message ?? error));
    }
  };

  const toggleEdit = () => {
    if (editing) {
      setEditing(false);
      setEditError(null);
      return;
    }
    setDraft(active?.content ?? '');
    setEditError(null);
    setEditing(true);
    log('yaml.edit', { targetKind: resource.label, targetName: active?.path });
  };

  const handleCopy = async () => {
    await copyText(active?.content ?? '');
    setCopied(true);
    log('yaml.copy', { targetKind: resource.label, targetName: active?.path });
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  const handleImport = (text: string): string | null => {
    try {
      const result = importDocuments(text);
      setResourceId(result.resource.id);
      setModels((current) => ({ ...current, [result.resource.id]: result.model }));
      setFileIndex(0);
      setEditing(false);
      setMobileTab('form');
      setNotice(
        result.ignored.length
          ? `Loaded as ${result.resource.label}. Ignored ${result.ignored.join(', ')} — import those separately.`
          : `Loaded as ${result.resource.label}.`,
      );
      log('yaml.import', { targetKind: result.resource.label, targetName: result.resource.id });
      return null;
    } catch (error: any) {
      log('yaml.import', { status: 'failure', error: String(error?.message ?? error) });
      return String(error?.message ?? error);
    }
  };

  const bundleName = `${resource.id}-${scope.namespace}`;

  const exportBundle = () => {
    if (files.length === 1) download(files[0].path.split('/').pop()!, files[0].content);
    else download(`${bundleName}.zip`, createZip(files, bundleName), 'application/zip');
    log('yaml.download', { targetKind: resource.label, targetName: bundleName });
  };

  const buildPlan = () => {
    const lines: string[] = [];
    lines.push(`target      ${target.live ? target.label : 'none'}`);
    lines.push(`namespace   ${scope.namespace}`);
    lines.push(`project     ${scope.organization}/${scope.project}`);
    lines.push('');
    for (const file of files) {
      if (file.language !== 'yaml') {
        lines.push(`  write   ${file.path}`);
        continue;
      }
      try {
        for (const doc of parseDocuments(file.content)) {
          const kind = doc?.kind ?? 'Document';
          const name = doc?.metadata?.name ?? '-';
          const verb = drifted.includes(`${kind}/${name}`) ? 'update ' : target.live ? 'create ' : 'plan   ';
          lines.push(`  ${verb} ${kind}/${name}`);
        }
      } catch (error: any) {
        lines.push(`  error   ${file.path}: ${error?.message ?? error}`);
      }
    }
    lines.push('');
    lines.push(`${errorCount} blocking errors, ${warningCount} warnings`);
    if (!target.live) {
      lines.push('');
      lines.push('No cluster is attached, so this is a local plan only. Attach a cluster to');
      lines.push('run a real server-side dry run (equivalent to apply --dry-run=server).');
    }
    return lines.join('\n');
  };

  const requireCluster = (action: string): boolean => {
    if (target.live) return true;
    log(action, { status: 'denied', error: 'no cluster attached' });
    flash('warn', 'No cluster attached. Connect one to run this action.');
    return false;
  };

  const runDryRun = () => {
    setPlan(buildPlan());
    log('deployment.dry_run', {
      targetKind: resource.label,
      targetName: bundleName,
      status: errorCount ? 'failure' : 'success',
      error: errorCount ? `${errorCount} validation errors` : undefined,
    });
  };

  const runApply = () => {
    if (!requireCluster('deployment.apply')) return;
    if (errorCount) {
      log('deployment.apply', { status: 'failure', error: `${errorCount} validation errors`, targetName: bundleName });
      flash('warn', 'Fix the blocking errors before applying.');
      return;
    }
    log('deployment.apply', { targetKind: resource.label, targetName: bundleName, newValue: `${files.length} files` });
    flash('ok', `Queued ${files.length} object(s) for ${target.label}.`);
  };

  const runDelete = () => {
    if (!requireCluster('deployment.delete')) return;
    log('deployment.delete', { targetKind: resource.label, targetName: bundleName });
    flash('ok', 'Delete request recorded.');
  };

  const runRollback = () => {
    if (!requireCluster('deployment.rollback')) return;
    log('deployment.rollback', {
      targetKind: resource.label, targetName: bundleName, oldValue: 'revision n', newValue: 'revision n-1',
    });
    flash('ok', 'Rollback to the previous revision recorded.');
  };

  return (
    <div className="flex h-screen flex-col text-slate-200" style={surface.page}>
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={surface.primary}>
            <Layers3 className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="font-mono text-sm tracking-tight text-slate-100">manifest workbench</p>
            <p className={cls.eyebrow}>author · validate · deploy</p>
          </div>
        </div>

        <div className="hidden items-center gap-1.5 md:flex">
          <Scope label="org" value={scope.organization} options={[scope.organization]} onChange={(value) => setScope((s) => ({ ...s, organization: value }))} />
          <Scope
            label="project"
            value={scope.project}
            options={projectSlugs}
            onChange={(value) => { setScope((s) => ({ ...s, project: value })); log('scope.change', { targetKind: 'Project', targetName: value }); }}
          />
          <Scope
            label="cluster"
            value={scope.cluster}
            options={clusterTargets.map((entry) => entry.id)}
            render={(id) => clusterTargets.find((entry) => entry.id === id)?.label ?? id}
            onChange={(value) => { setScope((s) => ({ ...s, cluster: value })); log('cluster.select', { targetKind: 'Cluster', targetName: value }); }}
          />
          <Scope label="ns" value={scope.namespace} options={namespaceOptions} onChange={(value) => setScope((s) => ({ ...s, namespace: value }))} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={surface.chip}>
            {(['author', 'deploy', 'explore'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => { setMode(value); log('view.change', { targetName: value }); }}
                className={`rounded-md px-2.5 py-1 font-mono text-xs uppercase tracking-wider transition ${
                  mode === value ? 'bg-white/10 text-teal-200' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
          <span
            style={surface.chip}
            title={target.note}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs uppercase tracking-wider sm:inline-flex"
          >
            <CircleDot className="h-3.5 w-3.5" style={{ color: target.live ? '#2dd4bf' : '#64748b' }} />
            {target.live ? 'live' : 'offline'}
          </span>
          <button
            type="button"
            onClick={() => { setActivityOpen(true); log('activity.view'); }}
            style={surface.chip}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-200 transition hover:text-teal-200"
          >
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">Activity</span>
            <span className="font-mono text-xs text-slate-400">{logCount}</span>
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            style={surface.chip}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-200 transition hover:text-teal-200"
          >
            <FileInput className="h-4 w-4" />
            <span className="hidden sm:inline">Import</span>
          </button>
          <button
            type="button"
            onClick={exportBundle}
            style={surface.primary}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium"
          >
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">{files.length === 1 ? 'Download' : `Download ${files.length}`}</span>
          </button>
        </div>
      </header>

      {mode === 'explore' && client ? (
        <div className="relative flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1">
            <ExplorerView
              client={client}
              clusterId={scope.cluster}
              clusterLabel={clusterTargets.find((entry) => entry.id === scope.cluster)?.label ?? scope.cluster}
              selectedUid={inspectedResource?.uid}
              onSelect={(resource) => {
                setInspectedResource(resource);
                log('cluster.resource.inspect', { targetKind: resource.kind, targetName: resource.name });
              }}
            />
          </div>
          {inspectedResource && (
            <div className="absolute inset-y-0 right-0 z-20 w-full max-w-sm lg:relative lg:inset-auto lg:z-auto lg:w-96">
              {/* Deleting from the explorer is a deliberate omission: an
                  object this platform never applied should be removed where it
                  was created, not from a read-only view of the cluster. */}
              <ResourceDrawer
                node={toResourceNode(inspectedResource)}
                onClose={() => setInspectedResource(null)}
                canDelete={false}
                onDelete={() => undefined}
              />
            </div>
          )}
        </div>
      ) : mode === 'deploy' && client ? (
        <div className="min-h-0 flex-1">
          <DeployView
            client={client}
            applications={applications}
            selectedId={applicationId}
            onSelectApplication={(id) => {
              setApplicationId(id);
              log('application.select', { targetKind: 'Application', targetName: id });
            }}
            canDeploy={can(user, 'deployment.apply')}
            onToast={(tone, message) => flash(tone, message)}
          />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-slate-800 py-3 lg:block">
          {resourceGroups.map((group) => (
            <div key={group.name} className="mb-4">
              <h2 className={`${cls.eyebrow} px-4 pb-1.5`}>{group.name}</h2>
              {group.items.map((item) => {
                const selected = item.id === resourceId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectResource(item.id)}
                    style={selected ? { background: 'linear-gradient(90deg, rgba(45,212,191,0.16), transparent)' } : undefined}
                    className={`flex w-full flex-col items-start border-l-2 px-4 py-1.5 text-left transition ${
                      selected ? 'border-teal-400 text-teal-100' : 'border-transparent text-slate-300 hover:text-slate-100'
                    }`}
                  >
                    <span className="text-sm leading-tight">{item.label}</span>
                    {item.apiVersion && (
                      <span className={`font-mono text-xs ${selected ? 'text-teal-400' : 'text-slate-500'}`}>
                        {item.apiVersion}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <main className="flex min-w-0 flex-1 flex-col lg:flex-row">
          <section className={`min-h-0 min-w-0 flex-col lg:flex lg:w-2/5 lg:border-r lg:border-slate-800 ${mobileTab === 'form' ? 'flex flex-1' : 'hidden'}`}>
            <div className="shrink-0 border-b border-slate-800 px-4 py-3">
              <div className="lg:hidden">
                <label htmlFor="resource-picker" className={cls.label}>Resource</label>
                <select
                  id="resource-picker"
                  value={resourceId}
                  onChange={(event) => selectResource(event.target.value)}
                  style={surface.input}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-slate-100 outline-none"
                >
                  {resourceGroups.map((group) => (
                    <optgroup key={group.name} label={group.name}>
                      {group.items.map((item) => (
                        <option key={item.id} value={item.id} className="bg-slate-900">{item.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="hidden items-baseline gap-3 lg:flex">
                <h1 className="text-lg font-semibold tracking-tight text-slate-100">{resource.label}</h1>
                <p className="min-w-0 truncate text-sm text-slate-500">{resource.summary}</p>
                <button
                  type="button"
                  onClick={() => {
                    setModels((current) => ({ ...current, [resourceId]: resource.defaults() }));
                    log('yaml.reset', { targetName: resource.id });
                  }}
                  className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-400 transition hover:border-amber-500 hover:text-amber-300"
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
              {notice && (
                <div
                  className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-teal-800 px-3 py-2 text-sm text-teal-100"
                  style={{ background: 'rgba(45,212,191,0.10)' }}
                >
                  <span>{notice}</span>
                  <button type="button" onClick={() => setNotice(null)} className="font-mono text-xs uppercase text-teal-300">
                    dismiss
                  </button>
                </div>
              )}
              <FormRenderer fields={resource.fields} model={model} prefix="" errors={errorPaths} onChange={change} />

              <div className="mt-10 border-t border-slate-800 pt-5">
                <h3 className={`${cls.eyebrow} mb-3 flex items-center gap-3`}>
                  Validation
                  <span className="h-px flex-1 bg-slate-800" />
                  <span className={errorCount ? 'text-rose-400' : 'text-slate-600'}>{errorCount} errors</span>
                  <span className={warningCount ? 'text-amber-400' : 'text-slate-600'}>{warningCount} warnings</span>
                </h3>
                <IssuePanel issues={issues} />
              </div>
              <p className="mt-8 pb-6 text-xs leading-relaxed text-slate-600">
                Authoring happens entirely in this page. Applying, drift detection and live health require the Go
                service holding a cluster credential; nothing in the browser does.
              </p>
            </div>
          </section>

          <section className={`min-h-0 min-w-0 flex-1 flex-col lg:flex ${mobileTab === 'form' ? 'hidden' : 'flex'}`}>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
              <div className="hidden items-center gap-1 lg:flex">
                {([['yaml', 'YAML'], ['topology', 'Topology'], ['split', 'Split']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRightView(value)}
                    style={rightView === value ? surface.chip : undefined}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs uppercase tracking-wider transition ${
                      rightView === value ? 'text-teal-200' : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {value === 'split' && <Columns2 className="h-3.5 w-3.5" />}
                    {label}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <ActionButton icon={ScanSearch} label="Dry run" onClick={runDryRun} />
                <ActionButton icon={PlayCircle} label="Apply" onClick={runApply} tone="primary" disabled={errorCount > 0} />
                <ActionButton icon={GitCommitVertical} label="Commit" onClick={() => setGitOpen(true)} />
                <ActionButton icon={RotateCcw} label="Rollback" onClick={runRollback} />
                <ActionButton icon={Trash2} label="Delete" onClick={runDelete} tone="danger" />
              </div>
            </div>

            {drifted.length > 0 && (
              <div
                className="flex shrink-0 items-center gap-2 border-b border-amber-900 px-3 py-1.5 text-xs text-amber-200"
                style={{ background: 'rgba(251,191,36,0.08)' }}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Drift detected on {drifted.join(', ')} — live state differs from this manifest.
              </div>
            )}

            <div className={`flex min-h-0 flex-1 ${rightView === 'split' ? 'flex-col' : ''}`}>
              <div
                className={`min-h-0 ${rightView === 'split' ? 'h-1/2 border-b border-slate-800' : 'flex-1'} ${
                  rightView === 'topology' ? 'hidden' : ''
                } ${mobileTab === 'graph' ? 'hidden lg:block' : ''}`}
              >
                <YamlPane
                  files={files}
                  activeIndex={Math.min(fileIndex, files.length - 1)}
                  onSelect={(index) => { setFileIndex(index); setEditing(false); }}
                  editing={editing}
                  draft={draft}
                  editError={editError}
                  onDraftChange={applyDraft}
                  onToggleEdit={toggleEdit}
                  onCopy={handleCopy}
                  onDownload={() => { download(active.path.split('/').pop()!, active.content); log('yaml.download', { targetName: active.path }); }}
                  onDownloadAll={exportBundle}
                  copied={copied}
                />
              </div>
              <div
                className={`min-h-0 ${rightView === 'split' ? 'h-1/2' : 'flex-1'} ${
                  rightView === 'yaml' ? 'hidden' : ''
                } ${mobileTab === 'yaml' ? 'hidden lg:block' : ''}`}
              >
                <TopologyView
                  topology={topology}
                  live={target.live}
                  onInspect={(node) => node && log('topology.inspect', { targetKind: node.kind, targetName: node.name })}
                />
              </div>
            </div>
          </section>
        </main>
      </div>

      )}

      <div className={`shrink-0 border-t border-slate-800 lg:hidden ${mode === 'deploy' ? 'hidden' : 'flex'}`}>
        {(['form', 'yaml', 'graph'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setMobileTab(value)}
            className={`flex-1 py-2.5 font-mono text-xs uppercase tracking-widest transition ${
              mobileTab === value ? 'border-t-2 border-teal-400 text-teal-200' : 'text-slate-500'
            }`}
          >
            {value}
            {value === 'form' && errorCount > 0 && (
              <span className="ml-1.5 rounded-full px-1.5 text-rose-300" style={{ background: 'rgba(244,63,94,0.18)' }}>
                {errorCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {toast && (
        <div
          style={surface.glass}
          className="fixed bottom-16 left-1/2 z-40 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm lg:bottom-6"
        >
          {toast.tone === 'ok'
            ? <ShieldCheck className="h-4 w-4 text-teal-300" />
            : <AlertTriangle className="h-4 w-4 text-amber-300" />}
          <span className="text-slate-100">{toast.text}</span>
        </div>
      )}

      {plan !== null && (
        <Sheet title="Dry run plan" onClose={() => setPlan(null)}>
          <pre style={surface.well} className="overflow-x-auto rounded-xl p-3 font-mono text-xs leading-relaxed text-slate-200">
            {plan}
          </pre>
        </Sheet>
      )}

      {gitOpen && (
        <GitSheet
          defaultPath={`clusters/${scope.namespace}/${resource.id}`}
          fileCount={files.length}
          onClose={() => setGitOpen(false)}
          onCommit={(details) => {
            log('git.commit', {
              targetKind: 'Commit',
              targetName: `${details.repository}@${details.branch}`,
              newValue: `${files.length} files -> ${details.path}`,
            });
            setGitOpen(false);
            flash('ok', 'Commit recorded. Connect the Git integration to push.');
          }}
        />
      )}

      {activityOpen && client && (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/60 backdrop-blur-sm">
          <div className="flex h-full w-full max-w-3xl flex-col border-l border-white/10" style={surface.well}>
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <h2 className={cls.eyebrow}>Activity</h2>
                <p className="text-xs text-slate-500">
                  Immutable audit trail. {client.mode === 'demo' ? 'Local ledger — connect the API for the hash-chained copy.' : 'Served from activity_log.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActivityOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ActivityView client={client} canExport={can(user, 'activity.export')} />
            </div>
          </div>
        </div>
      )}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={handleImport} />
    </div>
  );
}

function Scope({ label, value, options, onChange, render }: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  render?: (value: string) => string;
}) {
  return (
    <label style={surface.chip} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5">
      <span className="font-mono text-xs uppercase tracking-wider text-slate-500">{label}</span>
      <span className="relative flex items-center">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="appearance-none bg-transparent pr-4 font-mono text-xs text-slate-100 outline-none"
        >
          {options.map((option) => (
            <option key={option} value={option} className="bg-slate-900">
              {render ? render(option) : option}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-slate-500" />
      </span>
    </label>
  );
}

function ActionButton({ icon: Icon, label, onClick, tone, disabled }: {
  icon: typeof Activity;
  label: string;
  onClick: () => void;
  tone?: 'primary' | 'danger';
  disabled?: boolean;
}) {
  const base = tone === 'primary' ? surface.primary : tone === 'danger' ? surface.danger : surface.chip;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      style={{ ...base, opacity: disabled ? 0.45 : 1 }}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs uppercase tracking-wider transition ${
        tone === 'danger' ? 'text-rose-200' : tone === 'primary' ? '' : 'text-slate-200'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center p-0 sm:items-center sm:p-6" style={{ background: 'rgba(2,6,14,0.72)' }}>
      <div style={surface.glass} className="flex max-h-full w-full max-w-2xl flex-col rounded-t-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <p className={cls.eyebrow}>{title}</p>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 transition hover:text-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function GitSheet({ defaultPath, fileCount, onClose, onCommit }: {
  defaultPath: string;
  fileCount: number;
  onClose: () => void;
  onCommit: (details: { repository: string; branch: string; path: string; message: string }) => void;
}) {
  const [repository, setRepository] = useState('git@github.com:acme-corp/platform-manifests.git');
  const [branch, setBranch] = useState('main');
  const [path, setPath] = useState(defaultPath);
  const [message, setMessage] = useState('chore(manifests): update generated resources');
  const fields: [string, string, (value: string) => void][] = [
    ['Repository', repository, setRepository],
    ['Branch', branch, setBranch],
    ['Path', path, setPath],
    ['Message', message, setMessage],
  ];
  return (
    <Sheet title="Commit to Git" onClose={onClose}>
      <div className="space-y-3">
        {fields.map(([label, value, setter]) => (
          <div key={label}>
            <span className={cls.label}>{label}</span>
            <input
              value={value}
              onChange={(event) => setter(event.target.value)}
              style={surface.input}
              className={`mt-1 ${cls.input} font-mono focus:ring-teal-500`}
            />
          </div>
        ))}
        <p className="text-xs leading-relaxed text-slate-500">
          {fileCount} file(s) will be written under <span className="font-mono text-slate-400">{path}</span>. The
          backend performs the commit with a deploy key held server side; the browser never sees Git credentials.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onCommit({ repository, branch, path, message })}
            style={surface.primary}
            className="rounded-lg px-4 py-2 text-sm font-medium"
          >
            Commit
          </button>
        </div>
      </div>
    </Sheet>
  );
}
