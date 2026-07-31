<template>
  <div class="space-y-6">
    <section class="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <h1 class="text-3xl font-bold tracking-tight text-slate-950 dark:text-white">Settings</h1>
      <p class="mt-2 max-w-2xl text-slate-600 dark:text-slate-300">
        Tune request limits, CORS, default routing, and Copilot proxy behavior from the SQLite-backed admin config.
      </p>
    </section>

    <USkeleton v-if="loading" class="h-96 rounded-3xl" />

    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load gateway configuration"
      :description="error"
    />

    <UCard v-else-if="config" class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
      <template #header>
        <div class="flex flex-col gap-1">
          <h2 class="font-semibold text-slate-950 dark:text-white">Gateway configuration</h2>
          <p class="text-sm text-slate-500 dark:text-slate-400">Changes are persisted through the admin database API.</p>
        </div>
      </template>

      <UForm :state="editForm" class="grid gap-4 lg:grid-cols-2" @submit="onSave">
        <UFormField label="Default Model" name="default_model">
          <UInput v-model="editForm.default_model" placeholder="e.g. glm-5" />
        </UFormField>

        <UFormField label="Request Timeout (ms)" name="request_timeout_ms">
          <UInput v-model.number="editForm.request_timeout_ms" type="number" />
        </UFormField>

        <UFormField label="Max Retries" name="max_retries">
          <UInput v-model.number="editForm.max_retries" type="number" />
        </UFormField>

        <UFormField label="Max Body Size (KB)" name="max_body_size_kb">
          <UInput v-model.number="editForm.max_body_size_kb" type="number" />
        </UFormField>

        <UFormField label="Health Probe Enabled" name="health_probe_enabled">
          <USwitch v-model="editForm.health_probe_enabled" />
        </UFormField>

        <UFormField label="CORS Origin" name="cors_origin">
          <UInput v-model="editForm.cors_origin" placeholder="e.g. http://localhost:3000 or * for any" />
        </UFormField>

        <UFormField label="Copilot Proxy Enabled" name="copilot_proxy_enabled">
          <USwitch v-model="editForm.copilot_proxy_enabled" />
        </UFormField>

        <UFormField label="Copilot Proxy Require Token Auth" name="copilot_proxy_require_token_auth">
          <USwitch v-model="editForm.copilot_proxy_require_token_auth" />
        </UFormField>

        <UFormField label="Copilot Proxy Token TTL (seconds)" name="copilot_proxy_token_ttl_seconds">
          <UInput v-model.number="editForm.copilot_proxy_token_ttl_seconds" type="number" />
        </UFormField>

        <UFormField label="Copilot Proxy Heartbeat Interval (ms)" name="copilot_proxy_heartbeat_interval_ms">
          <UInput v-model.number="editForm.copilot_proxy_heartbeat_interval_ms" type="number" />
        </UFormField>

        <UFormField label="Copilot Proxy Heartbeat Timeout (ms)" name="copilot_proxy_heartbeat_timeout_ms">
          <UInput v-model.number="editForm.copilot_proxy_heartbeat_timeout_ms" type="number" />
        </UFormField>

        <UFormField label="Copilot Proxy Max Inflight Per Connection" name="copilot_proxy_max_inflight_per_connection">
          <UInput v-model.number="editForm.copilot_proxy_max_inflight_per_connection" type="number" />
        </UFormField>

        <UFormField label="Copilot Proxy Allowed Prefixes (comma-separated)" name="copilot_proxy_allowed_prefixes" class="lg:col-span-2">
          <UInput v-model="editForm.copilot_proxy_allowed_prefixes" placeholder="copilot-" />
        </UFormField>

        <div class="flex items-center gap-3 lg:col-span-2">
          <UButton type="submit" icon="i-lucide-save" :loading="saving">Save configuration</UButton>
          <template v-if="saved">
            Saved
          </template>
        </div>
      </UForm>
    </UCard>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const api = useGatewayApi();

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref("");
const config = ref<Record<string, unknown> | null>(null);

