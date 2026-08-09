<template>
  <UApp>
    <NuxtPage v-if="isAuthPage" />

    <div v-else class="dashboard-surface min-h-screen text-slate-950 dark:text-white">
      <header class="sticky top-0 z-40 border-b border-white/60 bg-white/75 shadow-sm shadow-slate-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/70">
        <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <NuxtLink to="/" class="group flex items-center gap-3">
            <div class="flex size-10 items-center justify-center rounded-2xl bg-linear-to-br from-teal-400 to-indigo-500 text-white shadow-lg shadow-teal-500/20 transition group-hover:scale-105">
              <UIcon name="i-lucide-brain-circuit" class="size-5" />
            </div>
            <div>
              <p class="text-sm font-semibold uppercase tracking-[0.22em] text-teal-600 dark:text-teal-300">LLM Gateway</p>
              <p class="text-xs text-slate-500 dark:text-slate-400">Admin console</p>
            </div>
          </NuxtLink>

          <nav class="hidden items-center gap-1 rounded-full border border-slate-200/80 bg-white/70 p-1 shadow-sm dark:border-white/10 dark:bg-white/5 md:flex">
            <NuxtLink
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              :class="navLinkClass(item.to)"
            >
              <UIcon :name="item.icon" class="size-4" />
              {{ item.label }}
            </NuxtLink>
          </nav>

          <div class="flex items-center gap-2">
            <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" size="sm" @click="logout">
              <span class="hidden sm:inline">Logout</span>
            </UButton>
          </div>
        </div>

        <nav class="flex gap-2 overflow-x-auto px-4 pb-3 md:hidden">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            :class="mobileNavLinkClass(item.to)"
          >
            <UIcon :name="item.icon" class="size-4" />
            {{ item.label }}
          </NuxtLink>
        </nav>
      </header>

      <main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <NuxtPage />
      </main>
    </div>
  </UApp>
</template>

<script setup lang="ts">
const route = useRoute();
const api = useGatewayApi();

const isAuthPage = computed(() => route.path === "/auth");

const navItems = [
  { label: "Status", to: "/", icon: "i-lucide-activity" },
  { label: "Chat", to: "/chat", icon: "i-lucide-messages-square" },
  { label: "Models", to: "/models", icon: "i-lucide-boxes" },
  { label: "Chains", to: "/chains", icon: "i-lucide-route" },
  { label: "Settings", to: "/settings", icon: "i-lucide-sliders-horizontal" },
];

function isActive(path: string): boolean {
  return path === "/" ? route.path === "/" : route.path.startsWith(path);
}

function navLinkClass(path: string): string {
  return [
    "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition",
    isActive(path)
      ? "bg-slate-950 text-white shadow-sm dark:bg-white dark:text-slate-950"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white",
  ].join(" ");
}

function mobileNavLinkClass(path: string): string {
  return [
    "inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition",
    isActive(path)
      ? "bg-slate-950 text-white dark:bg-white dark:text-slate-950"
      : "bg-white/70 text-slate-600 ring-1 ring-slate-200/80 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10",
  ].join(" ");
}

function logout() {
  api.clearToken();
  navigateTo("/auth");
}
</script>
