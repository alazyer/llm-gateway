<template>
  <div class="flex h-full flex-col gap-4">
    <section class="flex flex-col gap-3 rounded-2xl border border-white/70 bg-white/80 px-5 py-4 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 class="text-xl font-bold tracking-tight text-slate-950 dark:text-white">Web AI Chat</h1>
        <p class="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
          Chat with the gateway's configured model. Sessions persist across refresh.
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <label class="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
          <span class="sr-only">Model</span>
          <select
            v-model="selectedModelId"
            class="chat-model-picker !w-auto !py-1.5 text-sm"
            :disabled="!hasGatewayCredential || modelsLoading || models.length === 0"
            aria-label="Active model"
          >
            <option v-for="model in models" :key="model.id" :value="model.id">
              {{ model.displayName }}
            </option>
          </select>
        </label>
        <p class="hidden text-xs text-slate-500 dark:text-slate-400 sm:block">
          Enter sends · Shift+Enter newline
        </p>
      </div>
    </section>

    <UAlert
      v-if="!hasGatewayCredential"
      color="warning"
      variant="subtle"
      icon="i-lucide-shield-alert"
      title="Authentication required"
      description="No gateway auth credential is available. Sign in to start chatting."
    >
      <template #actions>
        <UButton color="warning" variant="solid" size="sm" icon="i-lucide-log-in" @click="navigateTo('/auth')">
          Sign in
        </UButton>
      </template>
    </UAlert>

    <section class="chat-shell flex-1 overflow-hidden rounded-3xl border border-white/70 bg-white/80 shadow-xl shadow-slate-950/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <!-- Left rail: session history -->
      <aside class="flex w-full shrink-0 flex-col border-b border-slate-200/80 dark:border-white/10 md:w-72 md:border-b-0 md:border-r">
        <div class="flex items-center justify-between border-b border-slate-200/80 px-4 py-3 dark:border-white/10">
          <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">Sessions</p>
          <UButton
            color="primary"
            variant="soft"
            size="xs"
            icon="i-lucide-plus"
            :disabled="!hasGatewayCredential"
            @click="startNewSession"
          >
            New chat
          </UButton>
        </div>

        <div class="chat-log max-h-52 !px-2 !py-2 md:max-h-none">
          <!-- New chat pseudo-entry -->
          <button
            v-if="!activeSessionId"
            type="button"
            class="flex w-full items-center gap-2 rounded-xl bg-teal-50 px-3 py-2.5 text-left text-sm font-medium text-teal-700 dark:bg-teal-500/10 dark:text-teal-200"
          >
            <UIcon name="i-lucide-square-pen" class="size-4 shrink-0" />
            <span class="truncate">New conversation</span>
          </button>

          <template v-if="sessionsLoading">
            <div class="chat-empty-state !min-h-16">
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-slate-400" />
              <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">Loading sessions…</p>
            </div>
          </template>
          <template v-else-if="sessions.length === 0 && activeSessionId">
            <div class="chat-empty-state !min-h-16">
              <UIcon name="i-lucide-inbox" class="size-5 text-slate-400" />
              <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">No sessions yet.</p>
            </div>
          </template>
          <template v-else>
            <div
              v-for="session in sessions"
              :key="session.sessionId"
              class="group flex flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-white/5"
              :class="activeSessionId === session.sessionId ? 'bg-teal-50 dark:bg-teal-500/10' : ''"
            >
              <div class="flex w-full items-center gap-1">
                <button
                  v-if="editingSessionId !== session.sessionId"
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1 text-left"
                  @click="openSession(session.sessionId)"
                >
                  <span class="line-clamp-1 text-sm font-medium text-slate-800 dark:text-slate-100">
                    {{ session.title || sessionPreview(session) }}
                  </span>
                </button>
                <UButton
                  v-if="editingSessionId !== session.sessionId"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-pencil"
                  class="opacity-0 transition group-hover:opacity-100"
                  :disabled="renamingSessionId === session.sessionId"
                  aria-label="Rename session"
                  @click.stop="startRename(session)"
                />
              </div>
              <input
                v-if="editingSessionId === session.sessionId"
                v-model="editingTitle"
                type="text"
                class="w-full rounded-md border border-teal-400 bg-white px-2 py-1 text-sm text-slate-900 dark:bg-slate-900 dark:text-slate-100"
                :disabled="renamingSessionId === session.sessionId"
                maxlength="120"
                @keydown.enter.prevent="commitRename(session)"
                @keydown.escape.prevent="cancelRename"
                @blur="commitRename(session)"
              >
              <span
                v-if="editingSessionId !== session.sessionId"
                class="text-xs text-slate-400 dark:text-slate-500"
              >
                {{ relativeTime(session.updatedAt) }}
              </span>
            </div>
          </template>

          <div v-if="sessionsHasMore" class="px-2 py-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              block
              icon="i-lucide-chevron-down"
              :loading="sessionsLoadingMore"
              @click="loadMoreSessions"
            >
              Load older sessions
            </UButton>
          </div>
        </div>
      </aside>

      <!-- Right pane: active session / new chat -->
      <div class="chat-pane min-w-0">
        <div ref="messageLogEl" class="chat-log" role="log" aria-live="polite">
          <template v-if="!activeSessionId">
            <div class="chat-empty-state">
              <UIcon name="i-lucide-message-circle-heart" class="size-8 text-teal-500" />
              <p class="mt-2 text-base font-semibold text-slate-900 dark:text-white">New conversation</p>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Send a message below to start chatting with the gateway model.
              </p>
            </div>
          </template>
          <template v-else-if="messagesLoading && entries.length === 0">
            <div class="chat-empty-state">
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-slate-400" />
              <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">Loading messages…</p>
            </div>
          </template>
          <template v-else>
            <div
              v-for="entry in entries"
              :key="entry.id"
              class="chat-entry"
            >
              <div class="space-y-1">
                <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {{ entry.role === "user" ? "You" : "Assistant" }}
                  <template v-if="entry.model">· {{ entry.model }}</template>
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
                      Waiting for response…
                    </span>
                  </template>
                  <template v-else-if="entry.status === 'failed'">
                    Chat failed.
                  </template>

                  <div
                    v-if="entry.role === 'user' && entry.attachments.length > 0"
                    class="mt-2 flex flex-wrap gap-2"
                  >
                    <div
                      v-for="attachment in entry.attachments"
                      :key="attachment.id"
                      class="relative overflow-hidden rounded-lg border border-slate-200 dark:border-white/10"
                    >
                      <img
                        :src="attachment.dataUrl"
                        :alt="attachment.name ?? 'attached image'"
                        class="h-24 w-24 object-cover"
                      >
                    </div>
                  </div>
                </article>

                <UAlert
                  v-if="entry.role === 'assistant' && entry.status === 'failed' && entry.errorMessage"
                  color="error"
                  variant="subtle"
                  icon="i-lucide-triangle-alert"
                  :title="entry.errorTitle || 'Chat failed'"
                  :description="entry.errorMessage"
                >
                  <template v-if="entry.retryable" #actions>
                    <UButton
                      color="error"
                      variant="subtle"
                      size="xs"
                      icon="i-lucide-rotate-ccw"
                      :disabled="isSubmitting"
                      @click="retryLastFailure"
                    >
                      Retry
                    </UButton>
                  </template>
                </UAlert>
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

        <form class="chat-composer border-t border-slate-200/80 p-4 dark:border-white/10" @submit.prevent="sendMessage">
          <textarea
            id="chat-prompt"
            v-model="prompt"
            class="chat-textarea"
            rows="3"
            :placeholder="activeSessionId ? 'Send a message…' : 'Send a message to start a new session…'"
            :disabled="!hasGatewayCredential"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.enter.shift.exact.stop
          />

          <input
            ref="fileInputEl"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            class="hidden"
            data-testid="image-file-input"
            @change="onFileSelected"
          >

          <div
            v-if="attachments.length > 0 || attachmentError || (!activeModelSupportsImage && hasGatewayCredential)"
            class="mt-2 flex flex-wrap items-center gap-2"
          >
            <div
              v-for="attachment in attachments"
              :key="attachment.id"
              class="group relative flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 dark:border-white/10 dark:bg-white/5"
            >
              <img
                :src="attachment.dataUrl"
                :alt="attachment.name ?? 'attached image'"
                class="size-9 rounded-md object-cover"
              >
              <span class="max-w-[10rem] truncate text-xs text-slate-600 dark:text-slate-300">
                {{ attachment.name ?? "image" }}
              </span>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                aria-label="Remove attachment"
                :disabled="isSubmitting"
                @click="removeAttachment(attachment.id)"
              />
            </div>

            <UButton
              v-if="activeModelSupportsImage && attachments.length < MAX_ATTACHMENTS && !isSubmitting"
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-image-plus"
              aria-label="Attach image"
              @click="openFilePicker"
            >
              Add image
            </UButton>
          </div>

          <p
            v-if="attachmentError"
            class="mt-1 text-xs text-rose-600 dark:text-rose-400"
          >
            {{ attachmentError }}
          </p>

          <UAlert
            v-if="hasIncompatibleAttachment"
            color="warning"
            variant="subtle"
            icon="i-lucide-image-off"
            title="This model doesn't support images"
            description="Remove the attachment or switch to an image-capable model to send."
            class="mt-2"
          >
            <template #actions>
              <UButton
                color="warning"
                variant="soft"
                size="xs"
                icon="i-lucide-trash-2"
                :disabled="isSubmitting"
                @click="clearAttachments"
              >
                Remove attachment
              </UButton>
            </template>
          </UAlert>

          <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p class="text-xs text-slate-500 dark:text-slate-400">
              {{ stateLabel }}
            </p>
            <div class="flex items-center gap-2">
              <UButton
                v-if="activeModelSupportsImage && attachments.length < MAX_ATTACHMENTS && !isSubmitting && hasGatewayCredential"
                type="button"
                color="neutral"
                variant="subtle"
                icon="i-lucide-paperclip"
                :disabled="!hasGatewayCredential"
                aria-label="Attach image"
                @click="openFilePicker"
              >
                <span class="hidden sm:inline">Image</span>
              </UButton>
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
                v-if="lastFailedPrompt && !isSubmitting"
                type="button"
                color="neutral"
                variant="ghost"
                icon="i-lucide-rotate-ccw"
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
                Send
              </UButton>
            </div>
          </div>
        </form>
      </div>
    </section>

    <p class="sr-only" aria-live="polite">{{ ariaAnnouncement }}</p>
  </div>
