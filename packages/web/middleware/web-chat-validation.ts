/**
 * Production Web AI Chat enablement middleware.
 *
 * Replaces the legacy `webChatValidationEnabled` toggle: the web chat surface
 * now drives the production `/api/ai-chat/*` capability exclusively. When the
 * production chat enablement flag is off, the chat route redirects to the
 * dashboard so no separate quick-validation operational mode remains active.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { public: publicConfig } = useRuntimeConfig();

  if (to.path === "/chat" && publicConfig.webAiChatEnabled === false) {
    return navigateTo("/");
  }
});
