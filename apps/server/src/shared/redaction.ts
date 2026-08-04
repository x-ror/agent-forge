import type { Json } from '@agentforge/core';

/**
 * Scrubs known secret values from event payloads before they are persisted
 * (§8/§12): the agent may echo env values into stdout/messages; the log must
 * never contain them.
 */
export function redactSecrets(payload: Json, secretValues: string[]): Json {
  const meaningful = secretValues.filter((value) => value.length >= 6);
  if (meaningful.length === 0) return payload;
  let text = JSON.stringify(payload);
  for (const value of meaningful) {
    // JSON.stringify the secret to match its escaped form inside the payload.
    const escaped = JSON.stringify(value).slice(1, -1);
    text = text.split(escaped).join('[REDACTED]');
  }
  return JSON.parse(text) as Json;
}