</template>

<script setup lang="ts">
import type {
  AiChatAttachment,
  AiChatChatModel,
  AiChatHistoryMessage,
  AiChatSessionSummary,
} from "~/composables/useGatewayApi";
import {
  GatewayApiError,
  composeMessagePages,
  composeSessionPages,
  resolveSelectedModel,
} from "~/composables/useGatewayApi";
import { classifyGatewayError } from "~/utils/chatErrorClassification";
import {
  MAX_ATTACHMENTS,
  canAddAttachment,
  validateImageAttachment,
} from "~/utils/attachments";
import {
  activeModelSupportsImage as computeActiveModelSupportsImage,
  canSend as computeCanSend,
  hasIncompatibleAttachment as computeHasIncompatibleAttachment,
} from "~/utils/composerGating";
import {
  historyMessageToEntry as mapHistoryMessageToEntry,
} from "~/utils/chatTimeline";

definePageMeta({ middleware: ["auth", "web-chat-validation"] });

type ChatStatus = "streaming" | "done" | "failed";

interface ChatMessageEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: AiChatAttachment[];
  status: ChatStatus;
  model: string | null;
  requestId?: string;
  errorTitle?: string;
  errorMessage?: string;
  retryable?: boolean;
}

const api = useGatewayApi();

// Auth-required UI state — chat submission is blocked while no credential.
const hasGatewayCredential = ref(api.hasGatewayCredential());

