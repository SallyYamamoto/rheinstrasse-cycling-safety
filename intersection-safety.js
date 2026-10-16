/* Select one hypothetical car–bicycle conflict from a map arrow. */
(function () {
  "use strict";

  window.installConflictMode = async function (viewer, options) {
    const { correction, models, mobilityEntities, sceneStart, sceneEnd,
      pov, setPlayback, roadSamples, onAreaSelected, onModeChanged, showHint } = options;
    const [scenarioResponse, areaResponse] = await Promise.all([
      fetch("./ArcGIS_conflict_trajectories/conflict_scenarios.json"),
      fetch("./GeoJSON/Target_intersections.geojson")
    ]);
    if (!scenarioResponse.ok || !areaResponse.ok) {
      throw new Error(`Scenarios ${scenarioResponse.status}, intersections ${areaResponse.status}`);
    }
    const scenarioData = await scenarioResponse.json();
    const areaData = await areaResponse.json();
    if (scenarioData.format !== "conflict-scenarios-v1" ||
        !Array.isArray(scenarioData.scenarios) || !Array.isArray(areaData.features)) {
      throw new Error("Unexpected GeoJSON or scenario format");
    }

    const controls = document.getElementById("modeControls");
    const realButton = document.getElementById("modeReal");
    const virtualButton = document.getElementById("modeScenario");
    const status = document.getElementById("modeStatus");
    const playbackControls = document.getElementById("playbackControls");
    const observedInfo = document.getElementById("observedInfo");

    const measuredEntries = Array.from(mobilityEntities.values());
    const scenarios = new Map();
    const intersections = [];
    const selectors = new Map();
    let mode = "real";
    let selectedArea = null;
    let playing = null;
    let resumeRealTime = Cesium.JulianDate.clone(viewer.clock.currentTime);
    let resumeRealPlayback = viewer.clock.shouldAnimate;

    const parseIds = value => (String(value ?? "").match(/\d+/g) || []).map(Number);
    const rotationZ = sample =>
      Cesium.Math.PI_OVER_TWO - Cesium.Math.toRadians(sample.headingDeg);

    // A screen-space offset separates nearby trajectory midpoints.
    function arrowImage(isRight) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = isRight ? "#55c5ff" : "#ffbc62";
      ctx.beginPath();
      ctx.arc(32, 32, 27, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#19303e";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (isRight) {
        ctx.moveTo(19, 46); ctx.lineTo(19, 30); ctx.quadraticCurveTo(19, 20, 29, 20);
        ctx.lineTo(44, 20); ctx.moveTo(35, 12); ctx.lineTo(44, 20); ctx.lineTo(35, 28);
      } else {
        ctx.moveTo(45, 46); ctx.lineTo(45, 30); ctx.quadraticCurveTo(45, 20, 35, 20);
        ctx.lineTo(20, 20); ctx.moveTo(29, 12); ctx.lineTo(20, 20); ctx.lineTo(29, 28);
      }
      ctx.stroke();
      return canvas;
    }
    const arrowRight = arrowImage(true);
    const arrowLeft = arrowImage(false);

    function createActor(scenario, role) {
      const info = scenario[role];
      const model = models[info.category];
      if (!model || !Array.isArray(info.samples) || info.samples.length < 2) {
        throw new Error(`Invalid scenario ${scenario.id}: ${role}`);
      }
      const position = new Cesium.SampledPositionProperty();
      const orientation = new Cesium.SampledProperty(Cesium.Quaternion);
      const times = [];
      const locations = [];
      const rotations = [];
      const length = model.length;
      const width = role === "car" ? 1.85 : 0.7;
      const height = role === "car" ? 1.55 : 1.7;
      const segment = [];
      for (const sample of info.samples) {
        const t = Cesium.JulianDate.addSeconds(sceneStart, sample.t, new Cesium.JulianDate());
        const point = Cesium.Cartesian3.fromDegrees(sample.lon, sample.lat,
          sample.roadZ + correction + model.bottomOffset);
        const yaw = rotationZ(sample);
        times.push(t);
        locations.push(point);
        rotations.push(Cesium.Transforms.headingPitchRollQuaternion(point,
          new Cesium.HeadingPitchRoll(-yaw + model.headingOffset, 0, 0)));
        // The installed POV module expects the original Munich sample layout.
        segment.push([sample.t, sample.lon, sample.lat, sample.roadZ,
          yaw, length, width, height]);
      }
      position.addSamples(times, locations);
      orientation.addSamples(times, rotations);
      const entity = viewer.entities.add({
        id: `hypothetical-${scenario.id}-${role}`,
        name: `${role === "car" ? "Car" : "Cyclist"} · simulated scenario`,
        show: false,
        availability: new Cesium.TimeIntervalCollection([
          new Cesium.TimeInterval({ start: times[0], stop: times.at(-1) })
        ]),
        position, orientation,
        properties: { trackId: scenario.id, category: info.category },
        model: { uri: model.uri, scale: 1, minimumPixelSize: 0,
          heightReference: Cesium.HeightReference.NONE }
      });
      mobilityEntities.set(entity.id, { entity, segment, category: info.category,
        scale: 1, bottomOffset: model.bottomOffset });
      return entity;
    }

    for (const item of scenarioData.scenarios) {
      if (!Array.isArray(item.conflictPoint) || !(item.duration > 0)) continue;
      scenarios.set(item.id, { data: item, car: createActor(item, "car"),
        bike: createActor(item, "bike") });
    }

    function inRing(point, ring) {
      let inside = false;
      const [x, y] = point;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) &&
            x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }

    function insidePolygon(point, geometry) {
      const polygons = geometry.type === "MultiPolygon"
        ? geometry.coordinates : [geometry.coordinates];
      return polygons.some(rings => inRing(point, rings[0]) &&
        rings.slice(1).every(hole => !inRing(point, hole)));
    }

    function nearestRoadHeight(lon, lat) {
      let sample = null;
      let closest = Infinity;
      for (const candidate of roadSamples) {
        const dist2 = (candidate.lon - lon) ** 2 * 0.44 + (candidate.lat - lat) ** 2;
        if (dist2 < closest) { closest = dist2; sample = candidate; }
      }
      return sample.height;
    }

    for (const feature of areaData.features) {
      const geometry = feature.geometry;
      if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) continue;
      const ring = geometry.type === "Polygon"
        ? geometry.coordinates[0] : geometry.coordinates[0][0];
      const center = ring.reduce((acc, point) =>
        [acc[0] + point[0], acc[1] + point[1]], [0, 0])
        .map(n => n / ring.length);
      const within = [...scenarios.values()].filter(item =>
        insidePolygon(item.data.conflictPoint, geometry));
      // Use the same CityGML-to-terrain height correction as the main viewer.
      // The GeoJSON's z=0 denotes a 2D buffer and is deliberately ignored.
      // Keep the circle above the highest conflict point in the intersection.
      const z = Math.max(nearestRoadHeight(center[0], center[1]),
        ...within.map(item => item.data.conflictPoint[2])) + correction + 0.24;
      const polygon = viewer.entities.add({
        id: `target-intersection-${feature.properties.OBJECTID}`,
        name: feature.properties.Intersections,
        show: false,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(ring.map(point =>
            Cesium.Cartesian3.fromDegrees(point[0], point[1], z))),
          perPositionHeight: true,
          material: Cesium.Color.fromCssColorString("#4ebdff").withAlpha(0.3),
          outline: false
        }
      });
      const p = feature.properties;
      const hasSecondGroup = !!(p.Left_confpoints2 || p.Righ_confpoints2);
      const secondLeft = new Set(parseIds(p.Left_confpoints2));
      const secondRight = new Set(parseIds(p.Righ_confpoints2));
      const grouped = { left: [], right: [], left2: [], right2: [] };
      // Match the ID, maneuver, and polygon. The second fields split the
      // Leopoldstrasse lanes without duplicating an actor in both groups.
      for (const item of within) {
        const isLeft = item.data.type === "left";
        const mainIds = new Set(parseIds(isLeft ? p.Left_confpoints : p.Righ_confpoints));
        const secondIds = isLeft ? secondLeft : secondRight;
        const second = hasSecondGroup && secondIds.has(item.data.confId);
        if (!second && !mainIds.has(item.data.confId)) continue;
        grouped[`${isLeft ? "left" : "right"}${second ? "2" : ""}`].push(item);
      }
      const area = { polygon, feature, center, grouped, z, markers: [] };
      const entries = Object.entries(grouped).flatMap(([group, values]) =>
        values.map(item => ({ group, item })));
      const clusters = [];
      for (const entry of entries) {
        const samples = entry.item.data.car.samples;
        const midpoint = samples[Math.floor((samples.length - 1) / 2)];
        const cp = [midpoint.lon, midpoint.lat];
        let cluster = clusters.find(c =>
          Math.hypot((cp[0] - c[0][0]) * 74000,
            (cp[1] - c[0][1]) * 111000) < 4);
        if (!cluster) { cluster = [cp]; clusters.push(cluster); }
        cluster.push(entry);
      }
      for (const cluster of clusters) {
        const members = cluster.slice(1);
        members.forEach(({ item }, index) => {
          const samples = item.data.car.samples;
          const midpoint = samples[Math.floor((samples.length - 1) / 2)];
          const angle = -Math.PI / 2 + 2 * Math.PI * index / members.length;
          const radius = members.length === 1 ? 0 : Math.max(25, 6 * members.length);
          const x = Math.round(radius * Math.cos(angle));
          const y = Math.round(radius * Math.sin(angle));
          const isRight = item.data.type === "right";
          const title = isRight ? "Right turn" : "Left turn";
          const entity = viewer.entities.add({
            id: `conflict-selector-${item.data.id}`,
            name: `${title} · car trajectory midpoint`,
            show: false,
            position: Cesium.Cartesian3.fromDegrees(midpoint.lon, midpoint.lat,
              midpoint.roadZ + correction + 1.8),
            billboard: {
              image: isRight ? arrowRight : arrowLeft,
              width: 35, height: 35,
              pixelOffset: new Cesium.Cartesian2(x, y),
              disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label: {
              text: title,
              font: "bold 12px sans-serif",
              fillColor: Cesium.Color.WHITE,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString("#263744").withAlpha(0.85),
              pixelOffset: new Cesium.Cartesian2(x, y + 27),
              disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
          });
          area.markers.push(entity);
          selectors.set(entity.id, { area, item });
        });
      }
      intersections.push(area);
    }

    function showAreas() {
      const inScenarioPov = mode === "scenario" && pov.isActive();
      for (const area of intersections) {
        area.polygon.show = mode === "scenario" && !inScenarioPov;
        const active = area === selectedArea;
        area.polygon.polygon.material = Cesium.Color.fromCssColorString(
          active ? "#ffd26b" : "#4ebdff").withAlpha(active ? 0.48 : 0.3);
        for (const marker of area.markers) {
          marker.show = mode === "scenario" && active && !inScenarioPov;
        }
      }
    }

    // Switch the buffers at the instant POV starts or ends, including on Esc.
    pov.onChange(() => {
      showAreas();
      viewer.scene.requestRender();
    });

    function clearPlaying() {
      pov.stop();
      if (playing) {
        playing.car.show = false;
        playing.bike.show = false;
      }
      playing = null;
      if (mode === "scenario") playbackControls.hidden = true;
    }

    function chooseArea(area) {
      clearPlaying();
      viewer.clock.shouldAnimate = false;
      selectedArea = area;
      viewer.selectedEntity = undefined;
      showAreas();
      if (onAreaSelected) onAreaSelected(area.feature.properties.Intersections);
      status.textContent = area.markers.length
        ? `${area.feature.properties.Intersections} · Select a turning arrow`
        : `${area.feature.properties.Intersections} · No scenario available`;
      if (area.markers.length) {
        showHint?.("↰ ↱ Select a turn arrow to play a scenario", "✦ Click an accident symbol for recorded crash details");
      } else {
        showHint?.("No conflict scenario at this intersection", "✦ Click an accident symbol for recorded crash details");
      }
      const center = Cesium.Cartesian3.fromDegrees(area.center[0],
        area.center[1], area.z);
      // Some car trajectories begin outside the intersection buffer.
      const farthestStart = Math.max(0, ...Object.values(area.grouped).flat().map(item => {
        const start = item.data.car.samples[0];
        return Math.hypot((start.lon - area.center[0]) * 74000,
          (start.lat - area.center[1]) * 111000);
      }));
      viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 1), {
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-68),
          Math.max(100, farthestStart * 2.25)),
        duration: 1
      });
    }

    function playSingle(ref) {
      if (selectedArea !== ref.area) chooseArea(ref.area);
      clearPlaying();
      playing = ref.item;
      playing.car.show = true;
      playing.bike.show = true;
      const stop = Cesium.JulianDate.addSeconds(sceneStart, playing.data.duration,
        new Cesium.JulianDate());
      viewer.clock.startTime = Cesium.JulianDate.clone(sceneStart);
      viewer.clock.stopTime = stop;
      viewer.clock.currentTime = Cesium.JulianDate.clone(sceneStart);
      viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
      viewer.clock.multiplier = 1;
      viewer.clock.shouldAnimate = true;
      setPlayback(sceneStart, stop, true);
      playbackControls.hidden = false;
      status.textContent = `${ref.area.feature.properties.Intersections} · ` +
        `${playing.data.type === "right" ? "Right turn" : "Left turn"} · simulated`;
    }

    function setMode(next) {
      if (next === mode) return;
      clearPlaying();
      viewer.selectedEntity = undefined;
      if (next === "scenario") {
        resumeRealTime = Cesium.JulianDate.clone(viewer.clock.currentTime);
        resumeRealPlayback = viewer.clock.shouldAnimate;
        measuredEntries.forEach(entry => { entry.entity.show = false; });
        mode = next;
        selectedArea = null;
        viewer.clock.shouldAnimate = false;
        status.textContent = "Select an intersection circle";
      } else {
        mode = next;
        selectedArea = null;
        measuredEntries.forEach(entry => { entry.entity.show = true; });
        viewer.clock.startTime = Cesium.JulianDate.clone(sceneStart);
        viewer.clock.stopTime = Cesium.JulianDate.clone(sceneEnd);
        viewer.clock.currentTime = Cesium.JulianDate.clone(resumeRealTime);
        viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
        viewer.clock.multiplier = 1;
        viewer.clock.shouldAnimate = resumeRealPlayback;
        setPlayback(sceneStart, sceneEnd, false);
        status.textContent = "October 2022 · TUMDOT-MUC";
      }
      showAreas();
      playbackControls.hidden = mode === "scenario";
      observedInfo.hidden = mode === "scenario";
      if (onModeChanged) onModeChanged(mode);
      realButton.setAttribute("aria-pressed", String(mode === "real"));
      virtualButton.setAttribute("aria-pressed", String(mode === "scenario"));
    }

    const previousClick = viewer.screenSpaceEventHandler.getInputAction(
      Cesium.ScreenSpaceEventType.LEFT_CLICK);
    viewer.screenSpaceEventHandler.setInputAction(event => {
      if (mode === "scenario") {
        const hits = viewer.scene.drillPick(event.position, 12);
        const vehicle = hits.find(hit =>
          hit.id instanceof Cesium.Entity &&
          mobilityEntities.get(hit.id.id)?.entity.show === true);
        if (!vehicle) {
          const selectedMarker = hits.map(hit =>
            hit.id instanceof Cesium.Entity && selectors.get(hit.id.id))
            .find(Boolean);
          if (selectedMarker) { playSingle(selectedMarker); return; }
          const accident = hits.find(hit => hit.id instanceof Cesium.Entity &&
            String(hit.id.id).startsWith("recorded-accident-"));
          if (accident) {
            viewer.selectedEntity = accident.id;
            return;
          }
          const area = intersections.find(item => hits.some(hit =>
            hit.id instanceof Cesium.Entity && hit.id.id === item.polygon.id));
          if (area) { chooseArea(area); return; }
        }
      }
      if (previousClick) previousClick(event);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    realButton.addEventListener("click", () => setMode("real"));
    virtualButton.addEventListener("click", () => setMode("scenario"));
    controls.hidden = false;
    return { setMode, intersections, scenarios: scenarios.size };
  };
}());
