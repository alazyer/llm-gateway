<template>
  <div class="space-y-6">
    <UButton to="/models" variant="ghost" color="neutral" size="sm" icon="i-lucide-arrow-left" class="inline-flex">
      Back to models
    </UButton>

    <div v-if="loading" class="space-y-4">
      <USkeleton class="h-52 rounded-3xl" />
      <div class="grid gap-4 md:grid-cols-3">
        <USkeleton v-for="i in 3" :key="i" class="h-32 rounded-3xl" />
      </div>
      <USkeleton class="h-96 rounded-3xl" />
    </div>

    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load model"
      :description="error"
    />

    <template v-else-if="model">
      <section class="overflow-hidden rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-8">
        <div class="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <h1 class="wrap-break-word text-3xl font-bold tracking-tight text-slate-950 dark:text-white sm:text-4xl">
              {{ modelName }}
            </h1>
            <p class="mt-3 max-w-3xl text-slate-600 dark:text-slate-300">
              {{ statusDescription }}
            </p>

            <div class="mt-5 flex min-w-0 flex-col gap-2 rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-white/5">
              <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <UIcon name="i-lucide-radio-tower" class="size-4" />
                Upstream endpoint
              </div>
              <code class="break-all text-sm text-slate-800 dark:text-slate-200">{{ displayValue(model.base_url) }}</code>
            </div>
          </div>

          <div class="flex flex-wrap gap-3 lg:justify-end">
            <UButton
              v-if="model.status === 'inactive'"
              color="success"
              size="lg"
              icon="i-lucide-power"
              :loading="actionLoading"
              @click="activate"
            >Activate</UButton>
            <UButton
              v-if="model.status === 'active'"
              color="error"
              variant="subtle"
              size="lg"
              icon="i-lucide-power-off"
              :loading="actionLoading"
              @click="deactivate"
            >Deactivate</UButton>
          </div>
        </div>
      </section>

      <div class="grid gap-4 md:grid-cols-3">
        <UCard v-for="card in summaryCards" :key="card.label" class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-sm text-slate-500 dark:text-slate-400">{{ card.label }}</p>
              <p class="mt-2 wrap-break-word text-2xl font-bold text-slate-950 dark:text-white">{{ card.value }}</p>
              <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">{{ card.caption }}</p>
            </div>
            <div :class="card.iconClass">
              <UIcon :name="card.icon" class="size-5" />
            </div>
          </div>
        </UCard>
      </div>

      <div class="grid gap-6 xl:grid-cols-[0.92fr_1.08fr]">
        <UCard class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
          <template #header>
            <div>
              <h2 class="font-semibold text-slate-950 dark:text-white">Model profile</h2>
              <p class="text-sm text-slate-500 dark:text-slate-400">Read-only runtime details from the admin API.</p>
            </div>
          </template>

          <dl class="space-y-4">
            <div v-for="field in detailFields" :key="field.key" class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/5">
              <dt class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ field.label }}</dt>
              <dd class="mt-2 wrap-break-word text-sm font-medium text-slate-950 dark:text-white">{{ field.value }}</dd>
            </div>
          </dl>
        </UCard>

        <UCard class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
          <template #header>
            <div class="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 class="font-semibold text-slate-950 dark:text-white">Edit routing metadata</h2>
                <p class="text-sm text-slate-500 dark:text-slate-400">Update model identity, capabilities, and validation behavior.</p>
              </div>
              <template v-if="saved">
                Saved
              </template>
            </div>
          </template>

          <UForm :state="editForm" class="grid gap-4 sm:grid-cols-2" @submit="onUpdate">
            <UFormField label="Upstream Model" name="upstream_model">
              <UInput v-model="editForm.upstream_model" icon="i-lucide-cpu" />
            </UFormField>

            <UFormField label="Owned By" name="owned_by">
              <UInput v-model="editForm.owned_by" icon="i-lucide-building-2" />
            </UFormField>

            <UFormField label="Base URL" name="base_url" class="sm:col-span-2">
              <UInput v-model="editForm.base_url" icon="i-lucide-link" />
            </UFormField>

            <UFormField label="API Key Env Var" name="api_key_env">
              <UInput v-model="editForm.api_key_env" icon="i-lucide-key-round" />
            </UFormField>

            <UFormField label="Unknown Field Mode" name="unknown_field_mode">
              <USelect v-model="editForm.unknown_field_mode" :items="['warn', 'enforce']" />
            </UFormField>

            <UFormField label="Unknown Field Window Requests" name="unknown_field_window_requests">
              <UInput v-model.number="editForm.unknown_field_window_requests" type="number" />
            </UFormField>

            <div class="grid gap-4 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/5 sm:col-span-2 sm:grid-cols-2">
              <UFormField label="Supports Tools" name="supports_tools">
                <USwitch v-model="editForm.supports_tools" />
              </UFormField>
              <UFormField label="Supports Streaming" name="supports_streaming">
                <USwitch v-model="editForm.supports_streaming" />
              </UFormField>
              <UFormField label="Input Modalities" name="input_modalities" hint="text is always included">
                <USelectMenu
                  v-model="editForm.input_modalities"
                  multiple
                  :items="inputModalityOptions"
                  value-key="value"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="Output Modalities" name="output_modalities" hint="text is always included">
                <USelectMenu
                  v-model="editForm.output_modalities"
                  multiple
                  :items="outputModalityOptions"
                  value-key="value"
                  class="w-full"
                />
              </UFormField>
            </div>

            <UAlert
              v-if="saveError"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :description="saveError"
              class="sm:col-span-2"
            />

            <div class="flex items-center gap-3 sm:col-span-2">
              <UButton type="submit" icon="i-lucide-save" :loading="saving">Save changes</UButton>
              <UButton type="button" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" :disabled="saving" @click="resetForm">
                Reset
              </UButton>
            </div>
          </UForm>
        </UCard>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const route = useRoute();