// Sessions
const sessionsLoading = ref(true);
const sessionsLoadingMore = ref(false);
const sessions = ref<AiChatSessionSummary[]>([]);
const sessionsCursor = ref<string | null>(null);
const sessionsHasMore = computed(() => sessionsCursor.value !== null);

// Active session + messages
const activeSessionId = ref<string | null>(null);
const messagesLoading = ref(false);
const messagesCursor = ref<string | null>(null);

// Model picker — populated from GET /v1/models; the selected model is sent with
// each message and restored from the session on open.
const models = ref<AiChatChatModel[]>([]);
const modelsLoading = ref(true);
const selectedModelId = ref("");

// Session rename inline-edit state.
const editingSessionId = ref<string | null>(null);
const editingTitle = ref("");
const renamingSessionId = ref<string | null>(null);

// Composer + request state
const entries = ref<ChatMessageEntry[]>([]);
const prompt = ref("");
const isSubmitting = ref(false);
const currentAbort = ref<AbortController | null>(null);
const lastFailedPrompt = ref("");
const ariaAnnouncement = ref("");

// Image-attachment composer state. Bounded to one image per message and a
// ~700 KB base64 cap so the request fits the default 1 MiB body limit.
// Validation rules live in `~/utils/attachments` so they are unit-testable.
const attachments = ref<AiChatAttachment[]>([]);
const attachmentError = ref<string | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);

