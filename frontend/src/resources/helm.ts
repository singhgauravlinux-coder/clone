import type { GeneratedFile, Issue, Model, ResourceDefinition } from '../core/types';
import { get, mapToPairs, num, str, toList } from '../core/model';
import { textFile, yamlFile } from '../core/files';
import { checkQuantity, DNS_1123_LABEL } from '../core/validation';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/;

/** Turn "image.tag" into a nested object so values.yaml reads naturally. */
function setDeep(target: Record<string, any>, path: string, value: any) {
  const keys = path.split('.');
  let node = target;
  keys.slice(0, -1).forEach((key) => {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  });
  node[keys[keys.length - 1]] = value;
}

function coerce(raw: string): any {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

const HELPERS_TPL = `{{/*
Expand the name of the chart.
*/}}
{{- define "chart.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name, capped at 63 characters for the DNS label limit.
*/}}
{{- define "chart.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "chart.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "chart.labels" -}}
helm.sh/chart: {{ include "chart.chart" . }}
{{ include "chart.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "chart.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chart.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "chart.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "chart.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
`;

const DEPLOYMENT_TPL = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "chart.fullname" . }}
  labels:
    {{- include "chart.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "chart.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      {{- with .Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      labels:
        {{- include "chart.selectorLabels" . | nindent 8 }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "chart.serviceAccountName" . }}
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .Values.service.targetPort }}
              protocol: TCP
          {{- with .Values.env }}
          env:
            {{- range $key, $value := . }}
            - name: {{ $key }}
              value: {{ $value | quote }}
            {{- end }}
          {{- end }}
          livenessProbe:
            httpGet:
              path: {{ .Values.probes.path }}
              port: http
          readinessProbe:
            httpGet:
              path: {{ .Values.probes.path }}
              port: http
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
`;

const SERVICE_TPL = `apiVersion: v1
kind: Service
metadata:
  name: {{ include "chart.fullname" . }}
  labels:
    {{- include "chart.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "chart.selectorLabels" . | nindent 4 }}
`;

const SERVICEACCOUNT_TPL = `{{- if .Values.serviceAccount.create -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "chart.serviceAccountName" . }}
  labels:
    {{- include "chart.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
`;

const INGRESS_TPL = `{{- if .Values.ingress.enabled -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "chart.fullname" . }}
  labels:
    {{- include "chart.labels" . | nindent 4 }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .Values.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- if .Values.ingress.tls }}
  tls:
    {{- range .Values.ingress.tls }}
    - hosts:
        {{- range .hosts }}
        - {{ . | quote }}
        {{- end }}
      secretName: {{ .secretName }}
    {{- end }}
  {{- end }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host | quote }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            pathType: {{ .pathType }}
            backend:
              service:
                name: {{ include "chart.fullname" $ }}
                port:
                  number: {{ $.Values.service.port }}
          {{- end }}
    {{- end }}
{{- end }}
`;

const HPA_TPL = `{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "chart.fullname" . }}
  labels:
    {{- include "chart.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "chart.fullname" . }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    {{- if .Values.autoscaling.targetCPUUtilizationPercentage }}
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
    {{- end }}
{{- end }}
`;

const HELMIGNORE = `.DS_Store
.git/
.gitignore
*.tmproj
.idea/
.vscode/
*.tgz
`;

export const helmChart: ResourceDefinition = {
  id: 'helm-chart',
  group: 'Packaging',
  label: 'Helm chart',
  summary: 'Chart.yaml, values.yaml and a templates directory.',
  apiVersion: 'v2',
  fields: [
    { path: 'chart.name', label: 'Chart name', kind: 'text', mono: true, required: true, half: true, section: 'Chart' },
    {
      path: 'chart.version', label: 'Chart version', kind: 'text', mono: true, required: true, half: true,
      section: 'Chart', placeholder: '0.1.0', help: 'SemVer 2. Bump on every chart change.',
    },
    {
      path: 'chart.appVersion', label: 'App version', kind: 'text', mono: true, half: true, section: 'Chart',
      placeholder: '1.0.0', help: 'Default image tag when values.image.tag is empty.',
    },
    {
      path: 'chart.type', label: 'Chart type', kind: 'select', half: true, section: 'Chart',
      options: [{ value: 'application', label: 'application' }, { value: 'library', label: 'library' }],
    },
    { path: 'chart.description', label: 'Description', kind: 'text', section: 'Chart' },
    {
      path: 'chart.kubeVersion', label: 'Kubernetes constraint', kind: 'text', mono: true, half: true,
      section: 'Chart', placeholder: '>=1.25.0-0',
    },
    { path: 'chart.keywords', label: 'Keywords', kind: 'text', half: true, section: 'Chart', help: 'Comma separated.' },
    {
      path: 'dependencies', label: 'Dependencies', kind: 'array', section: 'Dependencies', itemLabel: 'dependency',
      itemDefault: () => ({ name: '', version: '', repository: '', condition: '' }),
      itemFields: [
        { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, required: true },
        { path: 'version', label: 'Version', kind: 'text', mono: true, half: true, required: true, placeholder: '^12.0.0' },
        {
          path: 'repository', label: 'Repository', kind: 'text', mono: true, required: true,
          placeholder: 'https://charts.bitnami.com/bitnami',
        },
        { path: 'condition', label: 'Condition', kind: 'text', mono: true, half: true, placeholder: 'postgresql.enabled' },
      ],
    },
    { path: 'values.replicaCount', label: 'Replica count', kind: 'number', half: true, min: 0, section: 'Values' },
    {
      path: 'values.image.repository', label: 'Image repository', kind: 'text', mono: true, half: true,
      required: true, section: 'Values', placeholder: 'ghcr.io/org/app',
    },
    {
      path: 'values.image.tag', label: 'Image tag', kind: 'text', mono: true, half: true, section: 'Values',
      help: 'Empty falls back to appVersion.',
    },
    {
      path: 'values.image.pullPolicy', label: 'Pull policy', kind: 'select', half: true, section: 'Values',
      options: [
        { value: 'IfNotPresent', label: 'IfNotPresent' },
        { value: 'Always', label: 'Always' },
        { value: 'Never', label: 'Never' },
      ],
    },
    {
      path: 'values.service.type', label: 'Service type', kind: 'select', half: true, section: 'Values',
      options: [
        { value: 'ClusterIP', label: 'ClusterIP' },
        { value: 'NodePort', label: 'NodePort' },
        { value: 'LoadBalancer', label: 'LoadBalancer' },
      ],
    },
    { path: 'values.service.port', label: 'Service port', kind: 'number', half: true, min: 1, section: 'Values' },
    { path: 'values.service.targetPort', label: 'Container port', kind: 'number', half: true, min: 1, section: 'Values' },
    { path: 'values.probes.path', label: 'Probe path', kind: 'text', mono: true, half: true, section: 'Values' },
    { path: 'values.resources.requests.cpu', label: 'CPU request', kind: 'text', mono: true, half: true, section: 'Values' },
    { path: 'values.resources.requests.memory', label: 'Memory request', kind: 'text', mono: true, half: true, section: 'Values' },
    { path: 'values.resources.limits.cpu', label: 'CPU limit', kind: 'text', mono: true, half: true, section: 'Values' },
    { path: 'values.resources.limits.memory', label: 'Memory limit', kind: 'text', mono: true, half: true, section: 'Values' },
    { path: 'values.env', label: 'Environment values', kind: 'keyvalue', section: 'Values' },
    {
      path: 'values.extra', label: 'Extra values', kind: 'keyvalue', section: 'Values',
      keyLabel: 'postgresql.enabled', valueLabel: 'true', help: 'Dotted keys become nested values.',
    },
    { path: 'features.ingress', label: 'Include Ingress template', kind: 'boolean', half: true, section: 'Templates' },
    {
      path: 'values.ingress.host', label: 'Ingress host', kind: 'text', mono: true, half: true, section: 'Templates',
      when: (model) => get(model, 'features.ingress') === true,
    },
    {
      path: 'values.ingress.className', label: 'Ingress class', kind: 'text', mono: true, half: true,
      section: 'Templates', when: (model) => get(model, 'features.ingress') === true,
    },
    { path: 'features.autoscaling', label: 'Include HPA template', kind: 'boolean', half: true, section: 'Templates' },
    {
      path: 'values.autoscaling.minReplicas', label: 'Min replicas', kind: 'number', half: true, min: 1,
      section: 'Templates', when: (model) => get(model, 'features.autoscaling') === true,
    },
    {
      path: 'values.autoscaling.maxReplicas', label: 'Max replicas', kind: 'number', half: true, min: 1,
      section: 'Templates', when: (model) => get(model, 'features.autoscaling') === true,
    },
    {
      path: 'values.autoscaling.targetCPU', label: 'Target CPU (%)', kind: 'number', half: true, min: 1, max: 100,
      section: 'Templates', when: (model) => get(model, 'features.autoscaling') === true,
    },
    {
      path: 'features.serviceAccount', label: 'Include ServiceAccount template', kind: 'boolean', half: true,
      section: 'Templates',
    },
  ],
  defaults: () => ({
    chart: {
      name: 'app', version: '0.1.0', appVersion: '1.0.0', type: 'application',
      description: 'A Helm chart for Kubernetes', kubeVersion: '', keywords: '',
    },
    dependencies: [],
    values: {
      replicaCount: 2,
      image: { repository: 'ghcr.io/org/app', tag: '', pullPolicy: 'IfNotPresent' },
      service: { type: 'ClusterIP', port: 80, targetPort: 8080 },
      probes: { path: '/healthz' },
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '', memory: '512Mi' } },
      env: [],
      extra: [],
      ingress: { host: 'app.example.com', className: 'nginx' },
      autoscaling: { minReplicas: 2, maxReplicas: 10, targetCPU: 70 },
    },
    features: { ingress: true, autoscaling: false, serviceAccount: true },
  }),
  build: (model) => {
    const name = str(get(model, 'chart.name')) ?? 'app';
    const files: GeneratedFile[] = [];

    files.push(yamlFile('Chart.yaml', {
      apiVersion: 'v2',
      name,
      description: str(get(model, 'chart.description')),
      type: get(model, 'chart.type') || 'application',
      version: str(get(model, 'chart.version')) ?? '0.1.0',
      appVersion: str(get(model, 'chart.appVersion')),
      kubeVersion: str(get(model, 'chart.kubeVersion')),
      keywords: toList(get(model, 'chart.keywords')),
      dependencies: (get(model, 'dependencies') ?? [])
        .filter((dep: any) => str(dep?.name))
        .map((dep: any) => ({
          name: str(dep.name),
          version: str(dep.version),
          repository: str(dep.repository),
          condition: str(dep.condition),
        })),
    }));

    const values: Record<string, any> = {
      replicaCount: num(get(model, 'values.replicaCount')) ?? 1,
      image: {
        repository: str(get(model, 'values.image.repository')) ?? '',
        pullPolicy: get(model, 'values.image.pullPolicy') || 'IfNotPresent',
        tag: str(get(model, 'values.image.tag')) ?? '',
      },
      imagePullSecrets: [],
      nameOverride: '',
      fullnameOverride: '',
      serviceAccount: {
        create: get(model, 'features.serviceAccount') === true,
        annotations: {},
        name: '',
      },
      podAnnotations: {},
      service: {
        type: get(model, 'values.service.type') || 'ClusterIP',
        port: num(get(model, 'values.service.port')) ?? 80,
        targetPort: num(get(model, 'values.service.targetPort')) ?? 8080,
      },
      probes: { path: str(get(model, 'values.probes.path')) ?? '/' },
      ingress: {
        enabled: get(model, 'features.ingress') === true,
        className: str(get(model, 'values.ingress.className')) ?? '',
        annotations: {},
        hosts: [{
          host: str(get(model, 'values.ingress.host')) ?? 'chart-example.local',
          paths: [{ path: '/', pathType: 'Prefix' }],
        }],
        tls: [],
      },
      resources: {
        requests: {
          cpu: str(get(model, 'values.resources.requests.cpu')),
          memory: str(get(model, 'values.resources.requests.memory')),
        },
        limits: {
          cpu: str(get(model, 'values.resources.limits.cpu')),
          memory: str(get(model, 'values.resources.limits.memory')),
        },
      },
      autoscaling: {
        enabled: get(model, 'features.autoscaling') === true,
        minReplicas: num(get(model, 'values.autoscaling.minReplicas')) ?? 1,
        maxReplicas: num(get(model, 'values.autoscaling.maxReplicas')) ?? 10,
        targetCPUUtilizationPercentage: num(get(model, 'values.autoscaling.targetCPU')) ?? 80,
      },
      env: Object.fromEntries(
        (get(model, 'values.env') ?? [])
          .filter((row: any) => str(row?.key))
          .map((row: any) => [str(row.key), String(row.value ?? '')]),
      ),
      nodeSelector: {},
      tolerations: [],
    };
    for (const row of get(model, 'values.extra') ?? []) {
      if (str(row?.key)) setDeep(values, String(row.key).trim(), coerce(String(row.value ?? '')));
    }

    files.push(yamlFile('values.yaml', values));
    files.push(textFile('.helmignore', HELMIGNORE));
    files.push(textFile('templates/_helpers.tpl', HELPERS_TPL));
    files.push(textFile('templates/deployment.yaml', DEPLOYMENT_TPL));
    files.push(textFile('templates/service.yaml', SERVICE_TPL));
    if (get(model, 'features.serviceAccount') === true) {
      files.push(textFile('templates/serviceaccount.yaml', SERVICEACCOUNT_TPL));
    }
    if (get(model, 'features.ingress') === true) files.push(textFile('templates/ingress.yaml', INGRESS_TPL));
    if (get(model, 'features.autoscaling') === true) files.push(textFile('templates/hpa.yaml', HPA_TPL));
    return files;
  },
  load: (docs) => {
    const chart = docs.find((doc) => doc?.apiVersion === 'v2' && doc?.name && doc?.version);
    const values = docs.find((doc) => doc?.image || doc?.replicaCount !== undefined);
    if (!chart && !values) return null;
    const model: Model = helmChart.defaults();
    if (chart) {
      model.chart = {
        name: chart.name ?? '',
        version: chart.version ?? '',
        appVersion: chart.appVersion ?? '',
        type: chart.type ?? 'application',
        description: chart.description ?? '',
        kubeVersion: chart.kubeVersion ?? '',
        keywords: (chart.keywords ?? []).join(', '),
      };
      model.dependencies = (chart.dependencies ?? []).map((dep: any) => ({
        name: dep?.name ?? '',
        version: dep?.version ?? '',
        repository: dep?.repository ?? '',
        condition: dep?.condition ?? '',
      }));
    }
    if (values) {
      model.values.replicaCount = values.replicaCount ?? 1;
      model.values.image = {
        repository: values.image?.repository ?? '',
        tag: values.image?.tag ?? '',
        pullPolicy: values.image?.pullPolicy ?? 'IfNotPresent',
      };
      model.values.service = {
        type: values.service?.type ?? 'ClusterIP',
        port: values.service?.port ?? 80,
        targetPort: values.service?.targetPort ?? 8080,
      };
      model.values.probes = { path: values.probes?.path ?? '/' };
      model.values.resources = {
        requests: {
          cpu: values.resources?.requests?.cpu ?? '',
          memory: values.resources?.requests?.memory ?? '',
        },
        limits: {
          cpu: values.resources?.limits?.cpu ?? '',
          memory: values.resources?.limits?.memory ?? '',
        },
      };
      model.values.env = mapToPairs(values.env);
      model.features = {
        ingress: values.ingress?.enabled === true,
        autoscaling: values.autoscaling?.enabled === true,
        serviceAccount: values.serviceAccount?.create === true,
      };
      model.values.ingress = {
        host: values.ingress?.hosts?.[0]?.host ?? '',
        className: values.ingress?.className ?? '',
      };
      model.values.autoscaling = {
        minReplicas: values.autoscaling?.minReplicas ?? 1,
        maxReplicas: values.autoscaling?.maxReplicas ?? 10,
        targetCPU: values.autoscaling?.targetCPUUtilizationPercentage ?? 80,
      };
    }
    return model;
  },
  validate: (model) => {
    const issues: Issue[] = [];
    const name = str(get(model, 'chart.name'));
    if (!name) {
      issues.push({ level: 'error', message: 'Chart name is required', path: 'chart.name' });
    } else if (!DNS_1123_LABEL.test(name)) {
      issues.push({ level: 'error', message: 'Chart name must be lowercase letters, digits and "-"', path: 'chart.name' });
    }
    const version = str(get(model, 'chart.version'));
    if (!version || !SEMVER.test(version)) {
      issues.push({ level: 'error', message: 'Chart version must be SemVer 2, such as 1.4.0', path: 'chart.version' });
    }
    if (!str(get(model, 'values.image.repository'))) {
      issues.push({ level: 'error', message: 'Image repository is required', path: 'values.image.repository' });
    }
    if (!str(get(model, 'chart.appVersion')) && !str(get(model, 'values.image.tag'))) {
      issues.push({
        level: 'warning',
        message: 'With no appVersion and no image tag, the deployment template renders an image with no tag',
        path: 'chart.appVersion',
      });
    }
    (['requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory'] as const).forEach((key) => {
      issues.push(...checkQuantity(get(model, `values.resources.${key}`), `values.resources.${key}`, key));
    });
    (get(model, 'dependencies') ?? []).forEach((dep: any, index: number) => {
      if (str(dep?.name) && !str(dep?.repository)) {
        issues.push({ level: 'error', message: 'Dependency repository is required', path: `dependencies.${index}.repository` });
      }
    });
    if (get(model, 'features.autoscaling') === true) {
      const min = num(get(model, 'values.autoscaling.minReplicas'));
      const max = num(get(model, 'values.autoscaling.maxReplicas'));
      if (min !== undefined && max !== undefined && min > max) {
        issues.push({ level: 'error', message: 'Min replicas cannot exceed max replicas', path: 'values.autoscaling.minReplicas' });
      }
    }
    return issues;
  },
};
