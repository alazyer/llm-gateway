<template>
  <div>
    <div class="flex items-center gap-2 mb-6">
      <UButton to="/chains" variant="ghost" color="neutral" size="sm" icon="i-lucide-arrow-left">
        Back to chains
      </UButton>
      <h1 class="text-2xl font-bold">Chain: {{ chainName }}</h1>
    </div>

    <div v-if="loading" class="text-gray-500">Loading…</div>

    <template v-else-if="chain">
      <!-- Chain details -->
      <UCard class="mb-6">
        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <div>
            <dt class="text-xs font-medium text-gray-500">Status Reason</dt>
            <dd class="mt-0.5 text-sm">{{ chain.status_reason || '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium text-gray-500">Active Models</dt>
            <dd class="mt-0.5 text-sm">{{ chain.active_models }} / {{ chain.total_models }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium text-gray-500">Timeout (ms)</dt>
            <dd class="mt-0.5 text-sm">{{ chain.timeout_ms }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium text-gray-500">Max Retries</dt>
            <dd class="mt-0.5 text-sm">{{ chain.max_retries }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium text-gray-500">Chain Timeout (ms)</dt>
            <dd class="mt-0.5 text-sm">{{ chain.chain_timeout_ms ?? '—' }}</dd>
          </div>
        </dl>
      </UCard>

      <!-- Model membership editor -->
      <UCard>
        <template #header>
          <h2 class="font-semibold">Model Membership</h2>
        </template>

        <p class="text-sm text-gray-500 mb-3">
          Drag rows to reorder. Use controls to remove models or add new ones.
        </p>

        <div class="space-y-2">
          <div
            v-for="(m, idx) in editableModels"
            :key="m.model_name + idx"
            class="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800 rounded cursor-move"
            draggable="true"
            @dragstart="onDragStart(idx, $event)"
            @dragover.prevent
            @drop="onDrop(idx)"
          >
            <span class="text-sm font-mono text-gray-400 w-6 text-right">{{ idx + 1 }}</span>
            {{ m.status }}
            <span class="text-sm flex-1">{{ m.model_name }}</span>
            <UInput
              v-model.number="m.timeout_ms"
              type="number"
              :name="`model-${idx}-timeout-ms`"
              :aria-label="`${m.model_name} timeout in milliseconds`"
              placeholder="Timeout"
              size="xs"
              class="w-24"
            />
            <UInput
              v-model.number="m.max_retries"
              type="number"
              :name="`model-${idx}-max-retries`"
              :aria-label="`${m.model_name} max retries`"
              placeholder="Retries"
              size="xs"
              class="w-20"
            />
            <UButton
              icon="i-lucide-x"
              size="xs"
              variant="ghost"
              color="red"
              :aria-label="`Remove ${m.model_name} from chain`"
              @click="removeModel(idx)"
            />
          </div>

          <!-- Add model row -->
          <div class="flex items-center gap-2 p-2">
            <USelect
              v-model="addModelName"
              :items="availableModels"
              placeholder="Add model…"
              size="xs"
              class="flex-1"
            />
            <UButton size="xs" @click="addModel" :disabled="!addModelName">Add</UButton>
          </div>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <UButton variant="ghost" @click="resetModels">Reset</UButton>
          <UButton :loading="saving" @click="saveModels">Save Membership</UButton>
        </div>
      </UCard>

      <!-- Chain config edit -->
      <UCard class="mt-6">
        <template #header>
          <h2 class="font-semibold">Edit Chain Config</h2>
        </template>
        <UForm :state="editForm" @submit="onUpdateConfig">
          <UFormField label="Timeout (ms)" name="timeout_ms" class="mt-3">
            <UInput v-model.number="editForm.timeout_ms" type="number" />
          </UFormField>
          <UFormField label="Max Retries" name="max_retries" class="mt-3">
            <UInput v-model.number="editForm.max_retries" type="number" />
          </UFormField>
          <UFormField label="Chain Timeout (ms)" name="chain_timeout_ms" class="mt-3">
            <UInput v-model.number="editForm.chain_timeout_ms" type="number" placeholder="Leave empty for null" />
          </UFormField>
          <div class="mt-4">
            <UButton type="submit" :loading="savingConfig">Save Config</UButton>
          </div>
        </UForm>
      </UCard>
    </template>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const route = useRoute();
const api = useGatewayApi();
const chainName = route.params.name as string;

const loading = ref(true);
const saving = ref(false);
const savingConfig = ref(false);

interface ChainModel {
  position: number;
  model_name: string;
  timeout_ms: number | null;
  max_retries: number | null;
  status: string;
}

const chain = ref<{
  name: string;
  status: string;
  status_reason: string | null;
  active_models: number;
  total_models: number;
  timeout_ms: number;
  max_retries: number;
  chain_timeout_ms: number | null;
  models: ChainModel[];
} | null>(null);

const editableModels = ref<ChainModel[]>([]);
const addModelName = ref("");

const editForm = reactive({
  timeout_ms: 30000,
  max_retries: 0,
  chain_timeout_ms: null as number | null,
});

const dragIdx = ref<number | null>(null);

const allModelNames = ref<string[]>([]);

async function fetchModelNames() {
  try {
    const res = await api.listModels();
    allModelNames.value = res.models.map((m) => m.name);
  } catch {
    // Silently ignore — dropdown will just be empty
  }
}

const availableModels = computed(() => {
  const used = new Set(editableModels.value.map((m) => m.model_name));
  return allModelNames.value.filter((name) => !used.has(name));
});

async function loadChain() {
  loading.value = true;
  try {
    const res = await api.getChain(chainName);
    chain.value = res.chain;
    resetModels();
    editForm.timeout_ms = res.chain.timeout_ms;
    editForm.max_retries = res.chain.max_retries;
    editForm.chain_timeout_ms = res.chain.chain_timeout_ms;
  } finally {
    loading.value = false;
  }
}

function resetModels() {
  if (chain.value) {
    editableModels.value = chain.value.models.map((m) => ({ ...m }));
  }
}

function removeModel(idx: number) {
  editableModels.value.splice(idx, 1);
}

function addModel() {
  if (!addModelName.value) return;
  editableModels.value.push({
    position: editableModels.value.length,
    model_name: addModelName.value,
    timeout_ms: null,
    max_retries: null,
    status: "unknown",
  });
  addModelName.value = "";
}

function onDragStart(idx: number, event: DragEvent) {
  dragIdx.value = idx;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function onDrop(targetIdx: number) {
  if (dragIdx.value === null || dragIdx.value === targetIdx) return;
  const item = editableModels.value.splice(dragIdx.value, 1)[0]!;
  editableModels.value.splice(targetIdx, 0, item);
  // Re-number positions
  editableModels.value.forEach((m, i) => {
    m.position = i;
  });
  dragIdx.value = null;
}

async function saveModels() {
  saving.value = true;
  try {
    await api.updateChain(chainName, {
      models: editableModels.value.map((m, idx) => ({
        model_name: m.model_name,
        timeout_ms: m.timeout_ms,
        max_retries: m.max_retries,
      })),
    });
    await loadChain();
  } finally {
    saving.value = false;
  }
}

async function onUpdateConfig() {
  savingConfig.value = true;
  try {
    await api.updateChain(chainName, {
      timeout_ms: editForm.timeout_ms,
      max_retries: editForm.max_retries,
      chain_timeout_ms: editForm.chain_timeout_ms,
    });
    await loadChain();
  } finally {
    savingConfig.value = false;
  }
}

onMounted(() => {
  loadChain();
  fetchModelNames();
});
</script>
