import { DEPLOYX_PREVIOUS_IMAGE_LABEL } from "@deployx/shared";
import type { ContainerInspection } from "./container-manager";

/**
 * Determines the image a new deployment replaces, for the
 * `deployx.previousImage` rollback label.
 *
 * - No outgoing container → null (first deploy, nothing to roll back to)
 * - Outgoing image differs → the outgoing image
 * - Same-image redeploy → carry forward the outgoing container's own label,
 *   so a redeploy doesn't erase the real rollback target
 */
export function resolvePreviousImage(
  outgoing: ContainerInspection | null,
  newImage: string,
): string | null {
  if (!outgoing || !outgoing.image) return null;
  if (outgoing.image !== newImage) return outgoing.image;
  return outgoing.labels[DEPLOYX_PREVIOUS_IMAGE_LABEL] || null;
}

/**
 * Returns a copy of `labels` with the previous-image label set (or omitted
 * when there is no previous image).
 */
export function withPreviousImageLabel(
  labels: Readonly<Record<string, string>>,
  previousImage: string | null,
): Record<string, string> {
  if (!previousImage) return { ...labels };
  return { ...labels, [DEPLOYX_PREVIOUS_IMAGE_LABEL]: previousImage };
}

/**
 * Reads the previous-image label from an inspected container.
 */
export function readPreviousImage(
  inspection: ContainerInspection | null,
): string | null {
  return inspection?.labels[DEPLOYX_PREVIOUS_IMAGE_LABEL] || null;
}
