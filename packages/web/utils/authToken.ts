let gatewayAuthToken: string | null = null;

export function getGatewayAuthToken(): string | null {
  return gatewayAuthToken;
}

export function setGatewayAuthToken(token: string): void {
  gatewayAuthToken = token;
}

export function clearGatewayAuthToken(): void {
  gatewayAuthToken = null;
}
