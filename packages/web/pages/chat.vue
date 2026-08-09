<template>
  <div class="space-y-6">
    <section class="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-slate-950 dark:text-white">Web AI Chat Validation</h1>
          <p class="mt-2 max-w-2xl text-slate-600 dark:text-slate-300">
            Quickly verify whether each configured model is currently available through the gateway.
          </p>
        </div>

        <div class="w-full max-w-md space-y-2">
          <label for="model-picker" class="text-sm font-medium text-slate-700 dark:text-slate-300">
            Active model
          </label>
          <select
            id="model-picker"
            v-model="selectedModelId"
            class="chat-model-picker"
            :disabled="modelsLoading || models.length === 0 || isSubmitting"
            aria-describedby="model-status-copy"
          >
            <option
              v-for="model in models"
              :key="model.id"
              :value="model.id"
            >
              {{ model.displayName }} ({{ model.id }})
            </option>
          </select>
          <p id="model-status-copy" class="text-xs text-slate-500 dark:text-slate-400">
            Status: <span class="font-semibold">{{ selectedModelStatusLabel }}</span>
          </p>
        </div>
      </div>
    </section>

    <UAlert
      v-if="modelsError"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Unable to load models"
      :description="modelsError"
    />

    <UAlert
      v-else-if="!modelsLoading && models.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-inbox"
      title="No routable models available"
      description="Model discovery returned no routable entries from /v1/models. Add or activate models, then refresh."
    />

    <section class="chat-shell rounded-3xl border border-white/70 bg-white/80 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <div class="chat-log" role="log" aria-live="polite">
        <template v-if="entries.length === 0">
          <div class="chat-empty-state">
            <UIcon name="i-lucide-message-circle-heart" class="size-8 text-teal-500" />
            <p class="mt-2 text-base font-semibold text-slate-900 dark:text-white">Ready to validate</p>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Select a model, send a short prompt, and watch for success, timeout, or failure state transitions.
            </p>
          </div>
        </template>

        <template v-else>
          <div
            v-for="entry in entries"
            :key="entry.id"
            class="chat-entry"
          >
            <div
              v-if="entry.type === 'switch'"
              class="chat-switch-divider"
              role="note"
            >
              Switched model: <strong>{{ entry.from }}</strong> → <strong>{{ entry.to }}</strong>
            </div>

            <div v-else class="space-y-1">
              <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {{ entry.role === "user" ? "You" : "Assistant" }} · {{ entry.modelId }}
              </p>
              <article
                :class="[
                  'chat-bubble whitespace-pre-wrap',
                  entry.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant',
                  entry.status === 'failed' ? 'chat-bubble-failed' : '',
                ]"
              >
                <template v-if="entry.content.length > 0">
                  {{ entry.content }}
                </template>
                <template v-else-if="entry.status === 'streaming'">
                  <span class="inline-flex items-center gap-2 text-slate-500 dark:text-slate-300">
                    <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
                    Waiting for response...
                  </span>
                </template>
                <template v-else-if="entry.status === 'failed'">
                  Validation failed.
                </template>
              </article>

              <UAlert
                v-if="entry.role === 'assistant' && entry.status === 'failed' && entry.errorMessage"
                color="error"
                variant="subtle"
                icon="i-lucide-triangle-alert"
                :title="entry.errorTitle || 'Validation failed'"
                :description="entry.errorMessage"
              />
              <p
                v-if="entry.role === 'assistant' && entry.requestId"
                class="text-xs text-slate-500 dark:text-slate-400"
              >
                Request ID: <code>{{ entry.requestId }}</code>
              </p>
            </div>
          </div>
        </template>
      </div>

      <form class="chat-composer border-t border-slate-200/80 p-4 dark:border-white/10" @submit.prevent="sendValidationPrompt">
        <label for="chat-prompt" class="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Validation prompt
        </label>
        <textarea
          id="chat-prompt"
          v-model="prompt"
          class="chat-textarea"
          rows="4"
          placeholder="Example: Reply with OK if this model is available."
          :disabled="!canSend"
          @keydown.enter.exact.prevent="sendValidationPrompt"
          @keydown.enter.shift.exact.stop
        />

        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Enter sends · Shift+Enter adds a newline · Timeout defaults to 120s
          </p>
          <div class="flex items-center gap-2">
            <UButton
              v-if="isSubmitting"
              type="button"
              color="warning"
              variant="subtle"
              icon="i-lucide-square"
              @click="stopGeneration"
            >
              Stop
            </UButton>
            <UButton
              v-if="lastFailedPrompt"
              type="button"
              color="neutral"
              variant="ghost"
              icon="i-lucide-rotate-ccw"
              :disabled="isSubmitting || !selectedModelId"
              @click="retryLastFailure"
            >
              Retry
            </UButton>
            <UButton
              type="submit"
              color="primary"
              icon="i-lucide-send"
              :disabled="!canSend || isSubmitting || !prompt.trim()"
              :loading="isSubmitting"
            >
              Validate model
            </UButton>
          </div>
        </div>
      </form>
    </section>

    <p class="sr-only" aria-live="polite">{{ ariaAnnouncement }}</p>
  </div>
