/**
 * Auth middleware — redirects to /auth if no token is stored.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.client) {
    const token = localStorage.getItem("gateway_auth_token");
    if (!token && to.path !== "/auth") {
      return navigateTo("/auth");
    }
  }
});
