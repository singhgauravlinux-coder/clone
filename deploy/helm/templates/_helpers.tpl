{{- define "workbench.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "workbench.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "workbench.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "workbench.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "workbench.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "workbench.selectorLabels" -}}
app.kubernetes.io/name: {{ include "workbench.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "workbench.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ include "workbench.fullname" . }}{{ else }}default{{ end }}
{{- end }}

{{/* Env shared by the server and the migration job. */}}
{{- define "workbench.env" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret }}
      key: {{ .Values.database.urlKey }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.redis.existingSecret }}
      key: {{ .Values.redis.urlKey }}
- name: JWT_SIGNING_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.auth.existingSecret }}
      key: {{ .Values.auth.signingKeyKey }}
- name: ACCESS_TOKEN_TTL
  value: {{ .Values.auth.accessTokenTTL | quote }}
- name: REFRESH_TOKEN_TTL
  value: {{ .Values.auth.refreshTokenTTL | quote }}
{{- end }}
