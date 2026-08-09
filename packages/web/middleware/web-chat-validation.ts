export default defineNuxtRouteMiddleware((to) => {
  const { public: publicConfig } = useRuntimeConfig();

  if (to.path === "/chat" && publicConfig.webChatValidationEnabled === false) {
    return navigateTo("/");
  }
});