</template>

<script setup lang="ts">
import type { ChatValidationResponse } from "~/composables/useGatewayApi";
import { classifyGatewayError } from "~/utils/chatErrorClassification";

definePageMeta({ middleware: "auth" });

type SessionModelStatus = "untested" | "available" | "unavailable";

interface ChatMessageEntry {
  id: string;
  type: "message";
  role: "user" | "assistant";
  modelId: string;
  content: string;
  status: "streaming" | "done" | "failed";
  errorTitle?: string;
  errorMessage?: string;
  requestId?: string;
}

interface ModelSwitchEntry {
  id: string;
  type: "switch";
  from: string;
  to: string;
}

type ChatEntry = ChatMessageEntry | ModelSwitchEntry;

const api = useGatewayApi();

const modelsLoading = ref(true);
const modelsError = ref("");
const models = ref<Array<{
  id: string;
  displayName: string;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
}>>([]);

const selectedModelId = ref("");
const modelStatuses = ref<Record<string, SessionModelStatus>>({});

const entries = ref<ChatEntry[]>([]);
const prompt = ref("");
const isSubmitting = ref(false);
const currentAbort = ref<AbortController | null>(null);
const lastFailedPrompt = ref("");
const ariaAnnouncement = ref("");

const selectedModel = computed(() => {
  return models.value.find((model) => model.id === selectedModelId.value);
});

const canSend = computed(() => {
  return !modelsLoading.value && models.value.length > 0 && !!selectedModel.value;
});

const selectedModelStatus = computed<SessionModelStatus>(() => {
  if (!selectedModel.value) {
    return "untested";
  }
  return modelStatuses.value[selectedModel.value.id] ?? "untested";
});

const selectedModelStatusLabel = computed(() => {
  if (selectedModelStatus.value === "available") {
    return "Available in this session";
  }
  if (selectedModelStatus.value === "unavailable") {
    return "Unavailable in this session";
  }
  return "Untested in this session";
});

