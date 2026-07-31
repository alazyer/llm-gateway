<template>
  <div class="space-y-8">
    <section class="overflow-hidden rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-8">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-slate-950 dark:text-white sm:text-4xl">Gateway Status</h1>
          <p class="mt-3 max-w-2xl text-slate-600 dark:text-slate-300">
            Monitor model availability, chain resilience, and the default routing posture from one place.
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <UButton to="/models" icon="i-lucide-boxes" color="neutral" variant="subtle">Manage models</UButton>
          <UButton to="/chains" icon="i-lucide-route" color="primary">Review chains</UButton>
        </div>
      </div>
    </section>

    <div v-if="loading" class="grid gap-4 md:grid-cols-3">
      <USkeleton v-for="i in 3" :key="i" class="h-36 rounded-3xl" />
    </div>

    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load gateway status"
      :description="error"
    />

    <template v-else-if="status">
      <div class="grid gap-4 md:grid-cols-3">
        <UCard v-for="card in summaryCards" :key="card.label" class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-sm text-slate-500 dark:text-slate-400">{{ card.label }}</p>
              <p class="mt-2 text-3xl font-bold text-slate-950 dark:text-white">{{ card.value }}</p>
              <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">{{ card.caption }}</p>
            </div>
            <div :class="card.iconClass">
              <UIcon :name="card.icon" class="size-5" />
            </div>
          </div>
        </UCard>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <UCard class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
          <template #header>
            <div class="flex items-center justify-between">
              <div>
                <h2 class="font-semibold text-slate-950 dark:text-white">Model fleet</h2>
                <p class="text-sm text-slate-500 dark:text-slate-400">Configured upstream model health.</p>
              </div>
              <UButton to="/models" variant="ghost" size="sm" trailing-icon="i-lucide-arrow-right">View all</UButton>
            </div>
          </template>
          <div class="grid grid-cols-3 gap-3">
            <MetricTile label="Total" :value="status.models.total" />
            <MetricTile label="Active" :value="status.models.active" tone="success" />
            <MetricTile label="Inactive" :value="status.models.inactive" tone="error" />
          </div>
        </UCard>

        <UCard class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
          <template #header>
            <div class="flex items-center justify-between">
              <div>
                <h2 class="font-semibold text-slate-950 dark:text-white">Fallback chains</h2>
                <p class="text-sm text-slate-500 dark:text-slate-400">Routing resilience across ordered model chains.</p>
              </div>
              <UButton to="/chains" variant="ghost" size="sm" trailing-icon="i-lucide-arrow-right">View all</UButton>
            </div>
          </template>
          <div class="grid grid-cols-4 gap-3">
            <MetricTile label="Total" :value="status.chains.total" />
            <MetricTile label="Active" :value="status.chains.active" tone="success" />
            <MetricTile label="Degraded" :value="status.chains.degraded" tone="warning" />
            <MetricTile label="Inactive" :value="status.chains.inactive" tone="error" />
          </div>
        </UCard>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const api = useGatewayApi();
const loading = ref(true);
const error = ref("");

const status = ref<{
  status: string;
  models: { total: number; active: number; inactive: number };
  chains: { total: number; active: number; degraded: number; inactive: number };
  default_model: string | null;
  uptime_seconds: number;
} | null>(null);

const summaryCards = computed(() => {
  if (!status.value) return [];
  return [
    {
      label: "Uptime",
      value: formatUptime(status.value.uptime_seconds),
      caption: "Current gateway process",
      icon: "i-lucide-timer",
      iconClass: "rounded-2xl bg-blue-500/10 p-3 text-blue-500",
    },
    {
      label: "Default model",
      value: status.value.default_model || "Not set",
      caption: "Primary route target",
      icon: "i-lucide-badge-check",
      iconClass: "rounded-2xl bg-teal-500/10 p-3 text-teal-500",
    },
    {
      label: "Availability",
      value: status.value.status === "ok" ? "Healthy" : "Attention",
      caption: `${status.value.models.active} active models · ${status.value.chains.active} active chains`,
      icon: status.value.status === "ok" ? "i-lucide-heart-pulse" : "i-lucide-triangle-alert",
      iconClass: status.value.status === "ok"
        ? "rounded-2xl bg-emerald-500/10 p-3 text-emerald-500"
        : "rounded-2xl bg-amber-500/10 p-3 text-amber-500",
    },
  ];
});

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hrs}h ${mins}m`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

onMounted(async () => {
  try {
    status.value = await api.getStatus();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Unexpected error while loading status.";
  } finally {
    loading.value = false;
  }
});
</script>
