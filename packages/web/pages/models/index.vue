<template>
  <div class="space-y-6">
    <section class="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-slate-950 dark:text-white">Models</h1>
          <p class="mt-2 max-w-2xl text-slate-600 dark:text-slate-300">
            Manage upstream model routes, capabilities, and activation status.
          </p>
        </div>
        <UButton icon="i-lucide-plus" size="lg" @click="showCreate = true">Add Model</UButton>
      </div>
    </section>

    <UCard class="border-white/70 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="font-semibold text-slate-950 dark:text-white">Configured upstreams</h2>
          <p class="text-sm text-slate-500 dark:text-slate-400">Filter by status or source, then click a row for details.</p>
        </div>

        <div class="flex flex-wrap gap-2">
          <USelect
            v-model="filterStatus"
            placeholder="All statuses"
            :items="['active', 'inactive']"
            class="w-40"
            @change="loadModels"
          />
          <USelect
            v-model="filterSource"
            placeholder="All sources"
            :items="['static', 'copilot-proxy']"
            class="w-44"
            @change="loadModels"
          />
          <UButton variant="ghost" size="sm" icon="i-lucide-x" v-if="filterStatus || filterSource" @click="clearFilters">
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
        title="Could not load models"
        :description="error"
      />

      <UAlert
        v-else-if="models.length === 0"
        color="neutral"
        variant="subtle"
        icon="i-lucide-inbox"
        title="No models found"
        description="Create a model or adjust the filters to see configured upstreams."
      />

      <UTable v-else :data="models" :columns="columns" :on-select="onSelect">
        <template #status-cell="{ row }">
          {{ row.original.status }}
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton
              v-if="row.original.status === 'inactive'"
              size="xs"
              color="success"
              variant="ghost"
              @click.stop="activateModel(row.original.name)"
            >Activate</UButton>
            <UButton
              v-if="row.original.status === 'active'"
              size="xs"
              color="error"
              variant="ghost"
              @click.stop="deactivateModel(row.original.name)"
            >Deactivate</UButton>
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

    <!-- Create model modal -->
    <UModal v-if="showCreate" v-model:open="showCreate" unmount-on-hide>
      <template #content>
        <UCard>
          <template #header>
            <h2 class="font-semibold">Add Model</h2>
          </template>
          <UForm :state="createForm" @submit="onCreate">
            <UFormField label="Name" name="name" required>
              <UInput v-model="createForm.name" />
            </UFormField>
            <UFormField label="Upstream Model" name="upstream_model" required class="mt-3">
              <UInput v-model="createForm.upstream_model" />
            </UFormField>
            <UFormField label="Base URL" name="base_url" required class="mt-3">
              <UInput v-model="createForm.base_url" placeholder="https://api.example.com" />
            </UFormField>
            <UFormField label="API Key Env Var" name="api_key_env" required class="mt-3">
              <UInput v-model="createForm.api_key_env" placeholder="MY_API_KEY" />
            </UFormField>
            <UFormField label="Owned By" name="owned_by" class="mt-3">
              <UInput v-model="createForm.owned_by" placeholder="llm-gateway" />
            </UFormField>
            <UFormField label="Supports Tools" name="supports_tools" class="mt-3">
              <USwitch v-model="createForm.supports_tools" />
            </UFormField>
            <UFormField label="Supports Streaming" name="supports_streaming" class="mt-3">
              <USwitch v-model="createForm.supports_streaming" />
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
            <h2 class="font-semibold">Delete Model</h2>
          </template>
          <p>Are you sure you want to delete model <strong>{{ deleteTarget }}</strong>?</p>
          <p v-if="deleteAffected.length" class="mt-2 text-sm text-yellow-600">
            Affected chains: {{ deleteAffected.join(', ') }}
          </p>
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
const models = ref<Array<{
  name: string;
  upstream_model: string;
  base_url: string;
  owned_by: string;
  status: string;
  status_reason: string | null;
  supports_tools: boolean;
  supports_streaming: boolean;
}>>([]);

const filterStatus = ref("");
const filterSource = ref("");

const columns = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "upstream_model", header: "Upstream" },
  { accessorKey: "status", header: "Status" },
  { accessorKey: "owned_by", header: "Owner" },
  { id: "actions", header: "" },
];

// Create form
const showCreate = ref(false);
const creating = ref(false);
const createForm = reactive({
  name: "",
  upstream_model: "",
  base_url: "",
  api_key_env: "",
  owned_by: "llm-gateway",
  supports_tools: true,
  supports_streaming: true,
});

// Delete confirmation
const showDelete = ref(false);
const deleteTarget = ref("");
const deleteAffected = ref<string[]>([]);
const deleting = ref(false);

async function loadModels() {
  loading.value = true;
  error.value = "";
  try {
    const filters: { status?: string; source?: string } = {};
    if (filterStatus.value) filters.status = filterStatus.value;
    if (filterSource.value) filters.source = filterSource.value;
    const res = await api.listModels(filters);
    models.value = res.models;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Unexpected error while loading models.";
  } finally {
    loading.value = false;
  }
}

function clearFilters() {
  filterStatus.value = "";
  filterSource.value = "";
  loadModels();
}

function onSelect(_event: Event, row: { original: { name: string } }) {
  navigateTo(`/models/${row.original.name}`);
}

async function activateModel(name: string) {
  await api.activateModel(name);
  await loadModels();
}

async function deactivateModel(name: string) {
  await api.deactivateModel(name);
  await loadModels();
}

function confirmDelete(name: string) {
  deleteTarget.value = name;
  deleteAffected.value = [];
  showDelete.value = true;
}

async function onDelete() {
  deleting.value = true;
  try {
    const res = await api.deleteModel(deleteTarget.value);
    deleteAffected.value = res.affected_chains;
    showDelete.value = false;
    await loadModels();
  } finally {
    deleting.value = false;
  }
}

async function onCreate() {
  creating.value = true;
  try {
    await api.createModel({
      name: createForm.name,
      upstream_model: createForm.upstream_model,
      base_url: createForm.base_url,
      api_key_env: createForm.api_key_env,
      owned_by: createForm.owned_by || undefined,
      supports_tools: createForm.supports_tools,
      supports_streaming: createForm.supports_streaming,
    });
    showCreate.value = false;
    // Reset form
    createForm.name = "";
    createForm.upstream_model = "";
    createForm.base_url = "";
    createForm.api_key_env = "";
    createForm.owned_by = "llm-gateway";
    createForm.supports_tools = true;
    createForm.supports_streaming = true;
    await loadModels();
  } finally {
    creating.value = false;
  }
}

onMounted(() => loadModels());
</script>