watch(selectedModelId, (next, previous) => {
  if (!next || !previous || next === previous) {
    return;
  }

  const hasMessage = entries.value.some((entry) => entry.type === "message");
  if (!hasMessage) {
    return;
  }

  const from = modelLabel(previous);
  const to = modelLabel(next);
  entries.value.push({
    id: `switch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "switch",
    from,
    to,
  });
  ariaAnnouncement.value = `Model switched from ${from} to ${to}.`;
});

function modelLabel(modelId: string): string {
  const model = models.value.find((item) => item.id === modelId);
  return model ? model.displayName : modelId;
}

function updateModelSessionStatus(modelId: string, status: SessionModelStatus): void {
  modelStatuses.value = {
    ...modelStatuses.value,
    [modelId]: status,
  };
}

function createMessageEntry(
  role: "user" | "assistant",
  modelId: string,
  content: string,
  status: ChatMessageEntry["status"],
): ChatMessageEntry {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "message",
    role,
    modelId,
    content,
    status,
  };
}

function extractAssistantContent(response: ChatValidationResponse): string {
  const firstChoice = response.choices[0];
  const text = firstChoice?.message?.content;
  if (typeof text === "string" && text.length > 0) {
    return text;
  }
  return "Validation completed with an empty assistant message.";
}

async function sendValidationPrompt(): Promise<void> {
  if (!selectedModel.value || isSubmitting.value) {
    return;
  }

  const userPrompt = prompt.value.trim();
  if (!userPrompt) {
    return;
  }

  const activeModel = selectedModel.value;
  const userEntry = createMessageEntry("user", activeModel.id, userPrompt, "done");
  const assistantEntry = createMessageEntry("assistant", activeModel.id, "", "streaming");
  entries.value.push(userEntry, assistantEntry);

  prompt.value = "";
  isSubmitting.value = true;
  ariaAnnouncement.value = `Validation started for model ${activeModel.displayName}.`;

  const abortController = new AbortController();
  currentAbort.value = abortController;

  try {
    if (activeModel.supportsStreaming) {
      await api.streamValidationChat({
        model: activeModel.id,
        prompt: userPrompt,
        signal: abortController.signal,
        onTextDelta: (delta) => {
          assistantEntry.content += delta;
        },
        onRequestId: (requestId) => {
          assistantEntry.requestId = requestId;
        },
      });
    } else {
      const response = await api.validateChatPrompt({
        model: activeModel.id,
        prompt: userPrompt,
        signal: abortController.signal,
      });
      assistantEntry.content = extractAssistantContent(response);
      assistantEntry.requestId = response.id;
    }

    assistantEntry.status = "done";
    updateModelSessionStatus(activeModel.id, "available");
    lastFailedPrompt.value = "";
    ariaAnnouncement.value = `Validation succeeded for model ${activeModel.displayName}.`;
  } catch (error) {
    const classified = classifyGatewayError(error);
    assistantEntry.status = "failed";
    assistantEntry.errorTitle = classified.title;
    assistantEntry.errorMessage = classified.message;
    if (classified.requestId) {
      assistantEntry.requestId = classified.requestId;
    }
    if (classified.marksUnavailable) {
      updateModelSessionStatus(activeModel.id, "unavailable");
    }
    lastFailedPrompt.value = userPrompt;
    ariaAnnouncement.value = `${classified.title} for model ${activeModel.displayName}.`;
  } finally {
    isSubmitting.value = false;
    currentAbort.value = null;
  }
}

function stopGeneration(): void {
  if (!currentAbort.value) {
    return;
  }
  currentAbort.value.abort("cancelled_by_user");
}

function retryLastFailure(): void {
  if (!lastFailedPrompt.value || isSubmitting.value) {
    return;
  }
  prompt.value = lastFailedPrompt.value;
  void sendValidationPrompt();
}

async function loadModels(): Promise<void> {
  modelsLoading.value = true;
  modelsError.value = "";
  try {
    const discovered = await api.listValidationModels();
    models.value = discovered;
    const nextStatuses: Record<string, SessionModelStatus> = {};
    for (const model of discovered) {
      nextStatuses[model.id] = modelStatuses.value[model.id] ?? "untested";
    }
    modelStatuses.value = nextStatuses;

    if (discovered.length === 0) {
      selectedModelId.value = "";
      return;
    }

    if (!discovered.some((model) => model.id === selectedModelId.value)) {
      selectedModelId.value = discovered[0]!.id;
    }
  } catch (error) {
    modelsError.value = error instanceof Error
      ? error.message
      : "Unexpected error while loading models.";
  } finally {
    modelsLoading.value = false;
  }
}

onMounted(() => {
  void loadModels();
});
</script>
