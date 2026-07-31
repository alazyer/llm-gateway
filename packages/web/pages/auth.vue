<template>
  <div class="dashboard-surface relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
    <div class="absolute left-1/2 top-0 size-144 -translate-x-1/2 rounded-full bg-teal-400/20 blur-3xl dark:bg-teal-500/10" />

    <div class="relative grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
      <section class="hidden lg:block">
        <h1 class="max-w-xl text-5xl font-bold tracking-tight text-slate-950 dark:text-white">
          Control your model fleet from one calm cockpit.
        </h1>
        <p class="mt-5 max-w-lg text-lg text-slate-600 dark:text-slate-300">
          Monitor health, activate upstreams, manage fallback chains, and keep the Copilot proxy visible without spelunking through YAML.
        </p>
        <div class="mt-8 grid max-w-xl grid-cols-3 gap-3">
          <div v-for="item in highlights" :key="item.label" class="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
            <UIcon :name="item.icon" class="mb-3 size-5 text-teal-500" />
            <p class="text-sm font-semibold text-slate-900 dark:text-white">{{ item.label }}</p>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ item.copy }}</p>
          </div>
        </div>
      </section>

      <UCard class="w-full border-white/70 bg-white/85 shadow-2xl shadow-slate-950/10 backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/75">
        <div class="mb-8 flex items-center gap-3">
          <div class="flex size-12 items-center justify-center rounded-2xl bg-linear-to-br from-teal-400 to-indigo-500 text-white shadow-lg shadow-teal-500/20">
            <UIcon name="i-lucide-brain-circuit" class="size-6" />
          </div>
          <div>
            <h2 class="text-xl font-bold text-slate-950 dark:text-white">Welcome back</h2>
            <p class="text-sm text-slate-500 dark:text-slate-400">Enter your gateway admin token.</p>
          </div>
        </div>

        <UForm :state="state" class="space-y-5" @submit="onSubmit">
          <input
            class="sr-only"
            type="text"
            name="username"
            autocomplete="username"
            value="llm-gateway-admin"
            tabindex="-1"
            aria-hidden="true"
          >

          <UFormField label="Auth token" name="token">
            <UInput
              v-model="state.token"
              icon="i-lucide-key-round"
              type="password"
              size="xl"
              placeholder="Paste gateway auth token"
              autocomplete="current-password"
            />
          </UFormField>

          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :description="error"
          />

          <UButton type="submit" size="xl" block icon="i-lucide-log-in" :loading="loading">
            Connect to dashboard
          </UButton>
        </UForm>

        <p class="mt-6 text-center text-xs text-slate-500 dark:text-slate-400">
          Token is stored locally in this browser and sent as a bearer token.
        </p>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
const highlights = [
  { label: "Health", copy: "Live status at a glance", icon: "i-lucide-activity" },
  { label: "Models", copy: "Activate and retire safely", icon: "i-lucide-boxes" },
  { label: "Chains", copy: "Tune fallback routing", icon: "i-lucide-route" },
];

const state = reactive({ token: "" });
const loading = ref(false);
const error = ref("");

const api = useGatewayApi();

async function onSubmit() {
  if (!state.token.trim()) {
    error.value = "Token is required.";
    return;
  }
  loading.value = true;
  error.value = "";

  try {
    api.setToken(state.token.trim());
    // Verify token by calling a lightweight endpoint
    await api.getStatus();
    navigateTo("/");
  } catch (e: unknown) {
    api.clearToken();
    error.value =
      e instanceof Error ? e.message : "Authentication failed. Check your token.";
  } finally {
    loading.value = false;
  }
}

// If already authenticated, skip auth page
onMounted(() => {
  if (api.getToken()) {
    navigateTo("/");
  }
});
</script>
