/**
 * Auth middleware — redirects to /auth if no token is present in memory.
 */
import { getGatewayAuthToken } from "~/utils/authToken";

export default defineNuxtRouteMiddleware((to) => {
  if (!getGatewayAuthToken() && to.path !== "/auth") {
    return navigateTo("/auth");
  }
});