const api = useGatewayApi();
const modelName = route.params.name as string;

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const actionLoading = ref(false);
const error = ref("");
const saveError = ref("");
const model = ref<Record<string, unknown> | null>(null);

const editForm = reactive({
  upstream_model: "",
  base_url: "",
  api_key_env: "",
  owned_by: "",
  supports_tools: true,
  supports_streaming: true,
  input_modalities: ["text"] as string[],
  output_modalities: ["text"] as string[],
  unknown_field_mode: "warn" as string,
  unknown_field_window_requests: 100,
});

const inputModalityOptions = [
  { label: "Text", value: "text" },
  { label: "Image", value: "image" },
  { label: "Audio", value: "audio" },
  { label: "Video", value: "video" },
];

const outputModalityOptions = [
  { label: "Text", value: "text" },
  { label: "Image", value: "image" },
];

const statusDescription = computed(() => {
  if (!model.value) return "";
  const status = String(model.value.status ?? "unknown");
  const reason = displayValue(model.value.status_reason, "No status reason provided.");
  return status === "active"
    ? `This model is active and available for routing. ${reason}`
    : `This model is currently inactive and will not be selected for routing. ${reason}`;
});

const summaryCards = computed(() => {
  if (!model.value) return [];
  return [
    {
      label: "Upstream model",
      value: displayValue(model.value.upstream_model),
      caption: "Provider-facing model identifier",
      icon: "i-lucide-cpu",
      iconClass: "rounded-2xl bg-blue-500/10 p-3 text-blue-500",
    },
    {
      label: "Capabilities",
      value: capabilitySummary.value,
      caption: "Tool and streaming support",
      icon: "i-lucide-sparkles",
      iconClass: "rounded-2xl bg-teal-500/10 p-3 text-teal-500",
    },
    {
      label: "Updated",
      value: formatTimestamp(model.value.updated_at as number | null),
      caption: "Last persisted metadata change",
      icon: "i-lucide-clock-3",
      iconClass: "rounded-2xl bg-indigo-500/10 p-3 text-indigo-500",
    },
  ];
});

