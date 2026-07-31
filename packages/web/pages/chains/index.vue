<template>
  <div class="space-y-6">
    <section class="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-slate-950 dark:text-white">Chains</h1>
          <p class="mt-2 max-w-2xl text-slate-600 dark:text-slate-300">
            Compose ordered model fallbacks and monitor resilience across the chain.
          </p>
        </div>
        <UButton icon="i-lucide-plus" size="lg" @click="showCreate = true">Add Chain</UButton>
      </div>
    </section>

    <UCard class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="font-semibold text-slate-950 dark:text-white">Configured chains</h2>
          <p class="text-sm text-slate-500 dark:text-slate-400">Filter by health and click a row to tune membership.</p>
        </div>
        <div class="flex gap-2">
          <USelect
            v-model="filterStatus"
            placeholder="All statuses"
            :items="['active', 'degraded', 'inactive']"
            class="w-44"
            @change="loadChains"
          />
          <UButton variant="ghost" size="sm" icon="i-lucide-x" v-if="filterStatus" @click="clearFilters">
            Clear
          </UButton>
        </div>
      </div>

      <div v-if="loading" class="space-y-3">
        <USkeleton v-for="i in 5" :key="i" class="h-12 rounded-xl" />
      </div>

      <UAlert
        v-else-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Could not load chains"
        :description="error"
      />

      <UAlert
        v-else-if="chains.length === 0"
        color="neutral"
        variant="subtle"
        icon="i-lucide-inbox"
        title="No chains found"
        description="Create a chain or adjust the filters to see configured routing fallbacks."
      />

      <UTable v-else :data="chains" :columns="columns" :on-select="onSelect">
        <template #status-cell="{ row }">
          {{ row.original.status }}
        </template>
        <template #models-cell="{ row }">
          <span class="font-medium tabular-nums">{{ row.original.active_models }} / {{ row.original.total_models }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :aria-label="`Delete ${row.original.name}`"
              @click.stop="confirmDelete(row.original.name)"
            />
          </div>
        </template>
      </UTable>
    </UCard>

    <!-- Create chain modal -->
    <UModal v-if="showCreate" v-model:open="showCreate" unmount-on-hide>
      <template #content>
        <UCard>
          <template #header>
            <h2 class="font-semibold">Add Chain</h2>
          </template>
          <UForm :state="createForm" @submit="onCreate">
            <UFormField label="Name" name="name" required>
              <UInput v-model="createForm.name" />
            </UFormField>
            <UFormField label="Timeout (ms)" name="timeout_ms" class="mt-3">
              <UInput v-model.number="createForm.timeout_ms" type="number" />
            </UFormField>
            <UFormField label="Max Retries" name="max_retries" class="mt-3">
              <UInput v-model.number="createForm.max_retries" type="number" />
            </UFormField>
            <UFormField label="Models" name="models" required class="mt-3">
              <p class="text-xs text-gray-500 mb-1">Enter model names, one per line. Drag rows in chain detail to reorder.</p>
              <UTextarea v-model="createModelsText" :rows="4" placeholder="glm-5&#10;deepseek-v4" />
            </UFormField>
            <div class="mt-4 flex justify-end gap-2">
              <UButton type="button" variant="ghost" @click="showCreate = false">Cancel</UButton>
              <UButton type="submit" :loading="creating">Create</UButton>
            </div>
          </UForm>
        </UCard>
      </template>
    </UModal>

    <!-- Delete confirmation modal -->
    <UModal v-if="showDelete" v-model:open="showDelete" unmount-on-hide>
      <template #content>
        <UCard>
          <template #header>
            <h2 class="font-semibold">Delete Chain</h2>
          </template>
          <p>Are you sure you want to delete chain <strong>{{ deleteTarget }}</strong>?</p>
          <div class="mt-4 flex justify-end gap-2">
            <UButton type="button" variant="ghost" @click="showDelete = false">Cancel</UButton>
            <UButton type="button" color="error" :loading="deleting" @click="onDelete">Delete</UButton>
          </div>
        </UCard>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const api = useGatewayApi();

const loading = ref(true);
const error = ref("");
const chains = ref<Array<{
  name: string;
  status: string;
  status_reason: string | null;
  active_models: number;
  total_models: number;
  timeout_ms: number;
  max_retries: number;
  chain_timeout_ms: number | null;
}>>([]);

const filterStatus = ref("");

const columns = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "status", header: "Status" },
  { id: "models", header: "Models" },
  { accessorKey: "timeout_ms", header: "Timeout" },
  { id: "actions", header: "" },
];

// Create form
const showCreate = ref(false);
const creating = ref(false);
const createForm = reactive({
  name: "",
  timeout_ms: 30000,
  max_retries: 0,
});
const createModelsText = ref("");

// Delete confirmation
const showDelete = ref(false);
const deleteTarget = ref("");
const deleting = ref(false);

async function loadChains() {
  loading.value = true;
  error.value = "";
  try {
    const filters: { status?: string } = {};
    if (filterStatus.value) filters.status = filterStatus.value;
    const res = await api.listChains(filters);
    chains.value = res.chains;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Unexpected error while loading chains.";
  } finally {
    loading.value = false;
  }
}

function clearFilters() {
  filterStatus.value = "";
  loadChains();
}

function onSelect(_event: Event, row: { original: { name: string } }) {
  navigateTo(`/chains/${row.original.name}`);
}

function confirmDelete(name: string) {
  deleteTarget.value = name;
  showDelete.value = true;
}

async function onDelete() {
  deleting.value = true;
  try {
    await api.deleteChain(deleteTarget.value);
    showDelete.value = false;
    await loadChains();
  } finally {
    deleting.value = false;
  }
}

async function onCreate() {
  creating.value = true;
  try {
    const models = createModelsText.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => ({ model_name: name }));

    if (models.length === 0) {
      alert("At least one model is required.");
      return;
    }

    await api.createChain({
      name: createForm.name,
      timeout_ms: createForm.timeout_ms || undefined,
      max_retries: createForm.max_retries || undefined,
      models,
    });
    showCreate.value = false;
    createForm.name = "";
    createForm.timeout_ms = 30000;
    createForm.max_retries = 0;
    createModelsText.value = "";
    await loadChains();
  } finally {
    creating.value = false;
  }
}

onMounted(() => loadChains());
</script>
