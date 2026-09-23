{{/*
Expand the name of the chart.
*/}}
{{- define "rocketride.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "rocketride.fullname" -}}
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

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "rocketride.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "rocketride.labels" -}}
helm.sh/chart: {{ include "rocketride.chart" . }}
{{ include "rocketride.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "rocketride.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rocketride.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "rocketride.serviceAccountName" -}}
{{- if .Values.engine.serviceAccount.create }}
{{- default (include "rocketride.fullname" .) .Values.engine.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.engine.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Return the secret name for engine credentials
*/}}
{{- define "rocketride.secretName" -}}
{{- if .Values.engine.existingSecret }}
{{- .Values.engine.existingSecret }}
{{- else }}
{{- include "rocketride.fullname" . }}
{{- end }}
{{- end }}

{{/*
Validate that engine secrets are configured.
Users must provide credentials via engine.existingSecret or engine.secrets.
This prevents deploying with missing API keys.
*/}}
{{- define "rocketride.validateSecrets" -}}
{{- if and (not .Values.engine.existingSecret) (not .Values.engine.secrets) }}
{{- fail "Engine secrets must be configured. Set engine.secrets with your API keys or provide engine.existingSecret referencing a pre-created Kubernetes Secret." }}
{{- end }}
{{- end }}

{{/*
True when the release can ever run more than one engine pod.
Autoscaling wins over replicaCount because the Deployment omits `replicas`
entirely when the HPA is enabled.
*/}}
{{- define "rocketride.engine.canScaleOut" -}}
{{- if .Values.engine.autoscaling.enabled }}
{{- if gt (int .Values.engine.autoscaling.maxReplicas) 1 }}true{{ end }}
{{- else if gt (int .Values.engine.replicaCount) 1 }}true{{ end }}
{{- end }}

{{/*
Validate that a scale-out release points the engine at a SHARED file store.

The engine is not stateless. With RR_STORE_URL unset it keeps account files on
local disk (Store._get_default_storage_url -> filesystem://~/.rocketlib/dtc),
so every pod gets its own private copy: a file written through one pod is
absent when the next request lands on another. On that same backend the engine
also mints a per-process RR_SIGNING_KEY (ai/web/server.py::_ensure_signing_key),
so signed /task/fetch URLs issued by one pod 401 on every other.

Both halves are fixed by one thing — a shared object store. s3:// and
azureblob:// are shared by construction and presign natively, so no signing key
is involved at all.

The chart cannot read the contents of engine.existingSecret, so
engine.sharedStoreConfigured is the escape hatch for operators who inject
RR_STORE_URL from outside the chart's view.
*/}}
{{- define "rocketride.validateScaleOut" -}}
{{- if include "rocketride.engine.canScaleOut" . }}
{{- if not .Values.engine.sharedStoreConfigured }}
{{- $env := .Values.engine.env | default dict }}
{{- $storeUrl := "" }}
{{- if hasKey $env "RR_STORE_URL" }}{{- $storeUrl = printf "%v" (index $env "RR_STORE_URL") }}{{- end }}
{{- if not (or (hasPrefix "s3://" $storeUrl) (hasPrefix "azureblob://" $storeUrl) (hasPrefix "azure://" $storeUrl)) }}
{{- fail (printf "Engine is configured to run more than one replica, but no shared file store is set. Each pod would keep its own private copy of the account file store (RR_STORE_URL defaults to a container-local filesystem path), so uploads and run artifacts would appear and disappear depending on which pod answered, and signed download URLs issued by one pod would 401 on the others. Set engine.env.RR_STORE_URL to a shared backend (s3://bucket/prefix, azureblob://container/prefix, or the azure:// alias) with credentials in engine.secrets.RR_STORE_SECRET_KEY, or run engine.replicaCount=1 with autoscaling disabled. If RR_STORE_URL is injected outside this chart (e.g. via engine.existingSecret), set engine.sharedStoreConfigured=true to acknowledge it. Current RR_STORE_URL: %q" $storeUrl) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Return the engine image reference
*/}}
{{- define "rocketride.engine.image" -}}
{{- $tag := default .Chart.AppVersion .Values.engine.image.tag }}
{{- printf "%s:%s" .Values.engine.image.repository $tag }}
{{- end }}