const capabilitySummary = computed(() => {
  if (!model.value) return "—";
  const capabilities = [
    model.value.supports_tools ? "Tools" : null,
    model.value.supports_streaming ? "Streaming" : null,
    Array.isArray(model.value.input_modalities) && model.value.input_modalities.length > 1
      ? `${model.value.input_modalities.filter((m: string) => m !== "text").join("/")} in`
      : null,
    Array.isArray(model.value.output_modalities) && model.value.output_modalities.length > 1
      ? `${model.value.output_modalities.filter((m: string) => m !== "text").join("/")} out`
      : null,
  ].filter(Boolean);
  return capabilities.length ? capabilities.join(" + ") : "Basic completion";
});

const detailFields = computed(() => {
  if (!model.value) return [];
  const m = model.value;
  return [
    { key: "upstream_model", label: "Upstream Model", value: m.upstream_model },
    { key: "base_url", label: "Base URL", value: m.base_url },
    { key: "api_key_env", label: "API Key Env", value: m.api_key_env },
    { key: "owned_by", label: "Owned By", value: m.owned_by },
    { key: "status_reason", label: "Status Reason", value: m.status_reason ?? "—" },
    { key: "source", label: "Source", value: m.source ?? "—" },
    { key: "supports_tools", label: "Tools", value: m.supports_tools ? "Yes" : "No" },
    { key: "supports_streaming", label: "Streaming", value: m.supports_streaming ? "Yes" : "No" },
    { key: "input_modalities", label: "Input Modalities", value: Array.isArray(m.input_modalities) ? m.input_modalities.join(", ") : "—" },
    { key: "output_modalities", label: "Output Modalities", value: Array.isArray(m.output_modalities) ? m.output_modalities.join(", ") : "—" },
    { key: "unknown_field_mode", label: "Unknown Field Mode", value: m.unknown_field_mode },
    { key: "updated_at", label: "Last Updated", value: formatTimestamp(m.updated_at as number | null) },
  ];
});

function formatTimestamp(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function displayValue(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function populateForm(source: Record<string, unknown>) {
  editForm.upstream_model = String(source.upstream_model ?? "");
  editForm.base_url = String(source.base_url ?? "");
  editForm.api_key_env = String(source.api_key_env ?? "");
  editForm.owned_by = String(source.owned_by ?? "");
  editForm.supports_tools = !!source.supports_tools;
  editForm.supports_streaming = !!source.supports_streaming;
  editForm.input_modalities = Array.isArray(source.input_modalities) && source.input_modalities.length > 0
    ? [...source.input_modalities].map(String)
    : ["text"];
  editForm.output_modalities = Array.isArray(source.output_modalities) && source.output_modalities.length > 0
    ? [...source.output_modalities].map(String)
    : ["text"];
  editForm.unknown_field_mode = String(source.unknown_field_mode ?? "warn");
  editForm.unknown_field_window_requests = Number(source.unknown_field_window_requests ?? 100);
}

function resetForm() {
  if (model.value) populateForm(model.value);
  saveError.value = "";
  saved.value = false;
}

async function loadModel() {
  loading.value = true;
  error.value = "";
  try {
    const res = await api.getModel(modelName);
    model.value = res.model as Record<string, unknown>;
    populateForm(res.model as Record<string, unknown>);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Unexpected error while loading model.";
  } finally {
    loading.value = false;
  }
}

async function activate() {
  actionLoading.value = true;
  try {
    await api.activateModel(modelName);
    await loadModel();
  } finally {
    actionLoading.value = false;
  }
}

async function deactivate() {
  actionLoading.value = true;
  try {
    await api.deactivateModel(modelName);
    await loadModel();
  } finally {
    actionLoading.value = false;
  }
}

async function onUpdate() {
  saving.value = true;
  saved.value = false;
  saveError.value = "";
  try {
    await api.updateModel(modelName, editForm);
    await loadModel();
    saved.value = true;
    setTimeout(() => { saved.value = false; }, 3000);
  } catch (e: unknown) {
    saveError.value = e instanceof Error ? e.message : "Unexpected error while saving model.";
  } finally {
    saving.value = false;
  }
}

onMounted(() => loadModel());
</script>