// Whether the active model accepts image input. Drives the attach-control gate.
// Delegates to the pure helper in `~/utils/composerGating` (unit-tested there).
const activeModelSupportsImage = computed(() =>
  computeActiveModelSupportsImage(models.value, selectedModelId.value),
);

// A pending (unsent) image is incompatible with the active model — block Send
// rather than silently stripping the image (the backend would reject it).
const hasIncompatibleAttachment = computed(() =>
  computeHasIncompatibleAttachment(attachments.value, activeModelSupportsImage.value),
);

// Message log element for auto-scroll.
const messageLogEl = ref<HTMLElement | null>(null);

// Sending is allowed when authenticated, a prompt is present (text part is
// mandatory per the backend `prompt.min(1)` invariant), and any pending
// attachment is compatible with the active model. The prompt-presence guard
// lives in `sendMessage`; `canSend` reflects only the gating state owned here.
const canSend = computed(() =>
  computeCanSend(hasGatewayCredential.value, hasIncompatibleAttachment.value),
);

const stateLabel = computed(() => {
  if (!hasGatewayCredential.value) return "Sign in to chat.";
  if (hasIncompatibleAttachment.value) {
    return "Remove the attachment or switch to an image-capable model to send.";
  }
  if (isSubmitting.value) return "Streaming response…";
  if (!activeSessionId.value) return "Idle — ready for a new session.";
  return "Idle — ready for your next message.";
});

