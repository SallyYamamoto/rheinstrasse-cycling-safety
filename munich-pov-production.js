/* POV, 35 m opposite-category traffic, occlusion frames and map radar.
 * Call installMunichPov(viewer, mobilityEntities, sceneStart) after creating
 * the mobility entities. getTargets() exposes the shared radar/frame snapshot.
 */
(function () {
  "use strict";

  window.installMunichPov = function (viewer, mobilityEntities, sceneStart) {
    const camera = viewer.camera;
    const controller = viewer.scene.screenSpaceCameraController;
    const leftClick = Cesium.ScreenSpaceEventType.LEFT_CLICK;
    const previousClick = viewer.screenSpaceEventHandler.getInputAction(leftClick);
    const hint = document.createElement("div");
    hint.textContent = "◉ POV mode · ← → Look around · Esc to exit";
    Object.assign(hint.style, {
      position: "absolute", left: "50%", bottom: "100px",
      transform: "translateX(-50%)", zIndex: "30",
      background: "rgba(0, 0, 0, .7)", color: "white",
      border: "0", borderRadius: "4px", padding: "15px 24px",
      font: "600 18px Arial, sans-serif", pointerEvents: "none",
      textAlign: "center", maxWidth: "calc(100vw - 24px)"
    });
    hint.hidden = true;
    document.body.appendChild(hint);

    let active = null;
    let savedView = null;
    let savedInputs = true;
    let savedFov = null;
    const povFov = Cesium.Math.toRadians(85);
    let lookOffset = 0;
    let hintTimer = null;
    const stateListeners = new Set();
    function notifyState(isActive) {
      for (const listener of stateListeners) listener(isActive);
    }
    // Time constant in seconds: larger values make the POV turn more slowly.
    const headingSmoothingSeconds = 0.8;
    let smoothedHeading = null;
    let previousTime = null;
    // Explicit pairs keep future traffic categories (e.g. buses) out of this
    // comparison until their intended relationship is specified.
    const oppositeCategory = new Map([[1, 3], [3, 1]]);
    const targetRadius = 35;
    let radarEnabled = true;
    let occlusionEnabled = true;
    let checkScheduling = "spread";
    const frames = new Map();
    const visibilityCache = new Map();
    let lastVisibilityCheck = 0;
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute", inset: "0", zIndex: "20", pointerEvents: "none",
      overflow: "hidden"
    });
    if (getComputedStyle(viewer.container).position === "static") {
      viewer.container.style.position = "relative";
    }
    viewer.container.appendChild(overlay);
    let targetSnapshot = { time: null, targets: [] };

    // A separate lightweight 2D viewer reuses the main viewer's base imagery.
    // Only the map belongs to Cesium; markers use the same targetSnapshot as
    // the screen-space frames, so both displays refer to one simulation time.
    const radar = document.createElement("div");
    radar.setAttribute("aria-label", "Radar: 35 m, north up");
    Object.assign(radar.style, {
      position: "absolute", top: "16px", right: "16px",
      width: "228px", height: "228px", boxSizing: "border-box",
      border: "1px solid rgba(255,255,255,.75)", borderRadius: "12px",
      overflow: "hidden", background: "#26343c", zIndex: "25",
      pointerEvents: "auto", display: "none",
      boxShadow: "0 3px 16px rgba(0,0,0,.35)"
    });
    const radarMap = document.createElement("div");
    Object.assign(radarMap.style, {
      position: "absolute", inset: "4px", overflow: "hidden",
      background: "#26343c"
    });
    const radarSymbols = document.createElement("div");
    Object.assign(radarSymbols.style, {
      position: "absolute", inset: "4px", pointerEvents: "none",
      overflow: "hidden"
    });
    const rangeRing = document.createElement("div");
    Object.assign(rangeRing.style, {
      position: "absolute", left: "50%", top: "50%",
      transform: "translate(-50%, -50%)", boxSizing: "border-box",
      border: "1px dashed rgba(255,255,255,.88)", borderRadius: "50%"
    });
    radarSymbols.appendChild(rangeRing);
    const centerMarker = document.createElement("div");
    centerMarker.textContent = "▲";
    Object.assign(centerMarker.style, {
      position: "absolute", left: "50%", top: "50%",
      color: "white", font: "18px Arial, sans-serif",
      textShadow: "0 1px 4px black", zIndex: "2"
    });
    radarSymbols.appendChild(centerMarker);
    const northLabel = document.createElement("div");
    northLabel.textContent = "N · 35 m";
    Object.assign(northLabel.style, {
      position: "absolute", top: "7px", left: "50%",
      transform: "translateX(-50%)", padding: "2px 6px",
      borderRadius: "4px", background: "rgba(20,29,35,.82)",
      color: "white", font: "bold 11px Arial, sans-serif",
      whiteSpace: "nowrap", pointerEvents: "none"
    });
    radar.append(radarMap, radarSymbols, northLabel);
    viewer.container.appendChild(radar);
    const radarMarkers = new Map();
    let radarViewer = null;
    let radarProvider = null;
    let waitingForBaseLayer = null;

    function clearRadarMarkers() {
      for (const marker of radarMarkers.values()) marker.remove();
      radarMarkers.clear();
    }

    function syncRadarBaseLayer() {
      const baseLayer = viewer.imageryLayers.get(0);
      if (!baseLayer) return false;
      const provider = baseLayer.imageryProvider;
      if (!provider) {
        if (waitingForBaseLayer !== baseLayer) {
          waitingForBaseLayer = baseLayer;
          baseLayer.readyEvent.addEventListener(() => {
            if (active && radar.style.display !== "none") {
              syncRadarBaseLayer();
            }
          });
        }
        return false;
      }
      if (!radarViewer) {
        try {
          radarViewer = new Cesium.Viewer(radarMap, {
            sceneMode: Cesium.SceneMode.SCENE2D,
            baseLayerPicker: false,
            baseLayer: new Cesium.ImageryLayer(provider),
            animation: false, timeline: false,
            geocoder: false, homeButton: false,
            sceneModePicker: false, navigationHelpButton: false,
            fullscreenButton: false, infoBox: false,
            selectionIndicator: false
          });
          radarViewer.scene.screenSpaceCameraController.enableInputs = false;
          radarViewer.clock.shouldAnimate = false;
          radarViewer.scene.requestRenderMode = true;
          radarViewer.scene.maximumRenderTimeChange = Infinity;
          radarProvider = provider;
        } catch (error) {
          console.warn("Radar map could not be initialized:", error);
          radarViewer = null;
          return false;
        }
      } else if (radarProvider !== provider) {
        radarViewer.imageryLayers.removeAll();
        radarViewer.imageryLayers.add(new Cesium.ImageryLayer(provider));
        radarProvider = provider;
      }
      return true;
    }

    function radarMarkerFor(id) {
      if (radarMarkers.has(id)) return radarMarkers.get(id);
      const marker = document.createElement("div");
      Object.assign(marker.style, {
        position: "absolute", width: "9px", height: "9px",
        boxSizing: "border-box", transform: "translate(-50%, -50%)",
        border: "1px solid white", borderRadius: "50%",
        boxShadow: "0 1px 4px rgba(0,0,0,.8)"
      });
      radarSymbols.appendChild(marker);
      radarMarkers.set(id, marker);
      return marker;
    }

    function setDiagnostics(settings) {
      if (["spread", "batch"].includes(settings.scheduling) && settings.scheduling !== checkScheduling) {
        checkScheduling = settings.scheduling;
        visibilityCache.clear();
        lastVisibilityCheck = 0;
      }
      if (typeof settings.radar === "boolean") radarEnabled = settings.radar;
      if (typeof settings.occlusion === "boolean" && settings.occlusion !== occlusionEnabled) {
        occlusionEnabled = settings.occlusion;
        visibilityCache.clear();
        lastVisibilityCheck = 0;
      }
      if (!radarEnabled) radar.style.display = "none";
      // Stop the second Cesium render loop, not just its HTML container.
      if (radarViewer) radarViewer.useDefaultRenderLoop = radarEnabled && !!active;
      viewer.scene.requestRender();
      return { radar: radarEnabled, occlusion: occlusionEnabled, scheduling: checkScheduling };
    }

    function updateRadar(selected, snapshot) {
      if (!radarEnabled) return;
      radar.style.display = "block";
      const width = radarMap.clientWidth;
      const height = radarMap.clientHeight;
      if (!width || !height) return;
      const radiusPixels = Math.min(width, height) / 2 - 12;
      const pixelsPerMeter = radiusPixels / targetRadius;
      rangeRing.style.width = `${radiusPixels * 2}px`;
      rangeRing.style.height = `${radiusPixels * 2}px`;
      centerMarker.style.transform =
        `translate(-50%, -50%) rotate(${smoothedHeading || 0}rad)`;

      const origin = Cesium.Cartographic.fromCartesian(selected);
      if (syncRadarBaseLayer()) {
        if (!radarViewer.useDefaultRenderLoop) {
          radarViewer.useDefaultRenderLoop = true;
          radarViewer.resize();
        }
        // A rectangle centered on the vehicle keeps the imagery north-up.
        // Match its physical extent to the ring's 35 m pixel radius.
        const halfEast = width / 2 / pixelsPerMeter;
        const halfNorth = height / 2 / pixelsPerMeter;
        const earthRadius = Cesium.Ellipsoid.WGS84.maximumRadius;
        const dLon = halfEast / (earthRadius * Math.cos(origin.latitude));
        const dLat = halfNorth / earthRadius;
        radarViewer.camera.setView({
          destination: new Cesium.Rectangle(
            origin.longitude - dLon, origin.latitude - dLat,
            origin.longitude + dLon, origin.latitude + dLat
          )
        });
        radarViewer.scene.requestRender();
      }

      const seen = new Set();
      for (const target of snapshot.targets) {
        const marker = radarMarkerFor(target.entity.id);
        marker.style.left = `${width / 2 + target.east * pixelsPerMeter}px`;
        marker.style.top = `${height / 2 - target.north * pixelsPerMeter}px`;
        marker.style.background = target.visibility === "visible" ? "#41e481"
          : target.visibility === "blocked" ? "#f05252" : "#9ca3af";
        seen.add(target.entity.id);
      }
      for (const [id, marker] of radarMarkers) {
        if (!seen.has(id)) {
          marker.remove();
          radarMarkers.delete(id);
        }
      }
    }

    function clearFrames() {
      for (const frame of frames.values()) frame.remove();
      frames.clear();
      visibilityCache.clear();
      lastVisibilityCheck = 0;
      targetSnapshot = { time: null, targets: [] };
      radar.style.display = "none";
      clearRadarMarkers();
    }

    function frameFor(id) {
      if (frames.has(id)) return frames.get(id);
      const frame = document.createElement("div");
      Object.assign(frame.style, {
        position: "absolute", boxSizing: "border-box",
        border: "2px solid #9ca3af", borderRadius: "2px",
        background: "transparent", transform: "translate(-50%, -50%)",
        pointerEvents: "none", boxShadow: "0 0 2px rgba(0, 0, 0, .65)"
      });
      overlay.appendChild(frame);
      frames.set(id, frame);
      return frame;
    }

    function visibilityAt(point, pixel, targetEntity) {
      const scene = viewer.scene;
      if (!occlusionEnabled) return "unknown";
      if (!scene.pickPositionSupported) return "unknown";
      try {
        const surface = scene.pickPosition(pixel);
        if (!surface) return "unknown";
        const picked = scene.pick(pixel);
        if (picked && picked.id === targetEntity) return "visible";
        const targetDistance = Cesium.Cartesian3.distance(camera.positionWC, point);
        const surfaceDistance = Cesium.Cartesian3.distance(camera.positionWC, surface);
        // A surface substantially nearer than the center of the vehicle
        // blocks that sightline. Ignore minor depth differences on its body.
        if (surfaceDistance < targetDistance - 0.8) return "blocked";
        return "visible";
      } catch (error) {
        return "unknown";
      }
    }

    // Use current-frame screen positions. Only the colour result is cached.
    // Spread mode selects the oldest due target so every visible target gets a turn.
    function refreshTargetVisibility(targets, wallNow) {
      const candidates = targets.filter(target => target.onScreen);
      if (occlusionEnabled) {
        let checks = [];
        if (checkScheduling === "spread") {
          let oldest = null, oldestTime = Infinity;
          for (const target of candidates) {
            const cached = visibilityCache.get(target.entity.id);
            const checkedAt = cached ? cached.checkedAt : -Infinity;
            if (wallNow - checkedAt >= 120 && (oldest === null || checkedAt < oldestTime)) {
              oldest = target; oldestTime = checkedAt;
            }
          }
          if (oldest) checks.push(oldest);
        } else {
          const refresh = wallNow - lastVisibilityCheck >= 120;
          checks = candidates.filter(target => refresh || !visibilityCache.has(target.entity.id));
          if (refresh) lastVisibilityCheck = wallNow;
        }
        for (const target of checks) {
          const visibility = visibilityAt(target.center, target.screenPosition, target.entity);
          visibilityCache.set(target.entity.id, { visibility, checkedAt: wallNow });
        }
      }
      for (const target of targets) {
        const cached = visibilityCache.get(target.entity.id);
        target.visibility = occlusionEnabled && target.onScreen && cached
          ? cached.visibility : "unknown";
      }
    }

    function updateFrames() {
      if (!active) return;
      const now = viewer.clock.currentTime;
      if (!active.entity.isAvailable(now)) {
        clearFrames();
        return;
      }
      const selected = active.entity.position.getValue(now);
      if (!selected) {
        clearFrames();
        return;
      }
      const category = oppositeCategory.get(active.category);
      const inverse = Cesium.Matrix4.inverseTransformation(
        Cesium.Transforms.eastNorthUpToFixedFrame(selected), new Cesium.Matrix4()
      );
      const canvas = viewer.scene.canvas;
      const seen = new Set();
      const targets = [];
      const wallNow = performance.now();

      if (category !== undefined) for (const entry of mobilityEntities.values()) {
        if (entry.category !== category || !entry.entity.isAvailable(now) ||
            entry.entity.show === false) continue;
        const position = entry.entity.position.getValue(now);
        if (!position) continue;
        const local = Cesium.Matrix4.multiplyByPoint(inverse, position, new Cesium.Cartesian3());
        const distance = Math.hypot(local.x, local.y); // horizontal ENU distance
        if (distance > targetRadius) continue;

        const ground = Cesium.Cartographic.fromCartesian(position);
        const vehicleHeight = entry.segment[0][7];
        const centerHeight = Number.isFinite(vehicleHeight)
          ? Math.max(0.5, Math.min(1.4, vehicleHeight * 0.55)) : 0.9;
        const center = Cesium.Cartesian3.fromRadians(
          ground.longitude, ground.latitude,
          ground.height - entry.bottomOffset * entry.scale + centerHeight
        );
        const toCenter = Cesium.Cartesian3.subtract(
          center, camera.positionWC, new Cesium.Cartesian3()
        );
        let visibility = "unknown";
        let onScreen = false;
        let screen = null;
        if (Cesium.Cartesian3.dot(toCenter, camera.directionWC) > 0) {
          screen = viewer.scene.cartesianToCanvasCoordinates(center);
        }
        if (screen && Number.isFinite(screen.x) && Number.isFinite(screen.y) &&
            screen.x >= 0 && screen.x < canvas.clientWidth &&
            screen.y >= 0 && screen.y < canvas.clientHeight) {
          onScreen = true;
          const frame = frameFor(entry.entity.id);
          const size = Math.max(24, Math.min(104, 480 / Math.max(3, distance)));
          frame.style.left = `${screen.x}px`;
          frame.style.top = `${screen.y}px`;
          frame.style.width = `${size}px`;
          frame.style.height = `${size}px`;
          // Apply colours below, after the shared visibility snapshot is updated.
          seen.add(entry.entity.id);
        }
        targets.push({ entity: entry.entity, position, distance,
          east: local.x, north: local.y, visibility,
          screenPosition: screen, center, onScreen });
      }
      for (const [id, frame] of frames) {
        if (!seen.has(id)) {
          frame.remove();
          frames.delete(id);
          visibilityCache.delete(id);
        }
      }
      refreshTargetVisibility(targets, wallNow);
      for (const target of targets) {
        if (!target.onScreen) continue;
        const frame = frames.get(target.entity.id);
        frame.style.borderColor = target.visibility === "visible" ? "#41e481"
          : target.visibility === "blocked" ? "#f05252" : "#9ca3af";
      }
      targetSnapshot = { time: Cesium.JulianDate.clone(now), targets };
      updateRadar(selected, targetSnapshot);
    }

    function showHint() {
      if (typeof window.showMunichHint === "function") {
        window.showMunichHint("◉ POV mode", "← → Look around · Esc to exit", 2200);
        return;
      }
      clearTimeout(hintTimer);
      hint.hidden = false;
      hintTimer = setTimeout(() => { hint.hidden = true; }, 2000);
    }

    // The source samples are sorted by t; nearest sample avoids interpolating
    // across the -pi / +pi boundary in rotationZ.
    function nearestSample(segment, seconds) {
      let low = 0;
      let high = segment.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (segment[middle][0] <= seconds) low = middle;
        else high = middle - 1;
      }
      if (low + 1 < segment.length &&
          seconds - segment[low][0] > segment[low + 1][0] - seconds) {
        return segment[low + 1];
      }
      return segment[low];
    }

    function stop() {
      if (!active) return;
      active.entity.show = active.originalShow;
      active = null;
      lookOffset = 0;
      smoothedHeading = null;
      previousTime = null;
      clearFrames();
      clearTimeout(hintTimer);
      hint.hidden = true;
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      if (savedFov !== null && camera.frustum instanceof Cesium.PerspectiveFrustum) {
        camera.frustum.fov = savedFov;
      }
      savedFov = null;
      if (savedView) {
        camera.setView({
          destination: savedView.position,
          orientation: { direction: savedView.direction, up: savedView.up }
        });
      }
      savedView = null;
      controller.enableInputs = savedInputs;
      notifyState(false);
    }

    function update() {
      if (!active) return;
      const now = viewer.clock.currentTime;
      if (!active.entity.isAvailable(now)) {
        stop();
        return;
      }

      const position = active.entity.position.getValue(now);
      if (!position) {
        stop();
        return;
      }

      const seconds = Cesium.JulianDate.secondsDifference(now, sceneStart);
      const sample = nearestSample(active.segment, seconds);
      const cartographic = Cesium.Cartographic.fromCartesian(position);
      // The entity's Z includes the GLB's bottom offset. Recover road height
      // before adding eye height, so the camera stays above the Munich road.
      const roadHeight = cartographic.height - active.bottomOffset * active.scale;
      const eyeHeight = active.category === 3 ? 1.6 : 1.2;
      const eye = Cesium.Cartesian3.fromRadians(
        cartographic.longitude, cartographic.latitude, roadHeight + eyeHeight
      );
      // TUM DOT rotationZ is counterclockwise from east; Cesium heading is
      // clockwise from north. The GLB headingOffset must not affect the view.
      const rawHeading = Cesium.Math.PI_OVER_TWO - sample[4];
      const dt = previousTime === null ? 0 : seconds - previousTime;
      // Reset after a seek or time jump; otherwise follow the shortest arc
      // across the 0/360 degree boundary with a gentle low-pass filter.
      if (smoothedHeading === null || dt < 0 || dt > 0.5) {
        smoothedHeading = rawHeading;
      } else if (dt > 0) {
        const difference = Math.atan2(
          Math.sin(rawHeading - smoothedHeading),
          Math.cos(rawHeading - smoothedHeading)
        );
        const weight = 1 - Math.exp(-dt / headingSmoothingSeconds);
        smoothedHeading += weight * difference;
      }
      previousTime = seconds;
      const heading = smoothedHeading + lookOffset;
      camera.setView({
        destination: eye,
        orientation: { heading, pitch: 0, roll: 0 }
      });
    }

    viewer.screenSpaceEventHandler.setInputAction(event => {
      // Intersection circles can cover vehicles on screen. Pick through the
      // translucent circle so clicking a visible vehicle still enters POV.
      const entry = viewer.scene.drillPick(event.position, 12)
        .map(hit => hit.id instanceof Cesium.Entity && mobilityEntities.get(hit.id.id))
        .find(candidate => candidate && candidate.entity.show === true);
      if (!entry) {
        if (previousClick) previousClick(event);
        return;
      }

      // Keep the pre-POV view even if the user switches vehicles in POV mode.
      if (!active) {
        savedView = {
          position: Cesium.Cartesian3.clone(camera.positionWC),
          direction: Cesium.Cartesian3.clone(camera.directionWC),
          up: Cesium.Cartesian3.clone(camera.upWC)
        };
        savedInputs = controller.enableInputs;
        if (camera.frustum instanceof Cesium.PerspectiveFrustum) {
          savedFov = camera.frustum.fov;
          camera.frustum.fov = povFov;
        }
      } else {
        active.entity.show = active.originalShow;
      }
      camera.cancelFlight();
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      controller.enableInputs = false;
      active = { ...entry, originalShow: entry.entity.show };
      active.entity.show = false; // Keep the camera out of the vehicle shell.
      notifyState(true);
      lookOffset = 0;
      smoothedHeading = null;
      previousTime = null;
      clearFrames();
      viewer.selectedEntity = undefined;
      showHint();
      update();
    }, leftClick);

    window.addEventListener("keydown", event => {
      if (!active) return;
      if (event.key === "Escape") {
        event.preventDefault();
        stop();
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement &&
          (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = Cesium.Math.toRadians(5);
        lookOffset = Cesium.Math.clamp(
          lookOffset + (event.key === "ArrowRight" ? step : -step),
          -Cesium.Math.PI_OVER_TWO, Cesium.Math.PI_OVER_TWO
        );
        update();
      }
    });

    viewer.clock.onTick.addEventListener(update);
    viewer.scene.postRender.addEventListener(updateFrames);
    return {
      stop,
      isActive: () => active !== null,
      onChange(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      setDiagnostics,
      getDiagnostics: () => ({ radar: radarEnabled, occlusion: occlusionEnabled, scheduling: checkScheduling }),
      getTargets: () => targetSnapshot
    };
  };
}());