const editForm = reactive({
  default_model: "",
  request_timeout_ms: 30000,
  max_retries: 0,
  max_body_size_kb: 1024,
  health_probe_enabled: false,
  cors_origin: "",
  copilot_proxy_enabled: false,
  copilot_proxy_require_token_auth: true,
  copilot_proxy_token_ttl_seconds: 86400,
  copilot_proxy_heartbeat_interval_ms: 30000,
  copilot_proxy_heartbeat_timeout_ms: 10000,
  copilot_proxy_max_inflight_per_connection: 4,
  copilot_proxy_allowed_prefixes: "copilot-",
});

async function loadConfig() {
  loading.value = true;
  error.value = "";
  try {
    const res = await api.getDatabase();
    config.value = res.gateway_config as Record<string, unknown>;
    // Populate form from response
    editForm.default_model = String(res.gateway_config.default_model ?? "");
    editForm.request_timeout_ms = Number(res.gateway_config.request_timeout_ms ?? 30000);
    editForm.max_retries = Number(res.gateway_config.max_retries ?? 0);
    editForm.max_body_size_kb = Number(res.gateway_config.max_body_size_kb ?? 1024);
    editForm.health_probe_enabled = !!res.gateway_config.health_probe_enabled;
    editForm.cors_origin = String(res.gateway_config.cors_origin ?? "");
    editForm.copilot_proxy_enabled = !!res.gateway_config.copilot_proxy_enabled;
    editForm.copilot_proxy_require_token_auth = !!res.gateway_config.copilot_proxy_require_token_auth;
    editForm.copilot_proxy_token_ttl_seconds = Number(res.gateway_config.copilot_proxy_token_ttl_seconds ?? 86400);
    editForm.copilot_proxy_heartbeat_interval_ms = Number(res.gateway_config.copilot_proxy_heartbeat_interval_ms ?? 30000);
    editForm.copilot_proxy_heartbeat_timeout_ms = Number(res.gateway_config.copilot_proxy_heartbeat_timeout_ms ?? 10000);
    editForm.copilot_proxy_max_inflight_per_connection = Number(res.gateway_config.copilot_proxy_max_inflight_per_connection ?? 4);
    editForm.copilot_proxy_allowed_prefixes = String(res.gateway_config.copilot_proxy_allowed_prefixes ?? "copilot-");
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Unexpected error while loading gateway configuration.";
  } finally {
    loading.value = false;
  }
}

async function onSave() {
  saving.value = true;
  saved.value = false;
  try {
    const payload: Record<string, unknown> = {
      default_model: editForm.default_model || null,
      request_timeout_ms: editForm.request_timeout_ms,
      max_retries: editForm.max_retries,
      max_body_size_kb: editForm.max_body_size_kb,
      health_probe_enabled: editForm.health_probe_enabled,
      cors_origin: editForm.cors_origin || null,
      copilot_proxy_enabled: editForm.copilot_proxy_enabled,
      copilot_proxy_require_token_auth: editForm.copilot_proxy_require_token_auth,
      copilot_proxy_token_ttl_seconds: editForm.copilot_proxy_token_ttl_seconds,
      copilot_proxy_heartbeat_interval_ms: editForm.copilot_proxy_heartbeat_interval_ms,
      copilot_proxy_heartbeat_timeout_ms: editForm.copilot_proxy_heartbeat_timeout_ms,
      copilot_proxy_max_inflight_per_connection: editForm.copilot_proxy_max_inflight_per_connection,
      copilot_proxy_allowed_prefixes: editForm.copilot_proxy_allowed_prefixes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    await api.patchGatewayConfig(payload);
    saved.value = true;
    setTimeout(() => { saved.value = false; }, 3000);
  } finally {
    saving.value = false;
  }
}

onMounted(() => loadConfig());
</script>