// Auto-scroll the message log to the bottom whenever entries change (new
// message, streamed delta, or a freshly-opened session).
watch(
  () => entries.value.map((e) => `${e.id}:${e.content.length}:${e.status}`).join("|"),
  () => {
    nextTick(() => {
      const el = messageLogEl.value;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  },
);

// When the active session changes, restore its stored model into the picker.
watch(activeSessionId, () => {
  const active = sessions.value.find((s) => s.sessionId === activeSessionId.value);
  if (active?.model && models.value.some((m) => m.id === active.model)) {
    selectedModelId.value = active.model;
  }
});

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function relativeTime(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatTimestamp(ms);
}

function sessionPreview(session: AiChatSessionSummary): string {
  return `Session ${session.sessionId.slice(0, 8)}`;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function historyMessageToEntry(message: AiChatHistoryMessage): ChatMessageEntry {
  // Delegates to the pure helper in `~/utils/chatTimeline` (unit-tested there).
  // The local `ChatMessageEntry` is structurally identical to `ChatTimelineEntry`.
  return mapHistoryMessageToEntry(message) as ChatMessageEntry;
}

// ---- Models ----

async function loadModels(): Promise<void> {
  modelsLoading.value = true;
  try {
    const discovered = await api.listChatModels();
    models.value = discovered;
    if (discovered.length > 0 && !discovered.some((m) => m.id === selectedModelId.value)) {
      // Default to the first listed model for a new chat if nothing is selected.
      selectedModelId.value = discovered[0]!.id;
    }
  } catch (error) {
    ariaAnnouncement.value = error instanceof Error ? error.message : "Failed to load models.";
  } finally {
    modelsLoading.value = false;
  }
}

// ---- Session rename ----

function startRename(session: AiChatSessionSummary): void {
  editingSessionId.value = session.sessionId;
  editingTitle.value = session.title ?? sessionPreview(session);
}

function cancelRename(): void {
  editingSessionId.value = null;
  editingTitle.value = "";
}

async function commitRename(session: AiChatSessionSummary): Promise<void> {
  if (editingSessionId.value !== session.sessionId) return;
  const title = editingTitle.value.trim();
  if (!title || renamingSessionId.value) {
    cancelRename();
    return;
  }
  if (title === (session.title ?? sessionPreview(session))) {
    cancelRename();
    return;
  }

  const previousTitle = session.title;
  renamingSessionId.value = session.sessionId;
  // Optimistic update.
  const idx = sessions.value.findIndex((s) => s.sessionId === session.sessionId);
  if (idx !== -1) {
    sessions.value[idx]!.title = title;
  }

  try {
    await api.renameSession({ sessionId: session.sessionId, title });
    // Refresh to pick up the new updated_at ordering.
    await loadSessions(true);
    ariaAnnouncement.value = "Session renamed.";
  } catch (error) {
    // Revert on failure.
    const revertIdx = sessions.value.findIndex((s) => s.sessionId === session.sessionId);
    if (revertIdx !== -1) {
      sessions.value[revertIdx]!.title = previousTitle;
    }
    const classified = classifyGatewayError(error);
    ariaAnnouncement.value = `${classified.title}: ${classified.message}`;
  } finally {
    renamingSessionId.value = null;
    cancelRename();
  }
}

// ---- Sessions ----

async function loadSessions(replace = true): Promise<void> {
  if (!hasGatewayCredential.value) {
    sessionsLoading.value = false;
    return;
  }
  if (replace) {
    sessionsLoading.value = true;
  } else {
    sessionsLoadingMore.value = true;
  }
  try {
    const result = await api.listSessions({ limit: 20 });
    sessions.value = composeSessionPages(
      sessions.value,
      result.data,
      replace,
      (s) => s.sessionId,
    );
    sessionsCursor.value = result.nextCursor;
  } catch (error) {
    ariaAnnouncement.value = error instanceof Error ? error.message : "Failed to load sessions.";
  } finally {
    sessionsLoading.value = false;
    sessionsLoadingMore.value = false;
  }
}

async function loadMoreSessions(): Promise<void> {
  if (!sessionsCursor.value || sessionsLoadingMore.value) return;
  await loadSessions(false);
}

// ---- Session messages ----

async function loadSessionMessages(sessionId: string, replace = true): Promise<void> {
  if (!hasGatewayCredential.value) return;
  if (replace) {
    messagesLoading.value = true;
  }
  try {
    const result = await api.listSessionMessages({
      sessionId,
      limit: 50,
      ...(replace ? {} : { cursor: messagesCursor.value ?? undefined }),
    });

    // Messages arrive oldest-first; load-more (nextCursor) yields the next
    // newer page, so additional pages append to the bottom deterministically
    // without skipping or duplicating messages.
    const mapped = result.data.map(historyMessageToEntry);
    entries.value = composeMessagePages(
      entries.value,
      mapped,
      replace,
      (m) => m.id,
    );
    messagesCursor.value = result.nextCursor;
  } catch (error) {
    const classified = classifyGatewayError(error);
    ariaAnnouncement.value = classified.message;
  } finally {
    messagesLoading.value = false;
  }
}

async function openSession(sessionId: string): Promise<void> {
  if (activeSessionId.value === sessionId && entries.value.length > 0) return;
  activeSessionId.value = sessionId;
  messagesCursor.value = null;
  entries.value = [];
  await loadSessionMessages(sessionId, true);
}

function startNewSession(): void {
  activeSessionId.value = null;
  messagesCursor.value = null;
  entries.value = [];
  lastFailedPrompt.value = "";
  // Reset the picker to the first available model for a fresh chat.
  if (models.value.length > 0 && !selectedModelId.value) {
    selectedModelId.value = models.value[0]!.id;
  }
}

// ---- Send message (stream) ----

function generateClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback UUID v4 — the field is a UUID per the backend schema.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---- Attachments ----

function openFilePicker(): void {
  if (!activeModelSupportsImage.value || attachments.value.length >= MAX_ATTACHMENTS) {
    return;
  }
  fileInputEl.value?.click();
}

function onFileSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  // Reset the input so re-selecting the same file fires `change` again.
  input.value = "";
  attachmentError.value = null;

  for (const file of files) {
    if (!canAddAttachment(attachments.value.length)) {
      attachmentError.value = "Only one image per message is supported.";
      break;
    }
    const rejection = validateImageAttachment(file);
    if (rejection) {
      attachmentError.value = rejection;
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        attachmentError.value = `${file.name}: could not read image.`;
        return;
      }
      attachments.value.push({
        id: makeId("att"),
        type: file.type,
        dataUrl,
        name: file.name,
        size: file.size,
      });
    };
    reader.onerror = () => {
      attachmentError.value = `${file.name}: could not read image.`;
    };
    reader.readAsDataURL(file);
  }
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter((a) => a.id !== id);
  if (attachments.value.length === 0) {
    attachmentError.value = null;
  }
}

function clearAttachments(): void {
  attachments.value = [];
  attachmentError.value = null;
}

async function sendMessage(): Promise<void> {
  if (!hasGatewayCredential.value) {
    ariaAnnouncement.value = "Authentication required to chat.";
    return;
  }
  if (isSubmitting.value) return;

  const userPrompt = prompt.value.trim();
  if (!userPrompt) return;
  if (hasIncompatibleAttachment.value) return;

  // Snapshot the pending attachments into the timeline entry and clear the
  // composer; they are restored from history on completion regardless.
  const sentAttachments = attachments.value.slice();
  const userEntry: ChatMessageEntry = {
    id: makeId("user"),
    role: "user",
    content: userPrompt,
    attachments: sentAttachments,
    status: "done",
    model: null,
  };
  const assistantEntry: ChatMessageEntry = {
    id: makeId("assistant"),
    role: "assistant",
    content: "",
    attachments: [],
    status: "streaming",
    model: null,
  };
  entries.value.push(userEntry, assistantEntry);

  prompt.value = "";
  clearAttachments();
  isSubmitting.value = true;
  ariaAnnouncement.value = "Chat request started.";

  const abortController = new AbortController();
  currentAbort.value = abortController;
  const clientMessageId = generateClientMessageId();

  try {
    await api.streamAiChatMessage({
      prompt: userPrompt,
      clientMessageId,
      ...(activeSessionId.value ? { sessionId: activeSessionId.value } : {}),
      ...(selectedModelId.value ? { model: selectedModelId.value } : {}),
      ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
      signal: abortController.signal,
      callbacks: {
        onStarted: (event) => {
          if (!activeSessionId.value) {
            activeSessionId.value = event.sessionId;
          }
          if (event.requestId) {
            assistantEntry.requestId = event.requestId;
          }
          if (event.model) {
            assistantEntry.model = event.model;
            selectedModelId.value = event.model;
          }
        },
        onDelta: (event) => {
          assistantEntry.content += event.delta;
        },
        onCompleted: (event) => {
          assistantEntry.status = "done";
          if (event.requestId) {
            assistantEntry.requestId = event.requestId;
          }
          lastFailedPrompt.value = "";
          ariaAnnouncement.value = "Chat response completed.";
        },
        onError: (event) => {
          // Preserve already-rendered partial delta content; surface the typed
          // error code, retryability, and request id.
          assistantEntry.status = "failed";
          assistantEntry.retryable = event.retryable;
          assistantEntry.requestId = event.requestId || assistantEntry.requestId;
          const classification = classifyGatewayError(
            new GatewayApiError(event.message, 502, {
              code: event.code,
              requestId: event.requestId,
              retryable: event.retryable,
            }),
          );
          assistantEntry.errorTitle = classification.title;
          assistantEntry.errorMessage = classification.message;
          if (event.retryable) {
            lastFailedPrompt.value = userPrompt;
          }
          ariaAnnouncement.value = `${classification.title}: ${classification.message}`;
        },
      },
    });

    if (assistantEntry.status === "streaming") {
      // Stream ended without an explicit terminal event (e.g. connection drop).
      assistantEntry.status = assistantEntry.content.length > 0 ? "done" : "failed";
    }

    // A new session may have been created server-side; refresh the session list.
    if (activeSessionId.value) {
      void loadSessions(true);
    }
  } catch (error) {
    const classified = classifyGatewayError(error);
    assistantEntry.status = "failed";
    assistantEntry.errorTitle = classified.title;
    assistantEntry.errorMessage = classified.message;
    if (classified.requestId) {
      assistantEntry.requestId = classified.requestId;
    }
    assistantEntry.retryable = classified.retryable;
    if (classified.retryable) {
      lastFailedPrompt.value = userPrompt;
    }
    ariaAnnouncement.value = `${classified.title}: ${classified.message}`;
  } finally {
    isSubmitting.value = false;
    currentAbort.value = null;
  }
}

function stopGeneration(): void {
  if (!currentAbort.value) return;
  currentAbort.value.abort("cancelled_by_user");
}

function retryLastFailure(): void {
  if (!lastFailedPrompt.value || isSubmitting.value) return;
  prompt.value = lastFailedPrompt.value;
  void sendMessage();
}

// ---- Init ----

onMounted(() => {
  hasGatewayCredential.value = api.hasGatewayCredential();
  void loadSessions(true);
  void loadModels();
});
</script>
