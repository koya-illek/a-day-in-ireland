import type { TransitVehicle } from "./types";

export function warningDescriptionText(value: unknown): string;
export function humaniseWarningRegions(regions: readonly string[] | null | undefined): string;
export function publicRouteFromNtaRouteId(value: unknown): string;

export function transitPresentation(item: TransitVehicle): {
  route: string;
  title: string;
  direction: string;
  destination: string;
  label: string | null;
};
