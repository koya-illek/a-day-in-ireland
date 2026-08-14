import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useRef,
  useState
} from "react";

export type MapView = { scale: number; x: number; y: number };

export const constrainMapView = (scale: number, x: number, y: number): MapView => {
  const nextScale = Math.min(4, Math.max(1, scale));
  return {
    scale: nextScale,
    x: Math.min(0, Math.max(1000 * (1 - nextScale), x)),
    y: Math.min(0, Math.max(900 * (1 - nextScale), y))
  };
};

export function useMapGestures(mapRef: RefObject<SVGSVGElement | null>) {
  const [mapView, setMapView] = useState<MapView>({ scale: 1, x: 0, y: 0 });
  const mapPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const mapGestureRef = useRef<{ center: { x: number; y: number }; distance: number } | null>(null);
  const mapPointerOriginRef = useRef<{ x: number; y: number } | null>(null);
  const mapDidPanRef = useRef(false);

  const zoomMapAround = useCallback((factor: number, point = { x: 500, y: 450 }) => {
    setMapView((current) => {
      const scale = Math.min(4, Math.max(1, current.scale * factor));
      const ratio = scale / current.scale;
      return constrainMapView(
        scale,
        point.x - (point.x - current.x) * ratio,
        point.y - (point.y - current.y) * ratio
      );
    });
  }, []);

  const mapPointFromClient = useCallback((clientX: number, clientY: number) => {
    const bounds = mapRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 500, y: 450 };
    return {
      x: (clientX - bounds.left) * 1000 / bounds.width,
      y: (clientY - bounds.top) * 900 / bounds.height
    };
  }, [mapRef]);

  const mapGesture = useCallback(() => {
    const points = [...mapPointersRef.current.values()];
    if (!points.length) return null;
    const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    center.x /= points.length;
    return {
      center,
      distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0
    };
  }, []);

  const handleMapPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    mapDidPanRef.current = false;
    const startedOnMarker = Boolean((event.target as Element).closest("[data-marker-pointer-target]"));
    const point = mapPointFromClient(event.clientX, event.clientY);
    mapPointersRef.current.set(event.pointerId, point);
    if (!startedOnMarker) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic accessibility tests do not create an active browser pointer.
      }
    }
    mapGestureRef.current = mapGesture();
    mapPointerOriginRef.current = point;
  }, [mapGesture, mapPointFromClient]);

  const handleMapPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!mapPointersRef.current.has(event.pointerId)) return;
    const point = mapPointFromClient(event.clientX, event.clientY);
    mapPointersRef.current.set(event.pointerId, point);
    const previous = mapGestureRef.current;
    const next = mapGesture();
    if (!previous || !next) return;
    if (mapPointerOriginRef.current &&
      Math.hypot(point.x - mapPointerOriginRef.current.x, point.y - mapPointerOriginRef.current.y) > 3) {
      mapDidPanRef.current = true;
    }
    setMapView((current) => {
      if (mapPointersRef.current.size > 1 && previous.distance > 0 && next.distance > 0) {
        const scale = Math.min(4, Math.max(1, current.scale * next.distance / previous.distance));
        return constrainMapView(
          scale,
          next.center.x - (previous.center.x - current.x) * scale / current.scale,
          next.center.y - (previous.center.y - current.y) * scale / current.scale
        );
      }
      return constrainMapView(
        current.scale,
        current.x + next.center.x - previous.center.x,
        current.y + next.center.y - previous.center.y
      );
    });
    mapGestureRef.current = next;
  }, [mapGesture, mapPointFromClient]);

  const handleMapPointerEnd = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    mapPointersRef.current.delete(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    mapGestureRef.current = mapGesture();
    if (!mapPointersRef.current.size) mapPointerOriginRef.current = null;
  }, [mapGesture]);

  const handleMapWheel = useCallback((event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoomMapAround(event.deltaY < 0 ? 1.22 : 1 / 1.22, mapPointFromClient(event.clientX, event.clientY));
  }, [mapPointFromClient, zoomMapAround]);

  const suppressClickAfterPan = useCallback((event: ReactMouseEvent<SVGSVGElement>) => {
    if (!mapDidPanRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    mapDidPanRef.current = false;
  }, []);

  return {
    mapView,
    setMapView,
    zoomMapAround,
    handleMapPointerDown,
    handleMapPointerMove,
    handleMapPointerEnd,
    handleMapWheel,
    suppressClickAfterPan
  };
}
