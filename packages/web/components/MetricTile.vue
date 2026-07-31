<template>
  <div :class="tileClass">
    <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ label }}</p>
    <p :class="valueClass">{{ value }}</p>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  label: string;
  value: string | number;
  tone?: "neutral" | "success" | "warning" | "error";
}>(), {
  tone: "neutral",
});

const toneClasses: Record<NonNullable<typeof props.tone>, string> = {
  neutral: "bg-slate-100/80 text-slate-950 ring-slate-200 dark:bg-white/5 dark:text-white dark:ring-white/10",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20",
  warning: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  error: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20",
};

const tileClass = computed(() => [
  "rounded-2xl p-4 ring-1",
  toneClasses[props.tone],
].join(" "));

const valueClass = computed(() => [
  "mt-2 text-2xl font-bold tabular-nums",
  props.tone === "neutral" ? "text-slate-950 dark:text-white" : "",
].join(" "));
</script>
